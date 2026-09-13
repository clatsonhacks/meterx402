// MeterX402 API Client
// Using Node's built-in fetch (Node 18+)
//
// Discovery and publishing go to the hub. Paying goes to the user's own
// connector (npx mx402 connector), which signs with the user's own testnet key
// inside their budget. The extension never pays from a hub's demo wallet and
// never holds a private key.

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
    /** the connector isn't running or rejected the token */
    connector?: 'unreachable' | 'unauthorized';
    receipt?: {
        amount: string;
        currency: string;
        units: number;
        unit_type: string;
        transaction_id?: string;
    };
}

export interface ConnectorConfig {
    url: string;
    token: () => Promise<string | undefined>;
}

export class MeterX402Client {
    constructor(
        private hubUrl: string,
        private connector: ConnectorConfig
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
            name: s.descriptor?.title || s.descriptor?.name || s.service_id,
            description: s.descriptor?.description,
            capabilities: s.descriptor?.capabilities || [],
            price: {
                amount: String(s.price?.rate ?? s.descriptor?.pricing?.rate ?? '0'),
                currency: s.price?.currency || s.descriptor?.pricing?.currency || 'HBAR',
                unit: s.price?.unit || s.descriptor?.pricing?.unit || 'unit'
            },
            reputation: s.reputation?.score,
            endpoint: s.descriptor?.endpoint,
            sample: s.descriptor?.sample
        }));
    }

    private async connectorFetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: any } | CallResult> {
        const token = await this.connector.token();
        if (!token) {
            return { success: false, connector: 'unauthorized', error: 'No connector token yet: run "MeterX402: Start My Connector".' };
        }
        let response: Response;
        try {
            response = await fetch(`${this.connector.url}${path}`, {
                ...init,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) }
            });
        } catch {
            return { success: false, connector: 'unreachable', error: `Your connector isn't running at ${this.connector.url}.` };
        }
        if (response.status === 401) {
            return { success: false, connector: 'unauthorized', error: 'The connector rejected the token: start it again, or set the token it printed.' };
        }
        return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    async callService(serviceId: string, options: CallOptions): Promise<CallResult> {
        const r = await this.connectorFetch('/call', {
            method: 'POST',
            body: JSON.stringify({
                service_id: serviceId,
                path: options.path,
                method: options.method,
                body: options.body,
                max_price: options.maxPrice
            })
        });
        if ('success' in r) {
            return r;
        }
        const d = r.body;
        if (!d.ok) {
            return { success: false, error: d.error || `HTTP ${d.status ?? r.status}` };
        }
        return {
            success: true,
            data: d.data,
            receipt: d.receipt ? {
                amount: d.receipt.amount,
                currency: d.receipt.currency,
                units: d.receipt.units,
                unit_type: d.receipt.unit,
                transaction_id: d.receipt.transaction_id ?? undefined
            } : undefined
        };
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

    /** The account the connector pays from and the budget left; never the key. */
    async getWalletInfo(): Promise<any> {
        const r = await this.connectorFetch('/wallet');
        return 'success' in r ? { ok: false, connector: r.connector, error: r.error } : r.body;
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
