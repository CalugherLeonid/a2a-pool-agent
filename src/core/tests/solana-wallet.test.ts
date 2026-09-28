import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SolanaReceiveWallet } from '../solana-wallet.js';
import { Ledger } from '../ledger.js';
import { TelemetryCollector } from '../../telemetry/metrics.js';
import { ReputationSystem } from '../reputation.js';

describe('SolanaReceiveWallet - Receive-Only Real Payment Monitor', () => {
  const EXPECTED_ADDRESS = '3t7xtNf5vyb7XKMFoNXaZJ7yW4dx8L8CN1LjcCLEacER';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  let mockFetch: any;
  let ledger: Ledger;
  let telemetry: TelemetryCollector;
  let reputationSystem: ReputationSystem;

  beforeEach(() => {
    mockFetch = vi.fn();
    ledger = new Ledger();
    telemetry = new TelemetryCollector();
    reputationSystem = new ReputationSystem();
  });

  it('configures receive-only address and verifies public-only constraints', () => {
    const wallet = new SolanaReceiveWallet({
      receiveAddress: EXPECTED_ADDRESS,
      usdcMint: USDC_MINT,
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    expect(wallet.getReceiveAddress()).toBe(EXPECTED_ADDRESS);
    expect(wallet.receiveAddress).toBe(EXPECTED_ADDRESS);
    expect(wallet.usdcMint).toBe(USDC_MINT);
    // Real wallet: public address ONLY, no private keys or outgoing signing capability
    expect((wallet as any).privateKey).toBeUndefined();
    expect((wallet as any).signTransaction).toBeUndefined();
  });

  it('reads on-chain SOL and USDC balances via standard JSON-RPC', async () => {
    mockFetch.mockImplementation(async (_url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (body.method === 'getBalance') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: { value: 2_500_000_000 }, // 2.5 SOL in lamports
          }),
        };
      }
      if (body.method === 'getTokenAccountsByOwner') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: {
              value: [
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          tokenAmount: { uiAmount: 150.75 },
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', result: null }) };
    });

    const wallet = new SolanaReceiveWallet({
      receiveAddress: EXPECTED_ADDRESS,
      usdcMint: USDC_MINT,
      fetchFn: mockFetch,
    });

    const balance = await wallet.getBalance();
    expect(balance.sol).toBe(2.5);
    expect(balance.usdc).toBe(150.75);
  });

  it('fails gracefully when RPC fails or returns 500 error (no crash)', async () => {
    mockFetch.mockImplementation(async () => {
      return {
        ok: false,
        status: 503,
      };
    });

    const wallet = new SolanaReceiveWallet({
      receiveAddress: EXPECTED_ADDRESS,
      fetchFn: mockFetch,
    });

    // Should return cached last known balance (0, 0) without throwing
    const balance = await wallet.getBalance();
    expect(balance.sol).toBe(0);
    expect(balance.usdc).toBe(0);

    // checkIncomingPayments should return empty array safely
    const payments = await wallet.checkIncomingPayments();
    expect(payments).toEqual([]);
  });

  it('detects verified incoming USDC payment, credits ledger, and emits telemetry', async () => {
    const txHash = '5VerfyTxUSDCIncomingHash1234567890abcdef';
    const sender = 'SenderPubkey111111111111111111111111111111111';

    mockFetch.mockImplementation(async (_url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (body.method === 'getSignaturesForAddress') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: [{ signature: txHash, slot: 1000, blockTime: Math.floor(Date.now() / 1000) }],
          }),
        };
      }
      if (body.method === 'getTransaction') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: {
              slot: 1000,
              blockTime: Math.floor(Date.now() / 1000),
              transaction: {
                message: {
                  accountKeys: [{ pubkey: sender }, { pubkey: EXPECTED_ADDRESS }],
                  instructions: [],
                },
              },
              meta: {
                preTokenBalances: [
                  { accountIndex: 1, mint: USDC_MINT, owner: EXPECTED_ADDRESS, uiTokenAmount: { uiAmount: 100 } },
                ],
                postTokenBalances: [
                  { accountIndex: 1, mint: USDC_MINT, owner: EXPECTED_ADDRESS, uiTokenAmount: { uiAmount: 150 } }, // +50 USDC
                ],
              },
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', result: null }) };
    });

    const recordPaymentDepositSpy = vi.spyOn(ledger, 'recordPaymentDeposit').mockResolvedValue({
      id: 'tx-1',
      taskId: txHash,
      adapterId: 'solana',
      description: 'Incoming USDC on solana',
      status: 'settled',
      entries: [
        { transactionId: 'tx-1', accountCode: 'wallet_solana', debit: 50, credit: 0 },
        { transactionId: 'tx-1', accountCode: 'revenue', debit: 0, credit: 50 },
      ],
      createdAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
    });

    const telemetrySpy = vi.spyOn(telemetry, 'recordPaymentReceived');

    const wallet = new SolanaReceiveWallet({
      receiveAddress: EXPECTED_ADDRESS,
      usdcMint: USDC_MINT,
      ledger,
      telemetry,
      reputationSystem,
      fetchFn: mockFetch,
    });

    const detected = await wallet.checkIncomingPayments();
    expect(detected.length).toBe(1);
    expect(detected[0]!.txHash).toBe(txHash);
    expect(detected[0]!.asset).toBe('USDC');
    expect(detected[0]!.amount).toBe(50);
    expect(detected[0]!.amountUsd).toBe(50);
    expect(detected[0]!.from).toBe(sender);
    expect(detected[0]!.to).toBe(EXPECTED_ADDRESS);

    // Verified: Ledger double-entry update
    expect(recordPaymentDepositSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash,
        amountUsd: 50,
        asset: 'USDC',
        walletAccountCode: 'wallet_solana',
      }),
    );

    // Verified: Telemetry event emitted
    expect(telemetrySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash,
        amount: 50,
        amountUsd: 50,
        asset: 'USDC',
        network: 'solana',
      }),
    );

    // Idempotency: second check does not re-credit ledger
    const secondCheck = await wallet.checkIncomingPayments();
    expect(secondCheck.length).toBe(0);
    expect(recordPaymentDepositSpy).toHaveBeenCalledTimes(1);
  });

  it('detects incoming native SOL payment and converts to USD using reference price', async () => {
    const txHash = 'SolNativeTxHash9876543210fedcba';
    const sender = 'NativeSolSenderPubkey222222222222222222222';

    mockFetch.mockImplementation(async (_url: string, options: any) => {
      const body = JSON.parse(options.body);
      if (body.method === 'getSignaturesForAddress') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: [{ signature: txHash, slot: 2000, blockTime: Math.floor(Date.now() / 1000) }],
          }),
        };
      }
      if (body.method === 'getTransaction') {
        return {
          ok: true,
          json: async () => ({
            jsonrpc: '2.0',
            result: {
              slot: 2000,
              blockTime: Math.floor(Date.now() / 1000),
              transaction: {
                message: {
                  instructions: [
                    {
                      program: 'system',
                      parsed: {
                        type: 'transfer',
                        info: {
                          destination: EXPECTED_ADDRESS,
                          source: sender,
                          lamports: 1_000_000_000, // 1 SOL
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', result: null }) };
    });

    const recordPaymentDepositSpy = vi.spyOn(ledger, 'recordPaymentDeposit').mockResolvedValue(null);

    const wallet = new SolanaReceiveWallet({
      receiveAddress: EXPECTED_ADDRESS,
      ledger,
      telemetry,
      fetchFn: mockFetch,
      solUsdPrice: 160,
    });

    const detected = await wallet.checkIncomingPayments();
    expect(detected.length).toBe(1);
    expect(detected[0]!.asset).toBe('SOL');
    expect(detected[0]!.amount).toBe(1.0);
    expect(detected[0]!.amountUsd).toBe(160);

    expect(recordPaymentDepositSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        txHash,
        amountUsd: 160,
        asset: 'SOL',
        walletAccountCode: 'wallet_solana',
      }),
    );
  });
});
