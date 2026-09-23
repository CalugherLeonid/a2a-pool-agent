export type EscrowStatus = 'LOCKED' | 'RELEASED' | 'REFUNDED' | 'FAILED';

export interface EscrowRecord {
  escrowId: string;
  taskId: string;
  amount: number;
  from: string;
  to: string;
  status: EscrowStatus;
  createdAt: Date;
  updatedAt: Date;
  failureReason?: string;
}

export interface LockFundsParams {
  taskId: string;
  amount: number;
  from: string;
  to: string;
}

export interface EscrowSystemInterface {
  lockFunds(params: LockFundsParams): Promise<{ success: boolean; escrowId?: string; error?: string }>;
  releaseFunds(taskId: string, escrowId: string): Promise<{ success: boolean; error?: string }>;
  refundFunds(taskId: string, escrowId: string, reason: string): Promise<{ success: boolean; error?: string }>;
  getStuckTransactions(): string[];
}

export class EscrowSystem implements EscrowSystemInterface {
  private store: Map<string, EscrowRecord> = new Map();
  private taskIdToEscrowIdMap: Map<string, string> = new Map();
  private reconciliationQueue: Set<string> = new Set();

  constructor(private readonly maxRetries: number = 3) {}

  public async lockFunds(params: LockFundsParams): Promise<{ success: boolean; escrowId?: string; error?: string }> {
    const { taskId, amount, from, to } = params;

    const existingEscrowId = this.taskIdToEscrowIdMap.get(taskId);
    if (existingEscrowId) {
      const record = this.store.get(existingEscrowId)!;
      if (record.status === 'LOCKED') {
        return { success: true, escrowId: record.escrowId };
      }
      return { success: false, error: `Escrow for task ${taskId} already processed with status: ${record.status}` };
    }

    if (amount <= 0) {
      return { success: false, error: 'Escrow amount must be greater than zero.' };
    }

    const escrowId = `escrow-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const now = new Date();

    const record: EscrowRecord = {
      escrowId,
      taskId,
      amount,
      from,
      to,
      status: 'LOCKED',
      createdAt: now,
      updatedAt: now,
    };

    this.store.set(escrowId, record);
    this.taskIdToEscrowIdMap.set(taskId, escrowId);
    
    return { success: true, escrowId };
  }

  public async releaseFunds(taskId: string, escrowId: string): Promise<{ success: boolean; error?: string }> {
    const record = this.getRecord(taskId, escrowId);
    if (!record) {
      return { success: false, error: `Escrow record not found for task ${taskId} and escrowId ${escrowId}` };
    }

    if (record.status === 'RELEASED') return { success: true };
    if (record.status !== 'LOCKED') {
      return { success: false, error: `Cannot release funds from status: ${record.status}` };
    }

    return this.executeWithRetry(
      async () => {
        record.status = 'RELEASED';
        record.updatedAt = new Date();
        this.store.set(record.escrowId, record);
        this.reconciliationQueue.delete(taskId);
        return { success: true };
      },
      taskId,
      'release'
    );
  }

  public async refundFunds(taskId: string, escrowId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    const record = this.getRecord(taskId, escrowId);
    if (!record) {
      return { success: false, error: `Escrow record not found for task ${taskId} and escrowId ${escrowId}` };
    }

    if (record.status === 'REFUNDED') return { success: true };
    if (record.status !== 'LOCKED') {
      return { success: false, error: `Cannot refund funds from status: ${record.status}` };
    }

    const result = await this.executeWithRetry(
      async () => {
        record.status = 'REFUNDED';
        record.failureReason = reason;
        record.updatedAt = new Date();
        this.store.set(record.escrowId, record);
        this.reconciliationQueue.delete(taskId);
        return { success: true };
      },
      taskId,
      'refund'
    );

    if (!result.success) {
      record.status = 'FAILED';
      record.failureReason = `Refund failed after retries: ${result.error}`;
      record.updatedAt = new Date();
      this.store.set(record.escrowId, record);
      this.reconciliationQueue.add(taskId);
    }

    return result;
  }

  public getStuckTransactions(): string[] {
    return Array.from(this.reconciliationQueue);
  }

  private getRecord(taskId: string, escrowId: string): EscrowRecord | undefined {
    const mappedEscrowId = this.taskIdToEscrowIdMap.get(taskId);
    if (mappedEscrowId && mappedEscrowId === escrowId) {
      return this.store.get(escrowId);
    }
    return undefined;
  }

  // FIX: Am eliminat genericul <T> ambiguu și am tipizat explicit return-ul
  private async executeWithRetry(
    operation: () => Promise<{ success: boolean }>,
    taskId: string,
    actionType: string
  ): Promise<{ success: boolean; error?: string }> {
    let attempts = 0;
    let lastError = '';

    while (attempts < this.maxRetries) {
      try {
        attempts++;
        const result = await operation();
        return result; 
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        const delay = Math.pow(2, attempts - 1) * 100;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return {
      success: false,
      error: `Failed to ${actionType} escrow for task ${taskId} after ${this.maxRetries} attempts. Last error: ${lastError}`,
    };
  }
}