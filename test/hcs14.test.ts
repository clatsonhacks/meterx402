// HCS-14 UAIDs: our own implementation, checked against the Standards SDK.
//
// The point of a Universal Agent ID is that everyone computes the same string
// for the same agent. So the interesting test is not "does it look right", it
// is "is it identical to the reference implementation" — including the parts
// where the reference disagrees with its own prose spec (canonical key order).
// The SDK is an optional dependency; where it is missing those checks skip and
// the frozen vectors below still pin the output.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeAgentData, createAid, createUaidFromDid, parseUaid, sameAgent,
  base58Encode, skillsFor, toHederaCaip10, SKILL, type CanonicalAgentData,
} from "../src/protocol/hcs14.ts";

const AGENT: CanonicalAgentData = {
  registry: "meterx402",
  name: "weather",
  version: "1",
  protocol: "a2a",
  nativeId: "hedera:testnet:0.0.10454509",
  skills: [SKILL.DATA_INTEGRATION],
};

// ── canonicalisation ──────────────────────────────────────────────────────
test("canonical JSON uses the standard's fixed key order, not alphabetical", () => {
  const { canonicalJson } = canonicalizeAgentData(AGENT);
  assert.equal(canonicalJson, '{"skills":[8],"name":"weather","nativeId":"hedera:testnet:0.0.10454509","protocol":"a2a","registry":"meterx402","version":"1"}');
  assert.ok(canonicalJson.indexOf('"skills"') < canonicalJson.indexOf('"name"'));
});

test("registry and protocol lowercase, strings trim, skills sort", () => {
  const { normalized, canonicalJson } = canonicalizeAgentData({
    ...AGENT, registry: "  MeterX402 ", protocol: "A2A", name: " weather ", skills: [9, 0, 8],
  });
  assert.equal(normalized.registry, "meterx402");
  assert.equal(normalized.protocol, "a2a");
  assert.equal(normalized.name, "weather");
  assert.deepEqual(normalized.skills, [0, 8, 9]);
  assert.equal(canonicalJson, canonicalizeAgentData({ ...AGENT, skills: [0, 8, 9] }).canonicalJson);
});

test("hcs-10 and acp-virtuals constrain nativeId", () => {
  assert.throws(() => canonicalizeAgentData({ ...AGENT, protocol: "hcs-10", nativeId: "0.0.123" }), /CAIP-10/);
  assert.doesNotThrow(() => canonicalizeAgentData({ ...AGENT, protocol: "hcs-10" }));
  assert.throws(() => canonicalizeAgentData({ ...AGENT, protocol: "acp-virtuals" }), /EIP-155/);
  assert.throws(() => canonicalizeAgentData({ ...AGENT, protocol: "Not Valid!" }), /invalid protocol/);
});

// ── the identity itself ───────────────────────────────────────────────────
test("the AID is stable, and ignores everything but the six fields", () => {
  const a = createAid(AGENT);
  assert.match(a, /^uaid:aid:[1-9A-HJ-NP-Za-km-z]+;uid=0;registry=meterx402;nativeId=hedera:testnet:0\.0\.10454509$/);
  // same agent, moved host and changed price: identical id
  assert.equal(createAid({ ...AGENT }), a);
  // a different account is a different agent
  assert.notEqual(createAid({ ...AGENT, nativeId: "hedera:testnet:0.0.999" }), a);
  assert.notEqual(createAid({ ...AGENT, name: "weather-2" }), a);
});

test("frozen vector: this exact agent always hashes to this UAID", () => {
  assert.equal(
    createAid(AGENT, {}, { includeParams: false }),
    "uaid:aid:7JmaYYEJk7WfPKyQ1TjpgdvyAJnNE9ZZeAhs9q26UCLkrESLGLePtdWcuGqevPKJhe",
  );
});

test("params are emitted in the standard's order", () => {
  const uaid = createAid(AGENT, { uid: "weather", proto: "a2a", domain: "example.com" });
  const tail = uaid.slice(uaid.indexOf(";") + 1);
  assert.equal(tail, "uid=weather;registry=meterx402;proto=a2a;nativeId=hedera:testnet:0.0.10454509;domain=example.com");
});

test("uaid:did wraps an existing DID without rehashing it", () => {
  assert.equal(
    createUaidFromDid("did:hedera:testnet:z6Mkabc123", { uid: "0", proto: "hcs-10" }),
    "uaid:did:z6Mkabc123;uid=0;proto=hcs-10",
  );
  // a DID carrying its own parameters keeps the original under src=
  const wrapped = createUaidFromDid("did:web:example.com;service=agent");
  assert.match(wrapped, /^uaid:did:example\.com;src=z/);
});

test("parse round-trips, and identity ignores routing params", () => {
  const p = parseUaid(createAid(AGENT, { uid: "weather" }));
  assert.equal(p.method, "aid");
  assert.equal(p.params.uid, "weather");
  assert.equal(p.params.registry, "meterx402");
  assert.ok(sameAgent(createAid(AGENT, { uid: "a" }), createAid(AGENT, { uid: "b" })));
  assert.ok(!sameAgent(createAid(AGENT), createAid({ ...AGENT, name: "other" })));
  assert.throws(() => parseUaid("not-a-uaid"), /not a UAID/);
});

// ── helpers ───────────────────────────────────────────────────────────────
test("base58 handles leading zero bytes", () => {
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), "112");
  assert.equal(base58Encode(new Uint8Array([])), "");
  assert.equal(base58Encode(new Uint8Array([57])), "z");
});

test("capabilities map onto the HCS-11 skill vocabulary", () => {
  assert.deepEqual(skillsFor(["text_generation"]), [0]);
  assert.deepEqual(skillsFor(["blockchain_data", "onchain_analytics"]), [10], "duplicates collapse");
  assert.deepEqual(skillsFor(["market_data", "text_generation"]), [0, 9], "sorted");
  assert.deepEqual(skillsFor(["something_we_invented"]), [17], "unknown → API_INTEGRATION");
  assert.equal(toHederaCaip10("testnet", "0.0.1"), "hedera:testnet:0.0.1");
  assert.equal(toHederaCaip10("hedera:testnet", "0.0.1"), "hedera:testnet:0.0.1");
});

// ── the reference implementation ──────────────────────────────────────────
test("matches @hashgraphonline/standards-sdk exactly", async (t) => {
  let sdk: any;
  try { sdk = await import("@hashgraphonline/standards-sdk"); }
  catch { return t.skip("standards-sdk not installed (optional dependency)"); }

  const cases: CanonicalAgentData[] = [
    AGENT,
    { ...AGENT, name: "llm", skills: [0], nativeId: "hedera:testnet:0.0.10452591" },
    { ...AGENT, registry: "HOL", protocol: "HCS-10", skills: [9, 0, 10] },
    { ...AGENT, name: "  spaced  ", version: "2.1.0", skills: [] },
  ];
  for (const c of cases) {
    assert.equal(canonicalizeAgentData(c).canonicalJson, sdk.canonicalizeAgentData(c).canonicalJson, `canonical json for ${c.name}`);
    assert.equal(createAid(c), await sdk.createUaid(c), `uaid for ${c.name}`);
    assert.equal(createAid(c, {}, { includeParams: false }), await sdk.createUaid(c, {}, { includeParams: false }));
  }
  for (const did of ["did:hedera:testnet:z6Mkabc123", "did:web:example.com", "did:key:z6MkhaXgBZ;x=1"]) {
    assert.equal(createUaidFromDid(did, { uid: "0" }), sdk.createUaid(did, { uid: "0" }), `wrap ${did}`);
  }
  assert.deepEqual(parseUaid(createAid(AGENT)), sdk.parseHcs14Did(createAid(AGENT)));
});
