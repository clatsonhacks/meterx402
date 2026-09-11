// MeterX402 SDK: the payment layer for machine-to-machine services.
//
//   Buyer   new MeterX402({ wallet, budget, registry })      discover · quote · pay · verify
//   Seller  wrap({ upstream, wallet, capabilities })         meter + x402 around any API
//   Agent   new MeterX402Agent({ wallet, budget, registry }) discover · rank · call · tabs · A2A
//
// Protocol objects, settlement adapters and the registry client are exported
// for anyone building their own interface on top.

export { MeterX402, BudgetError, parseAmount, verify, type CallRequest, type CallResult, type PendingQuote, type Verification, type WalletConfig } from "./buyer.ts";
export { wrap, type WrapOptions, type WrappedService } from "./seller.ts";
export { MeterX402Agent, type AgentOptions, type A2AResult } from "./agent.ts";
export * from "../protocol/schemas.ts";
export { selectRoute, type SettlementAdapter, type Capability, type Route } from "../settlement/adapter.ts";
export { X402ExactAdapter } from "../settlement/x402-exact.ts";
export { rank, type Listing, type SearchFilter } from "../registry/registry.ts";
export { WEIGHTS as REPUTATION_WEIGHTS } from "../registry/reputation.ts";
export { agentCard, fetchAgentCard, a2aCall, A2A_X402_EXTENSION } from "../adapters/a2a.ts";
