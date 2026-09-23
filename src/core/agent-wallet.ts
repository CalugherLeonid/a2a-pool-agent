/** Minimal in-memory balance tracker for an autonomous agent. */
export class AgentWallet {
  private balance: number;

  constructor(
    public readonly agentId: string,
    initialBalance: number,
  ) {
    this.balance = initialBalance;
  }

  public getBalance(): number {
    return this.balance;
  }

  public canAfford(amount: number): boolean {
    return this.balance >= amount;
  }

  public deduct(amount: number): boolean {
    if (!this.canAfford(amount)) return false;
    this.balance -= amount;
    return true;
  }

  public credit(amount: number): void {
    this.balance += amount;
  }
}
