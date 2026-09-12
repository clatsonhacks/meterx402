// MeterX402 API Client
// Using Node's built-in fetch (Node 18+)

export interface Service {
    service_id: string;
    name: string;
    description?: string;
    capabilities: string[];
    price: {
        amount: string;
        currency: string;
        unit: string;
    };
    reputation?: number;
    endpoint: string;
    sample?: {
        path?: string;
        method?: string;
    };
}

export interface CallOptions {
    path?: string;
    method?: string;
    body?: any;
    maxPrice?: number;
}

export interface CallResult {
    success: boolean;
    data?: any;
    error?: string;
    receipt?: {
        amount: string;
        currency: string;
        units: number;
        unit_type: string;
        transaction_id?: string;
    };
}

export interface WalletConfig {
    accountId?: string;
    privateKey?: string;
    maxPerCall?: string;
    budget?: string;
}

export class MeterX402Client {
    constructor(
        private hubUrl: string,
        private config: WalletConfig
    ) {}

    async searchServices(query?: string, capability?: string): Promise<Service[]> {
        const params = new URLSearchParams();
        if (query) {
            params.set('q', query);
        }
        if (capability) {
            params.set('capability', capability);
        }

        const response = await fetch(`${this.hubUrl}/registry/services?${params}`);
        const data: any = await response.json();

        return (data.services || []).map((s: any) => ({
            service_id: s.service_id,
            name: s.name || s.service_id,
            description: s.description,
            capabilities: s.capabilities || [],
            price: {
                amount: s.typical_price?.amount || s.descriptor?.pricing?.rate || '0',
                currency: s.descriptor?.pricing?.currency || 'HBAR',
                unit: s.descriptor?.pricing?.unit || 'unit'
            },
            reputation: s.reputation?.score,
            endpoint: s.endpoint || s.descriptor?.endpoint,
            sample: s.descriptor?.sample
        }));
    }

    async callService(serviceId: string, options: CallOptions): Promise<CallResult> {
        try {
            // Get quote
            const quoteResponse = await fetch(`${this.hubUrl}/playground/quote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    service_id: serviceId,
                    path: options.path,
                    method: options.method || 'GET',
                    body: options.body
                })
            });

            const quoteData: any = await quoteResponse.json();

            if (!quoteData.ok) {
                return {
                    success: false,
                    error: quoteData.error || 'Failed to get quote'
                };
            }

            // If it's free, return immediately
            if (quoteData.free) {
                return {
                    success: true,
                    data: quoteData.result?.data
                };
            }

            // Check max price
            const amount = parseFloat(quoteData.quote.amount);
            if (options.maxPrice && amount > options.maxPrice) {
                return {
                    success: false,
                    error: `Price ${amount} HBAR exceeds max price ${options.maxPrice} HBAR`
                };
            }

            // Pay for the quote
            const payResponse = await fetch(`${this.hubUrl}/playground/pay`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quote_id: quoteData.quote.quote_id,
                    maxPrice: options.maxPrice
                })
            });

            const payData: any = await payResponse.json();

            if (!payData.ok) {
                return {
                    success: false,
                    error: payData.error || 'Payment failed'
                };
            }

            return {
                success: true,
                data: payData.result?.data,
                receipt: payData.result?.receipt ? {
                    amount: payData.result.receipt.amount,
                    currency: payData.result.receipt.currency,
                    units: payData.result.receipt.units,
                    unit_type: payData.result.receipt.unit,
                    transaction_id: payData.result.receipt.txHash
                } : undefined
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message
            };
        }
    }

    async publishDataset(options: {
        path: string;
        wallet: string;
        rate: number;
        title?: string;
        description?: string;
        capabilities?: string[];
    }): Promise<any> {
        const response = await fetch(`${this.hubUrl}/deploy/dataset/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options)
        });

        return await response.json();
    }

    async getWalletInfo(): Promise<any> {
        const response = await fetch(`${this.hubUrl}/me`);
        return await response.json();
    }

    async checkDataset(path: string): Promise<any> {
        const response = await fetch(`${this.hubUrl}/deploy/dataset/check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });

        return await response.json();
    }
}
