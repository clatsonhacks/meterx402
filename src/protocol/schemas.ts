// MeterX402 protocol objects, v1.
//
// Every interface (REST, A2A, MCP, SDK) speaks in these five objects, so a
// service published once is described, quoted, authorised, settled and rated
// the same way no matter how a buyer reaches it:
//
//   ServiceDescriptor     what a service is, how it's priced, how it can be paid
//   PaymentQuote          the exact price of one metered response, before payment
//   PaymentAuthorization  the spending constraints a buyer approved
//   SettlementReceipt     proof of what was paid, for what, and where it settled
//   ReputationRecord      a deterministic score from settlement + performance evidence
//
// They are validated with zod at every boundary where data comes from someone
// else (registry publishes, gateway descriptors, A2A metadata).

import { z } from "zod";

export const PROTOCOL_VERSION = "1";

const decimal = z.string().regex(/^\d+(\.\d+)?$/, "a non-negative decimal string");
const network = z.string().regex(/^[a-z0-9-]+:[A-Za-z0-9-]+$/, "a CAIP-2 network id, e.g. hedera:testnet");

// ── ServiceDescriptor ─────────────────────────────────────────────────────

export const SettlementOption = z.object({
  network,
  asset: z.string(),                   // "0.0.0" = HBAR, an HTS token id, an ERC-20 address…
  currency: z.string(),                // what humans call it: HBAR, USDC
  decimals: z.number().int().min(0),
  schemes: z.array(z.enum(["exact", "tab"])).min(1),
  facilitator: z.string().optional(),
  /** A fee the LEDGER assesses on every transfer of this asset (HTS custom
   *  fee schedule). Disclosed so a buyer knows what the seller actually nets;
   *  it is not added to the price, and no code here collects it. */
  fee: z.object({
    percent: decimal,
    collector: z.string(),
    assessment: z.enum(["inclusive", "exclusive"]),
    source: z.literal("hts-custom-fee"),
  }).optional(),
});
export type SettlementOption = z.infer<typeof SettlementOption>;

export const ServiceDescriptor = z.object({
  mx402: z.literal(PROTOCOL_VERSION),
  service_id: z.string().regex(/^[a-z0-9][a-z0-9-_.]{0,62}$/, "lowercase slug"),
  name: z.string().min(1),
  description: z.string().optional(),
  /** HCS-14 Universal Agent ID: the same agent across Web2, EVM and Hedera.
   *  Derived from what the agent IS (registry, name, version, protocol,
   *  account, skills), never from where it is hosted or what it charges. */
  uaid: z.string().regex(/^uaid:(aid|did):/).optional(),
  type: z.enum(["rest", "graphql", "llm", "mcp", "a2a"]),
  endpoint: z.string().url(),          // the payment-enabled base URL buyers call
  sample: z.object({ method: z.string(), path: z.string(), body: z.string().optional() }).optional(),
  capabilities: z.array(z.string().min(1)).min(1),
  pricing: z.object({
    meter: z.string(),                 // tokens | rows:<path> | bytes | ms | json:<path> | request
    unit: z.string(),
    rate: decimal,                     // price per `per` units
    per: z.number().positive(),
    min: decimal,
    free: z.number().int().min(0),
    max_units: z.number().positive().nullable(),
    currency: z.string(),
  }),
  payment: z.object({
    protocol: z.literal("x402"),
    settlement: z.array(SettlementOption).min(1),
    streaming: z.boolean(),            // only ever true where tabs are offered
    /** Pre-signed future payments (Hedera scheduled transactions). Unlike an
     *  allowance, these are commitments the seller can count before they land. */
    subscription: z.object({
      price: decimal,                  // per period
      period_sec: z.number().int().positive(),
      max_periods: z.number().int().positive(),
      includes_units: z.number().int().nonnegative().nullable(),
      open: z.string().url(),
    }).optional(),
  }),
  interfaces: z.array(z.enum(["rest", "graphql", "a2a", "mcp", "sdk"])).min(1),
  auth: z.object({
    // how the UPSTREAM authenticates; the key is held by the seller's gateway,
    // so buyers never need it
    type: z.enum(["none", "api-key", "bearer", "header"]),
    held_by: z.literal("seller"),
  }),
  owner: z.object({ account: z.string(), network }),
  links: z.object({
    descriptor: z.string().url(),
    a2a_card: z.string().url().optional(),
    tab: z.string().url().optional(),
  }),
  published_at: z.string(),
});
export type ServiceDescriptor = z.infer<typeof ServiceDescriptor>;

// ── PaymentQuote ──────────────────────────────────────────────────────────

export const PaymentQuote = z.object({
  mx402: z.literal(PROTOCOL_VERSION),
  quote_id: z.string(),
  service_id: z.string(),
  scheme: z.literal("exact"),
  meter: z.string(),
  unit: z.string(),
  units: z.number().min(0),            // billable
  measured: z.number().min(0),         // what the meter counted, before caps
  cap: z.number().nullable(),
  rate: decimal,
  per: z.number().positive(),
  amount: decimal,
  amount_atomic: z.string().regex(/^\d+$/),
  currency: z.string(),
  network,
  asset: z.string(),
  pay_to: z.string(),
  body_sha256: z.string().regex(/^[0-9a-f]{64}$/),  // the quote commits to the response
  expires_at: z.number().int(),
});
export type PaymentQuote = z.infer<typeof PaymentQuote>;

// ── PaymentAuthorization ──────────────────────────────────────────────────

export const PaymentAuthorization = z.object({
  mx402: z.literal(PROTOCOL_VERSION),
  kind: z.enum(["exact", "tab"]),
  buyer: z.string(),
  service_id: z.string(),
  network,
  // the constraints the buyer set; whichever are present are enforced
  max_per_call: decimal.optional(),
  max_units: z.number().positive().optional(),
  budget: decimal.optional(),
  allowance: decimal.optional(),      // tabs: the on-chain allowance
  expires_at: z.number().int().optional(),
  quote_id: z.string().optional(),     // exact: the quote being paid
  tab_id: z.string().optional(),       // tab: the session
  authorized_at: z.number().int(),
});
export type PaymentAuthorization = z.infer<typeof PaymentAuthorization>;

// ── SettlementReceipt ─────────────────────────────────────────────────────

export const SettlementReceipt = z.object({
  mx402: z.literal(PROTOCOL_VERSION),
  receipt_id: z.string(),
  scheme: z.enum(["exact", "tab", "subscription"]),
  quote_id: z.string().nullable(),
  tab_id: z.string().nullable(),
  subscription_id: z.string().nullable().optional(),  // subscription: the period's commitment
  service_id: z.string(),
  buyer: z.string(),
  seller: z.string(),
  metered_units: z.number().min(0),
  unit: z.string(),
  rate: decimal,
  per: z.number().positive(),
  amount: decimal,
  amount_atomic: z.string().regex(/^\d+$/),
  currency: z.string(),
  network,
  // null while a tab call is metered but not yet in a settled batch
  transaction_id: z.string().nullable(),
  body_sha256: z.string().nullable(),
  settled_at: z.number().int(),
});
export type SettlementReceipt = z.infer<typeof SettlementReceipt>;

// ── ReputationRecord ──────────────────────────────────────────────────────

export const ReputationComponents = z.object({
  execution: z.number().min(0).max(1),
  response_success: z.number().min(0).max(1),
  latency: z.number().min(0).max(1),
  disputes: z.number().min(0).max(1),
  uptime: z.number().min(0).max(1),
  payment_reliability: z.number().min(0).max(1),
});
export type ReputationComponents = z.infer<typeof ReputationComponents>;

export const ReputationRecord = z.object({
  mx402: z.literal(PROTOCOL_VERSION),
  service_id: z.string(),
  score: z.number().min(0).max(100).nullable(), // null = not enough evidence to rank
  confidence: z.enum(["none", "low", "medium", "high"]),
  sample_size: z.number().int().min(0),
  components: ReputationComponents,
  weights: ReputationComponents,
  stats: z.object({
    calls: z.number().int(),
    paid_calls: z.number().int(),
    revenue: z.number(),
    upstream_calls: z.number().int(),
    upstream_errors: z.number().int(),
    settle_attempts: z.number().int(),
    settle_failures: z.number().int(),
    disputes: z.number().int(),
    median_latency_ms: z.number().nullable(),
    p90_latency_ms: z.number().nullable(),
    uptime_ratio: z.number().nullable(),
      // quote rounds this service was asked into, answered, and won
    quote_rounds: z.number().int().nonnegative().default(0),
    quotes_offered: z.number().int().nonnegative().default(0),
    quote_rounds_won: z.number().int().nonnegative().default(0),
}),
  computed_at: z.number().int(),
  anchor: z.object({ topic_id: z.string(), transaction_id: z.string(), digest: z.string() }).optional(),
});
export type ReputationRecord = z.infer<typeof ReputationRecord>;

// ── Dispute (Phase 9: verifiable metering) ────────────────────────────────

export const Dispute = z.object({
  mx402: z.literal(PROTOCOL_VERSION),
  service_id: z.string(),
  quote_id: z.string().nullable(),
  receipt_id: z.string().nullable(),
  buyer: z.string(),
  reason: z.enum(["body_hash_mismatch", "units_mismatch", "not_delivered"]),
  claimed_units: z.number().nullable(),
  observed_units: z.number().nullable(),
  body_sha256_claimed: z.string().nullable(),
  body_sha256_observed: z.string().nullable(),
  filed_at: z.number().int(),
});
export type Dispute = z.infer<typeof Dispute>;

// helpers ---------------------------------------------------------------

/** Base64url JSON, for carrying a protocol object in a single HTTP header. */
export const encodeHeader = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
export const decodeHeader = <T>(value: string | null | undefined, schema: z.ZodType<T>): T | null => {
  if (!value) return null;
  try { return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); } catch { return null; }
};
