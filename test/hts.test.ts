// Settling in an HTS token, and the fee the ledger takes for itself.
//
// The interesting properties are: a price means the token's own units (not
// tinybar), the fee schedule is READ from the token rather than configured, a
// buyer never signs an asset it did not opt into, and route selection still
// matches buyer to seller by currency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { hederaTokenPreset, CHAINS } from "../src/chains.ts";
import { SettlementOption } from "../src/protocol/schemas.ts";
import { selectRoute } from "../src/settlement/adapter.ts";
import { MeterX402 } from "../src/sdk/buyer.ts";
import { toAtomic } from "../src/pricing.ts";

const TOKEN = "0.0.10501361";
const MIRROR_TOKEN = {
  token_id: TOKEN, symbol: "MXC", name: "MeterX402 Credit", decimals: "6",
  custom_fees: {
    fractional_fees: [{
      amount: { numerator: 200, denominator: 10000 },
      collector_account_id: "0.0.10452591",
      net_of_transfers: false,
    }],
  },
};

/** Answer the mirror node from a fixture for the duration of one call. */
async function withMirror<T>(body: unknown, fn: () => Promise<T>, status = 200): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("a token preset takes its decimals, symbol and fee from the token itself", async () => {
  const p = await withMirror(MIRROR_TOKEN, () => hederaTokenPreset(TOKEN));
  assert.equal(p.asset, TOKEN);
  assert.equal(p.currency, "MXC");
  assert.equal(p.decimals, 6, "not tinybar");
  assert.deepEqual(p.fee, { percent: "2", collector: "0.0.10452591", assessment: "inclusive", source: "hts-custom-fee" });
  // the same facilitator and scheme as HBAR: only the asset changes
  assert.equal(p.facilitator, CHAINS.hedera.facilitator);
  assert.equal(p.register, CHAINS.hedera.register);
  assert.deepEqual(p.price(240000n), { amount: "240000", asset: TOKEN });
});

test("0.24 of a 6-decimal token is 240000 atomic, not 24000000", async () => {
  const p = await withMirror(MIRROR_TOKEN, () => hederaTokenPreset(TOKEN));
  assert.equal(toAtomic("0.24", p.decimals), 240000n);
  assert.equal(toAtomic("0.24", CHAINS.hedera.decimals), 24000000n, "HBAR still uses tinybar");
});

test("a token with no custom fee discloses no fee", async () => {
  const p = await withMirror({ ...MIRROR_TOKEN, custom_fees: {} }, () => hederaTokenPreset(TOKEN));
  assert.equal(p.fee, undefined);
});

test("net_of_transfers means the payer is charged on top", async () => {
  const body = { ...MIRROR_TOKEN, custom_fees: { fractional_fees: [{ ...MIRROR_TOKEN.custom_fees.fractional_fees[0], net_of_transfers: true }] } };
  const p = await withMirror(body, () => hederaTokenPreset(TOKEN));
  assert.equal(p.fee?.assessment, "exclusive");
});

test("an unknown token is an error, not a silent HBAR fallback", async () => {
  await assert.rejects(() => withMirror({ _status: 404 }, () => hederaTokenPreset("0.0.999999"), 404), /not found/);
});

test("odd fee fractions read as plain percentages", async () => {
  const frac = (numerator: number, denominator: number) => ({
    ...MIRROR_TOKEN,
    custom_fees: { fractional_fees: [{ ...MIRROR_TOKEN.custom_fees.fractional_fees[0], amount: { numerator, denominator } }] },
  });
  const pct = async (n: number, d: number) => (await withMirror(frac(n, d), () => hederaTokenPreset(TOKEN))).fee?.percent;
  assert.equal(await pct(25, 10000), "0.25");
  assert.equal(await pct(1, 3), "33.333333");
  assert.equal(await pct(0, 100), "0");
});

// ── the descriptor discloses it ───────────────────────────────────────────
test("SettlementOption carries the ledger fee, and validates it", () => {
  const base = { network: "hedera:testnet", asset: TOKEN, currency: "MXC", decimals: 6, schemes: ["exact"] as const };
  const ok = SettlementOption.parse({ ...base, fee: { percent: "2", collector: "0.0.1", assessment: "inclusive", source: "hts-custom-fee" } });
  assert.equal(ok.fee?.percent, "2");
  assert.doesNotThrow(() => SettlementOption.parse(base), "a fee is optional");
  assert.throws(() => SettlementOption.parse({ ...base, fee: { percent: "2", collector: "0.0.1", assessment: "sometimes", source: "hts-custom-fee" } }));
  assert.throws(() => SettlementOption.parse({ ...base, fee: { percent: "-1", collector: "0.0.1", assessment: "inclusive", source: "hts-custom-fee" } }));
});

// ── buyer and seller have to agree on the asset ───────────────────────────
const hbarOption = { network: "hedera:testnet", asset: "0.0.0", currency: "HBAR", decimals: 8, schemes: ["exact"] as const };
const mxcOption = { network: "hedera:testnet", asset: TOKEN, currency: "MXC", decimals: 6, schemes: ["exact"] as const };

test("route selection matches the wallet's currency", () => {
  const mxcWallet = [{ network: "hedera:testnet", currencies: ["MXC"] }];
  const hbarWallet = [{ network: "hedera:testnet", currencies: ["HBAR"] }];
  assert.equal(selectRoute([mxcOption], mxcWallet)?.option.asset, TOKEN);
  assert.equal(selectRoute([mxcOption], hbarWallet), null, "an HBAR-only wallet cannot pay in credits");
  assert.equal(selectRoute([hbarOption, mxcOption], mxcWallet)?.currency ?? selectRoute([hbarOption, mxcOption], mxcWallet)?.option.currency, "MXC");
  assert.ok(selectRoute([mxcOption], [{ network: "hedera:testnet" }]), "a wallet with no stated currency takes what it is given");
});

test("a buyer signs only assets it opted into", async () => {
  const { PrivateKey } = await import("@hiero-ledger/sdk");
  const wallet = { accountId: "0.0.5001", privateKey: PrivateKey.generateECDSA().toStringDer() };
  const hbarOnly = new MeterX402({ wallet, budget: "1 HBAR" });
  assert.ok(hbarOnly.allowsAsset("0.0.0"), "native HBAR always");
  assert.ok(hbarOnly.allowsAsset(undefined));
  assert.ok(!hbarOnly.allowsAsset(TOKEN), "a token the buyer never heard of is refused");

  const optedIn = new MeterX402({ wallet, budget: "100 MXC", assets: [TOKEN] });
  assert.ok(optedIn.allowsAsset(TOKEN));
  assert.ok(!optedIn.allowsAsset("0.0.777"), "opting into one token is not opting into all of them");
});
