/**
 * Solana Receive-Only Wallet & Real Payment Monitor.
 *
 * - Receive-only address: 3t7xtNf5vyb7XKMFoNXaZJ7yW4dx8L8CN1LjcCLEacER
 * - Tracks real incoming USDC and SOL transfers via standard Solana JSON-RPC.
 * - Public address ONLY. No private keys. No outgoing transaction signing.
 * - On verified incoming payment:
 *     1. Updates double-entry Ledger (DEBIT wallet_solana, CREDIT revenue)
 *     2. Emits structured telemetry event 'payment_received'
 *     3. Optionally updates sender reputation
 * - Graceful failure: if RPC is down, rate-limited, or returns errors, fails safely
 *   without crashing AgentCore.
 */

import { env } from '../config/env.js';
import { createLogger } from '../observability/logger.js';
import type { Ledger } from './ledger.js';
import { globalTelemetry, type TelemetryCollector } from '../telemetry/metrics.js';
import type { ReputationSystem } from './reputation.js';

const log = createLogger('solana-wallet');

export interface IncomingPayment {
  txHash: string;
  from: string;
  to: string;
  amount: number;
  amountUsd: number;
  asset: 'USDC' | 'SOL' | string;
  network: 'solana';
  slot?: number;
  blockTime?: number;
  timestamp: Date;
}

export interface SolanaReceiveWalletOptions {
  rpcUrl?: string;
  receiveAddress?: string;
  usdcMint?: string;
  ledger?: Ledger;
  telemetry?: TelemetryCollector;
  reputationSystem?: ReputationSystem;
  fetchFn?: typeof fetch;
  /** Estimated or cached SOL/USD conversion rate for USD ledger conversion */
  solUsdPrice?: number;
}

export class SolanaReceiveWallet {
  public readonly receiveAddress: string;
  public readonly rpcUrl: string;
  public readonly usdcMint: string;
  private readonly ledger?: Ledger;
  private readonly telemetry: TelemetryCollector;
  private readonly reputationSystem?: ReputationSystem;
  private readonly fetchFn: typeof fetch;
  private solUsdPrice: number;

  private readonly processedSignatures = new Set<string>();
  private lastKnownBalance = { sol: 0, usdc: 0 };

  constructor(options?: SolanaReceiveWalletOptions) {
    this.receiveAddress = options?.receiveAddress ?? env.SOLANA_RECEIVE_ADDRESS;
    this.rpcUrl = options?.rpcUrl ?? env.SOLANA_RPC_URL;
    this.usdcMint = options?.usdcMint ?? env.USDC_MINT;
    this.ledger = options?.ledger;
    this.telemetry = options?.telemetry ?? globalTelemetry;
    this.reputationSystem = options?.reputationSystem;
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.solUsdPrice = options?.solUsdPrice ?? 150; // Reference price for SOL conversion
  }

  public getReceiveAddress(): string {
    return this.receiveAddress;
  }

  public setSolUsdPrice(price: number): void {
    if (price > 0) {
      this.solUsdPrice = price;
    }
  }

  /**
   * Helper to perform standard Solana JSON-RPC requests.
   */
  private async rpcCall<T>(method: string, params: unknown[]): Promise<T | null> {
    try {
      const response = await this.fetchFn(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `sol-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          method,
          params,
        }),
      });

      if (!response.ok) {
        log.warn(
          { status: response.status, method, rpcUrl: this.rpcUrl },
          'solana rpc returned non-ok status',
        );
        return null;
      }

      const json = (await response.json()) as { result?: T; error?: unknown };
      if (json.error) {
        log.warn({ method, error: json.error }, 'solana rpc response error');
        return null;
      }

      return json.result ?? null;
    } catch (err) {
      log.warn({ method, err }, 'solana rpc call failed gracefully');
      return null;
    }
  }

  /**
   * Retrieves on-chain balance for the receive address (SOL and USDC).
   * Graceful fallback to last known balances on network/RPC failure.
   */
  public async getBalance(): Promise<{ sol: number; usdc: number }> {
    try {
      // 1. Query Native SOL balance
      const solResult = await this.rpcCall<{ value: number }>('getBalance', [
        this.receiveAddress,
        { commitment: 'confirmed' },
      ]);

      let solBalance = this.lastKnownBalance.sol;
      if (solResult && typeof solResult.value === 'number') {
        solBalance = solResult.value / 1e9;
      }

      // 2. Query SPL Token Accounts by Owner for USDC Mint
      const tokenResult = await this.rpcCall<{
        value: Array<{
          account: {
            data: {
              parsed: {
                info: {
                  tokenAmount: {
                    uiAmount: number;
                  };
                };
              };
            };
          };
        }>;
      }>('getTokenAccountsByOwner', [
        this.receiveAddress,
        { mint: this.usdcMint },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);

      let usdcBalance = this.lastKnownBalance.usdc;
      if (tokenResult && Array.isArray(tokenResult.value)) {
        usdcBalance = tokenResult.value.reduce((sum, item) => {
          const amt = item?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
          return sum + (typeof amt === 'number' ? amt : 0);
        }, 0);
      }

      this.lastKnownBalance = { sol: solBalance, usdc: usdcBalance };
      return { sol: solBalance, usdc: usdcBalance };
    } catch (err) {
      log.warn({ err }, 'error retrieving solana balance, returning cached value');
      return this.lastKnownBalance;
    }
  }

  /**
   * Checks for verified incoming payments (USDC or SOL) since a given timestamp.
   * On detection:
   *   1. Updates internal Ledger double-entry books (DEBIT wallet_solana, CREDIT revenue)
   *   2. Emits telemetry 'payment_received' event
   *   3. Updates reputation record if sender agent is known
   */
  public async checkIncomingPayments(since?: Date): Promise<IncomingPayment[]> {
    const payments: IncomingPayment[] = [];

    try {
      // Fetch recent transaction signatures for the receive-only address
      const signatures = await this.rpcCall<
        Array<{
          signature: string;
          slot: number;
          blockTime?: number;
          err?: unknown;
        }>
      >('getSignaturesForAddress', [
        this.receiveAddress,
        { limit: 20, commitment: 'confirmed' },
      ]);

      if (!signatures || !Array.isArray(signatures)) {
        return [];
      }

      for (const sigInfo of signatures) {
        if (sigInfo.err) {
          continue; // Skip failed transactions
        }

        const sig = sigInfo.signature;
        if (this.processedSignatures.has(sig)) {
          continue; // Already processed & credited
        }

        // Check timestamp filter if provided
        if (since && sigInfo.blockTime) {
          const txTime = new Date(sigInfo.blockTime * 1000);
          if (txTime < since) {
            continue;
          }
        }

        // Retrieve full parsed transaction details
        const tx = await this.rpcCall<{
          slot: number;
          blockTime?: number;
          transaction?: {
            message?: {
              accountKeys?: Array<{ pubkey: string }>;
              instructions?: Array<{
                program?: string;
                parsed?: {
                  type?: string;
                  info?: Record<string, unknown>;
                };
              }>;
            };
          };
          meta?: {
            err?: unknown;
            preTokenBalances?: Array<{
              accountIndex: number;
              mint: string;
              owner: string;
              uiTokenAmount: { uiAmount: number };
            }>;
            postTokenBalances?: Array<{
              accountIndex: number;
              mint: string;
              owner: string;
              uiTokenAmount: { uiAmount: number };
            }>;
          };
        }>('getTransaction', [
          sig,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        ]);

        if (!tx || tx.meta?.err) {
          continue;
        }

        const blockTimestamp = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();

        // 1. Inspect for SPL Token (USDC) transfers in post/pre token balances
        let detected = false;
        if (tx.meta?.postTokenBalances && tx.meta?.preTokenBalances) {
          for (const post of tx.meta.postTokenBalances) {
            if (post.owner === this.receiveAddress && post.mint === this.usdcMint) {
              const pre = tx.meta.preTokenBalances.find(
                (p) => p.accountIndex === post.accountIndex,
              );
              const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
              const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
              const delta = postAmount - preAmount;

              if (delta > 0) {
                // Incoming USDC payment detected!
                const senderKey =
                  tx.transaction?.message?.accountKeys?.[0]?.pubkey ?? 'unknown-sender';
                const payment: IncomingPayment = {
                  txHash: sig,
                  from: senderKey,
                  to: this.receiveAddress,
                  amount: delta,
                  amountUsd: delta, // USDC is pegged 1:1 to USD
                  asset: 'USDC',
                  network: 'solana',
                  slot: tx.slot,
                  blockTime: tx.blockTime,
                  timestamp: blockTimestamp,
                };

                await this.handlePaymentDetected(payment);
                payments.push(payment);
                this.processedSignatures.add(sig);
                detected = true;
                break;
              }
            }
          }
        }

        // 2. Inspect for Native SOL transfers if no token transfer was found
        if (!detected && tx.transaction?.message?.instructions) {
          for (const inst of tx.transaction.message.instructions) {
            if (inst.program === 'system' && inst.parsed?.type === 'transfer') {
              const info = inst.parsed.info as {
                destination?: string;
                source?: string;
                lamports?: number;
              };
              if (info?.destination === this.receiveAddress && typeof info.lamports === 'number') {
                const solAmount = info.lamports / 1e9;
                if (solAmount > 0) {
                  const payment: IncomingPayment = {
                    txHash: sig,
                    from: info.source ?? 'unknown-sender',
                    to: this.receiveAddress,
                    amount: solAmount,
                    amountUsd: solAmount * this.solUsdPrice,
                    asset: 'SOL',
                    network: 'solana',
                    slot: tx.slot,
                    blockTime: tx.blockTime,
                    timestamp: blockTimestamp,
                  };

                  await this.handlePaymentDetected(payment);
                  payments.push(payment);
                  this.processedSignatures.add(sig);
                  break;
                }
              }
            }
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'error checking incoming solana payments, failing gracefully');
    }

    return payments;
  }

  /**
   * Internal processor executed whenever a real payment is detected.
   * Updates Ledger, Telemetry, and optional Reputation.
   */
  private async handlePaymentDetected(payment: IncomingPayment): Promise<void> {
    log.info(
      {
        txHash: payment.txHash,
        asset: payment.asset,
        amount: payment.amount,
        amountUsd: payment.amountUsd,
        from: payment.from,
        to: payment.to,
      },
      'real on-chain incoming payment detected on solana address',
    );

    // 1. Update Double-Entry Ledger
    if (this.ledger) {
      try {
        await this.ledger.recordPaymentDeposit({
          txHash: payment.txHash,
          fromAddress: payment.from,
          toAddress: payment.to,
          amountUsd: payment.amountUsd,
          asset: payment.asset,
          network: 'solana',
          walletAccountCode: 'wallet_solana',
          description: `On-chain ${payment.asset} payment on Solana from ${payment.from}`,
        });
      } catch (err) {
        log.error({ err, txHash: payment.txHash }, 'failed to record payment in ledger');
      }
    }

    // 2. Emit structured telemetry event
    this.telemetry.recordPaymentReceived({
      txHash: payment.txHash,
      amount: payment.amount,
      amountUsd: payment.amountUsd,
      asset: payment.asset,
      from: payment.from,
      to: payment.to,
      network: 'solana',
      timestamp: payment.timestamp.toISOString(),
    });

    // 3. Notify reputation system if sender is tracked
    if (this.reputationSystem && payment.from && payment.from !== 'unknown-sender') {
      try {
        this.reputationSystem.recordFeedback({
          taskId: payment.txHash,
          agentId: payment.from,
          success: true,
          latencyMs: 100,
          deadlineMs: 60000,
          evalScore: 1.0,
          ratchetAccepted: true,
          notes: `Confirmed on-chain payment of ${payment.amount} ${payment.asset}`,
        });
      } catch (err) {
        log.warn({ err }, 'failed to update sender reputation for payment');
      }
    }
  }

  /**
   * Records a manual or externally validated incoming payment (e.g. for testing).
   */
  public async registerIncomingPayment(payment: IncomingPayment): Promise<void> {
    if (this.processedSignatures.has(payment.txHash)) {
      return;
    }
    await this.handlePaymentDetected(payment);
    this.processedSignatures.add(payment.txHash);
  }

  public getProcessedSignatures(): string[] {
    return Array.from(this.processedSignatures);
  }
}
