export interface ExternalBountyPayload {
  id: string;
  description: string;
  currency: 'EUR' | 'USD' | 'AC';
  budget: number;
  callbackUrl?: string;
  requirements?: Record<string, unknown>;
}

export interface InternalTaskFormat {
  id: string;
  originalId: string;
  prompt: string;
  maxBudgetAC: number;
  callbackUrl?: string;
  rawCurrency: string;
  rawBudget: number;
}

export class RealDemandAdapter {
  private conversionRates: Record<string, number> = {
    EUR: 10.0,
    USD: 9.0,
    AC: 1.0,
  };

  public parseExternalTask(payload: ExternalBountyPayload): InternalTaskFormat {
    if (!payload.description || payload.budget <= 0) {
      throw new Error('Payload-ul extern este invalid: lipsește descrierea sau bugetul este negativ.');
    }

    const rate = this.conversionRates[payload.currency] || 1.0;
    const internalBudgetAC = payload.budget * rate;

    return {
      id: `ext_${payload.id}`,
      originalId: payload.id,
      prompt: payload.description,
      maxBudgetAC: Number(internalBudgetAC.toFixed(4)),
      callbackUrl: payload.callbackUrl,
      rawCurrency: payload.currency,
      rawBudget: payload.budget,
    };
  }
}