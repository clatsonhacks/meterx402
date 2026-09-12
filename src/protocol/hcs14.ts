// HCS-14: Universal Agent ID (UAID).
//
// A UAID is one portable identifier for an agent across Web2 APIs, EVM chains
// and Hedera. Two targets:
//
//   uaid:aid:<base58(sha384(canonical json))>;<params>   system-generated
//   uaid:did:<method-specific id>;<params>               wraps an existing W3C DID
//
// The AID hashes SIX fields only — registry, name, version, protocol, nativeId,
// skills — deliberately excluding endpoints and prices, so a service keeps the
// same identity when it moves host or changes its rate. That is exactly what we
// want: reputation follows the agent, not the URL.
//
// Implemented here rather than pulled from @hashgraphonline/standards-sdk
// because the SDK is 85 MB and this is a hash: the bundled `mx402` CLI stays
// dependency-free. It matches the SDK byte for byte (canonical key order
// included, which is NOT lexicographic despite what the prose spec says), and
// test/hcs14.test.ts asserts that against the SDK whenever it is installed.

import { createHash } from "node:crypto";

/** Our registry namespace in a UAID, alongside "hol", "nanda", "olas". */
export const UAID_REGISTRY = "meterx402";

/** HCS-11 numeric skills, the vocabulary HCS-14 hashes over. */
export const SKILL = {
  TEXT_GENERATION: 0, IMAGE_GENERATION: 1, AUDIO_GENERATION: 2, VIDEO_GENERATION: 3,
  CODE_GENERATION: 4, LANGUAGE_TRANSLATION: 5, SUMMARIZATION_EXTRACTION: 6,
  KNOWLEDGE_RETRIEVAL: 7, DATA_INTEGRATION: 8, MARKET_INTELLIGENCE: 9,
  TRANSACTION_ANALYTICS: 10, SMART_CONTRACT_AUDIT: 11, GOVERNANCE_FACILITATION: 12,
  SECURITY_MONITORING: 13, COMPLIANCE_ANALYSIS: 14, FRAUD_DETECTION: 15,
  MULTI_AGENT_COORDINATION: 16, API_INTEGRATION: 17, WORKFLOW_AUTOMATION: 18,
} as const;

/** Our capability strings → HCS-11 skill numbers. Anything unmapped is an API. */
const SKILL_OF: Record<string, number> = {
  text_generation: SKILL.TEXT_GENERATION,
  code_generation: SKILL.CODE_GENERATION,
  translation: SKILL.LANGUAGE_TRANSLATION,
  summarization: SKILL.SUMMARIZATION_EXTRACTION,
  search: SKILL.KNOWLEDGE_RETRIEVAL,
  weather_forecast: SKILL.DATA_INTEGRATION,
  file_download: SKILL.DATA_INTEGRATION,
  market_data: SKILL.MARKET_INTELLIGENCE,
  blockchain_data: SKILL.TRANSACTION_ANALYTICS,
  onchain_analytics: SKILL.TRANSACTION_ANALYTICS,
  dao_governance: SKILL.GOVERNANCE_FACILITATION,
};
export const skillsFor = (capabilities: readonly string[]): number[] =>
  [...new Set(capabilities.map((c) => SKILL_OF[c] ?? SKILL.API_INTEGRATION))].sort((a, b) => a - b);

export interface CanonicalAgentData {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  nativeId: string;
  skills: number[];
}
export interface UaidParams {
  uid?: string; registry?: string; proto?: string; nativeId?: string; domain?: string; src?: string;
}

const PROTOCOL_RE = /^[a-z0-9][a-z0-9-]*$/;
const HEDERA_CAIP10_RE = /^hedera:(mainnet|testnet|previewnet|devnet):\d+\.\d+\.\d+$/;
const EIP155_CAIP10_RE = /^eip155:\d+:0x[0-9a-fA-F]{40}$/;

export const toHederaCaip10 = (network: string, accountId: string): string =>
  `hedera:${network.replace(/^hedera:/, "")}:${accountId}`;
export const isHederaCaip10 = (v: string) => HEDERA_CAIP10_RE.test(v);
export const isEip155Caip10 = (v: string) => EIP155_CAIP10_RE.test(v);

/** Normalise and serialise the six fields. Key order is fixed by the standard. */
export function canonicalizeAgentData(input: CanonicalAgentData): { normalized: CanonicalAgentData; canonicalJson: string } {
  for (const k of ["registry", "name", "version", "protocol", "nativeId"] as const) {
    if (!input[k] || typeof input[k] !== "string") throw new Error(`HCS-14: ${k} is required`);
  }
  if (!Array.isArray(input.skills) || input.skills.some((s) => !Number.isInteger(s) || s < 0)) {
    throw new Error("HCS-14: skills must be non-negative integers");
  }
  const protocol = input.protocol.trim().toLowerCase();
  if (!PROTOCOL_RE.test(protocol)) throw new Error(`HCS-14: invalid protocol ${protocol}`);
  if (protocol === "hcs-10" && !isHederaCaip10(input.nativeId.trim())) {
    throw new Error("HCS-14: for protocol hcs-10, nativeId must be CAIP-10 (hedera:<network>:<account>)");
  }
  if (protocol === "acp-virtuals" && !isEip155Caip10(input.nativeId.trim())) {
    throw new Error("HCS-14: for protocol acp-virtuals, nativeId must be EIP-155 CAIP-10");
  }
  const normalized: CanonicalAgentData = {
    registry: input.registry.trim().toLowerCase(),
    name: input.name.trim(),
    version: input.version.trim(),
    protocol,
    nativeId: input.nativeId.trim(),
    skills: [...input.skills].sort((a, b) => a - b),
  };
  // the standard's own order, which is not alphabetical
  const canonicalJson = JSON.stringify({
    skills: normalized.skills, name: normalized.name, nativeId: normalized.nativeId,
    protocol: normalized.protocol, registry: normalized.registry, version: normalized.version,
  });
  return { normalized, canonicalJson };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const x = (digits[i] << 8) + carry;
      digits[i] = x % 58;
      carry = (x / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1"; // leading zeroes
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Parameters in the order the standard fixes: uid, registry, proto, nativeId, domain, src. */
function paramString(p: UaidParams): string {
  const entries: [string, string][] = [];
  if (p.uid) entries.push(["uid", p.uid]);
  if (p.registry) entries.push(["registry", p.registry]);
  if (p.proto) entries.push(["proto", p.proto]);
  if (p.nativeId) entries.push(["nativeId", p.nativeId]);
  if (p.domain) entries.push(["domain", p.domain]);
  if (p.src) entries.push(["src", p.src]);
  return entries.map(([k, v]) => `${k}=${v}`).join(";");
}

/** uaid:aid:… — a deterministic id for an agent that has no DID of its own. */
export function createAid(input: CanonicalAgentData, params: UaidParams = {}, opts: { includeParams?: boolean } = {}): string {
  const { normalized, canonicalJson } = canonicalizeAgentData(input);
  const id = base58Encode(createHash("sha384").update(Buffer.from(canonicalJson, "utf8")).digest());
  if (opts.includeParams === false) return `uaid:aid:${id}`;
  const merged: UaidParams = {
    uid: params.uid ?? "0",
    registry: params.registry ?? normalized.registry,
    proto: params.proto,
    nativeId: params.nativeId ?? normalized.nativeId,
    domain: params.domain,
    src: params.src,
  };
  const s = paramString(merged);
  return s ? `uaid:aid:${id};${s}` : `uaid:aid:${id}`;
}

/** uaid:did:… — wraps an existing W3C DID without rehashing it. */
export function createUaidFromDid(existingDid: string, params: UaidParams = {}): string {
  let method: string, idPart: string;
  if (existingDid.startsWith("uaid:aid:")) { method = "aid"; idPart = existingDid.slice("uaid:aid:".length); }
  else if (existingDid.startsWith("did:")) {
    const first = existingDid.indexOf(":");
    const second = existingDid.indexOf(":", first + 1);
    if (second < 0) throw new Error("HCS-14: invalid DID format");
    method = existingDid.slice(first + 1, second);
    idPart = existingDid.slice(second + 1);
  } else throw new Error("HCS-14: invalid DID format");

  const cut = idPart.search(/[;?#]/);
  const sanitized = cut === -1 ? idPart : idPart.slice(0, cut);
  let finalId = sanitized;
  if (method === "hedera") {
    const m = sanitized.match(/^(mainnet|testnet|previewnet|devnet):(.+)$/);
    if (m) finalId = m[2];
  }
  const p: UaidParams = { ...params };
  if (cut !== -1 && !p.src) p.src = "z" + base58Encode(Buffer.from(existingDid, "utf8"));
  const s = paramString(p);
  return s ? `uaid:did:${finalId};${s}` : `uaid:did:${finalId}`;
}

export interface ParsedUaid { method: "aid" | "did"; id: string; params: Record<string, string> }
export function parseUaid(uaid: string): ParsedUaid {
  const m = /^uaid:(aid|did):(.+)$/.exec(uaid.trim());
  if (!m) throw new Error(`HCS-14: not a UAID: ${uaid}`);
  const [id, ...rest] = m[2].split(";");
  const params: Record<string, string> = {};
  for (const kv of rest) {
    const i = kv.indexOf("=");
    if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { method: m[1] as "aid" | "did", id, params };
}

/** Two UAIDs are the same agent when target and id match; params are routing. */
export const sameAgent = (a: string, b: string) => {
  try { const x = parseUaid(a), y = parseUaid(b); return x.method === y.method && x.id === y.id; }
  catch { return false; }
};
