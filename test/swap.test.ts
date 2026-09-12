import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { prepareSwap, primaryTypeOf } from "../src/graph/swap.ts";

const PERMIT_TYPES = {
  PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
  PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
};
const permitData = {
  domain: { name: "Permit2", chainId: 8453, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  types: PERMIT_TYPES,
  values: {
    details: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "1461501637330902918203684832716283019655932542975", expiration: "1790000000", nonce: "0" },
    spender: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    sigDeadline: "1789250000",
  },
};
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", WETH = "0x4200000000000000000000000000000000000006";

function fakeBuyer(answers: Record<string, unknown>) {
  const calls: { service: string; path: string; body: any }[] = [];
  return {
    calls,
    call: async (service: string, req: any) => {
      calls.push({ service, path: req.path, body: req.body });
      const data = answers[req.path];
      return { ok: data != null, status: data != null ? 200 : 404, data: data ?? { errorCode: "QuoteNotFound" }, receipt: { metered_units: 1, amount: "0.002", currency: "HBAR", transaction_id: `tx${calls.length}`, network: "hedera:testnet" } } as any;
    },
  };
}

test("primaryTypeOf finds the struct nothing else refers to", () => {
  assert.equal(primaryTypeOf(PERMIT_TYPES), "PermitSingle");
  assert.equal(primaryTypeOf({ EIP712Domain: [], Order: [{ name: "items", type: "Item[]" }], Item: [{ name: "a", type: "uint256" }] }), "Order");
});

test("prepareSwap: approval check, quote, a permit signed by this wallet, unsigned calldata, every step paid", async () => {
  const key = generatePrivateKey();
  const me = privateKeyToAccount(key).address;
  const buyer = fakeBuyer({
    "/check_approval": { approval: { to: USDC, from: me, data: "0x095ea7b3" + "00".repeat(64), value: "0x00", chainId: 8453 } },
    "/quote": { routing: "CLASSIC", permitData, quote: { quoteId: "q1", output: { amount: "396215322000690", minimumAmount: "394234245390687" }, routeString: "[v3] 100.00% = [0.05%]", gasFeeUSD: "0.0027" } },
    "/swap": { swap: { to: "0x6fF5693b99212Da76ad316178A184AB56D299b43", data: "0x3593564c" + "ab".repeat(900), value: "0x00", chainId: 8453, gasLimit: "97000" } },
  });
  const p = await prepareSwap({ chain_id: 8453, token_in: USDC, token_out: WETH, amount: "1000000", decimals_in: 6, decimals_out: 18 }, { buyer, signerKey: key });

  assert.deepEqual(buyer.calls.map((c) => c.path), ["/check_approval", "/quote", "/swap"]);
  assert.ok(buyer.calls.every((c) => c.service === "uniswap-quote"), "every Trading API call goes through the paid lane");
  assert.equal(buyer.calls[1].body.swapper, me, "quoted for this wallet, not a placeholder");
  assert.equal(p.ok, true);
  assert.equal(p.swapper, me);
  assert.equal(p.amount_in, "1");
  assert.equal(p.amount_out, String(396215322000690 / 1e18));
  assert.ok(p.approval && p.approval.to === USDC, "the Permit2 approval comes back unsigned");
  assert.equal(p.permit_signed, true);
  assert.equal(p.swap?.gas_limit, "97000");
  assert.equal(p.spend.length, 3);

  const swapBody = buyer.calls[2].body;
  const signer = await recoverTypedDataAddress({ domain: permitData.domain as any, types: PERMIT_TYPES, primaryType: "PermitSingle", message: permitData.values as any, signature: swapBody.signature });
  assert.equal(signer, me, "the permit is signed by the swapper's own key");
  assert.equal(swapBody.simulateTransaction, false);
});

test("prepareSwap leaves a UniswapX order as a quote and does not sign or submit it", async () => {
  const key = generatePrivateKey();
  const buyer = fakeBuyer({
    "/check_approval": { approval: null },
    "/quote": { routing: "DUTCH_V2", permitData, quote: { quoteId: "x1", output: { amount: "792207843000000000" } } },
  });
  const p = await prepareSwap({ chain_id: 1, token_in: USDC, token_out: WETH, amount: "2000000000", decimals_in: 6, decimals_out: 18 }, { buyer, signerKey: key });
  assert.deepEqual(buyer.calls.map((c) => c.path), ["/check_approval", "/quote"]);
  assert.equal(p.routing, "DUTCH_V2");
  assert.equal(p.permit_signed, false);
  assert.equal(p.swap, null);
  assert.equal(p.ok, true);
  assert.match(p.steps.at(-1)!, /UniswapX order/);
});

test("prepareSwap reports a failed quote instead of throwing", async () => {
  const buyer = fakeBuyer({ "/check_approval": { approval: null } });
  const p = await prepareSwap({ chain_id: 84532, token_in: USDC, token_out: WETH, amount: "1" }, { buyer, signerKey: generatePrivateKey() });
  assert.equal(p.ok, false);
  assert.match(p.steps.join("\n"), /quote: Uniswap answered HTTP 404 QuoteNotFound/);
});
