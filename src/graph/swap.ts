// Build a Uniswap swap an agent can sign: approval check → quote → permit → calldata.
//
// Every Trading API call goes through the uniswap-quote lane, so each is an
// x402 payment with a receipt like any other step the agent takes. The
// buyer's EVM key signs one thing, the Permit2 message, off-chain. The
// transactions come back unsigned, ready for a wallet to send.
//
// This module never broadcasts. On a mainnet that is the only safe default for
// an agent holding a key; on a testnet a funded wallet can take the calldata
// and send it. UniswapX quotes are returned as quotes only: submitting a signed
// order would let fillers execute it, which is a decision for a person.

import type { CallRequest, CallResult, MeterX402 } from "../sdk/buyer.ts";

export interface SwapRequest {
  chain_id: number;
  token_in: string;
  token_out: string;
  /** Atomic units of token_in. */
  amount: string;
  decimals_in?: number;
  decimals_out?: number;
  slippage_percent?: number;
}

export interface UnsignedTx {
  to: string;
  data: string;
  value: string;
  chain_id: number;
  gas_limit: string | null;
}

export interface SwapSpend {
  step: string;
  units: number | null;
  amount: string | null;
  currency: string | null;
  tx: string | null;
  network: string | null;
}

export interface PreparedSwap {
  chain_id: number;
  swapper: string;
  routing: string | null;
  /** Token approval to Permit2, when the wallet has not granted one yet. */
  approval: UnsignedTx | null;
  permit_signed: boolean;
  swap: UnsignedTx | null;
  amount_in: string;
  amount_out: string | null;
  min_amount_out: string | null;
  route: string | null;
  gas_usd: number | null;
  quote_id: string | null;
  steps: string[];
  spend: SwapSpend[];
  ok: boolean;
}

type EIP712Types = Record<string, { name: string; type: string }[]>;

/** The struct no other struct refers to: what an EIP-712 message is "of". */
export function primaryTypeOf(types: EIP712Types): string | null {
  const referenced = new Set(Object.values(types).flat().map((f) => f.type.replace(/\[\d*\]$/, "")));
  return Object.keys(types).find((t) => t !== "EIP712Domain" && !referenced.has(t)) ?? null;
}

const human = (atomic: string | undefined | null, decimals?: number) =>
  atomic == null ? null : decimals == null ? atomic : String(Number(atomic) / 10 ** decimals);

const unsigned = (tx: any, chainId: number): UnsignedTx | null =>
  tx?.to && tx?.data ? { to: String(tx.to), data: String(tx.data), value: String(tx.value ?? "0x00"), chain_id: Number(tx.chainId ?? chainId), gas_limit: tx.gasLimit == null ? null : String(tx.gasLimit) } : null;

export async function prepareSwap(
  req: SwapRequest,
  opts: { buyer: Pick<MeterX402, "call">; signerKey: string; service?: string },
): Promise<PreparedSwap> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(opts.signerKey as `0x${string}`);
  const service = opts.service ?? "uniswap-quote";
  const out: PreparedSwap = {
    chain_id: req.chain_id, swapper: account.address, routing: null, approval: null, permit_signed: false, swap: null,
    amount_in: human(req.amount, req.decimals_in) ?? req.amount, amount_out: null, min_amount_out: null,
    route: null, gas_usd: null, quote_id: null, steps: [], spend: [], ok: false,
  };
  const paid = async (step: string, path: string, body: Record<string, unknown>) => {
    let r: CallResult;
    try {
      r = await opts.buyer.call(service, { path, method: "POST", body } as CallRequest);
    } catch (e) {
      out.steps.push(`${step}: not paid (${String((e as Error)?.message ?? e).split("\n")[0]})`);
      return null;
    }
    const rc = r.receipt;
    out.spend.push({ step, units: rc?.metered_units ?? null, amount: rc?.amount ?? null, currency: rc?.currency ?? null, tx: rc?.transaction_id ?? null, network: rc?.network ?? null });
    const data = r.data as any;
    if (!r.ok) {
      out.steps.push(`${step}: Uniswap answered HTTP ${r.status}${data?.errorCode ? ` ${data.errorCode}` : ""}${data?.detail ? `: ${String(data.detail).slice(0, 120)}` : ""}`);
      return null;
    }
    return data;
  };

  // 1. does the wallet still need to approve Permit2 for this token?
  const native = /^0x0{40}$/i.test(req.token_in);
  if (!native) {
    const a = await paid("approval", "/check_approval", { walletAddress: account.address, token: req.token_in, amount: req.amount, chainId: req.chain_id });
    if (a) {
      out.approval = unsigned(a.approval, req.chain_id);
      out.steps.push(out.approval ? "approval: this wallet must first approve Permit2 for the token (one transaction, returned unsigned)" : "approval: already in place");
    }
  }

  // 2. a quote for this exact wallet
  const q = await paid("quote", "/quote", {
    type: "EXACT_INPUT", amount: req.amount, tokenInChainId: req.chain_id, tokenOutChainId: req.chain_id,
    tokenIn: req.token_in, tokenOut: req.token_out, swapper: account.address,
    slippageTolerance: req.slippage_percent ?? 0.5, routingPreference: "BEST_PRICE",
  });
  if (!q?.quote) return out;
  out.routing = q.routing ?? null;
  out.quote_id = q.quote.quoteId ?? null;
  out.amount_out = human(q.quote.output?.amount, req.decimals_out);
  out.min_amount_out = human(q.quote.output?.minimumAmount, req.decimals_out);
  out.route = q.quote.routeString ?? null;
  out.gas_usd = q.quote.gasFeeUSD == null ? null : Number(q.quote.gasFeeUSD);
  out.steps.push(`quote: ${out.routing ?? "?"} route, ${out.amount_in} in → ${out.amount_out ?? "?"} out`);

  if (out.routing !== "CLASSIC") {
    out.steps.push(`swap: ${out.routing} is a UniswapX order; submitting it would let fillers execute it, so it is left as a quote`);
    out.ok = true;
    return out;
  }

  // 3. sign the Permit2 message (off-chain, no gas), then 4. get the calldata
  let signature: string | undefined;
  if (q.permitData?.types) {
    const primaryType = primaryTypeOf(q.permitData.types);
    if (!primaryType) { out.steps.push("permit: could not tell what the permit message is"); return out; }
    signature = await account.signTypedData({ domain: q.permitData.domain, types: q.permitData.types, primaryType, message: q.permitData.values } as any);
    out.permit_signed = true;
    out.steps.push(`permit: signed ${primaryType} off-chain for Permit2`);
  }
  const s = await paid("swap", "/swap", { quote: q.quote, ...(signature ? { signature, permitData: q.permitData } : {}), simulateTransaction: false });
  out.swap = unsigned(s?.swap, req.chain_id);
  if (out.swap) out.steps.push(`swap: calldata for ${out.swap.to} (${Math.round(out.swap.data.length / 2)} bytes${out.swap.gas_limit ? `, gas limit ${Number(out.swap.gas_limit)}` : ""}), unsigned and not sent`);
  out.ok = !!out.swap;
  return out;
}
