# ETHGlobal ETHOnline 2026 - Integration Plan for MeterX402

> **Target Prize Pool: $43,000 across 4 sponsors**

## Executive Summary

MeterX402 is perfectly positioned to win prizes from **4 major sponsors** at ETHGlobal ETHOnline 2026. This document outlines the integration strategy to maximize prize eligibility.

**Current Strengths:**
- ✅ Already deployed on Hedera testnet
- ✅ MCP server implementation complete
- ✅ AI agent payment infrastructure built
- ✅ Service registry with reputation system
- ✅ Metered billing with x402 protocol

**What We'll Add:**
1. **Bazantic recipes** for agent-friendly API usage
2. **USDC payments** via Arc/Circle integration
3. **The Graph data** as metered services
4. **Enhanced Hedera features** for AI payments & tokenization

---

## 🎯 Sponsor #1: Bazantic - $3,000 (HIGHEST PRIORITY)

### Why This Fits Perfectly
MeterX402 **already has an MCP server** ([src/mcp.ts](src/mcp.ts)) that exposes paid APIs to AI agents. This is exactly what Bazantic wants!

### Prize Categories
1. **"Agentify New API"** - $500-$1,000
   - Create MCP servers for APIs that agents couldn't access before
2. **"Best Recipe Using Sponsor APIs"** - $200-$500
   - Build reusable recipes showing agent workflows with paid services
3. **"Help Agents Use Your Project (Continuity)"** - $500
   - Make existing MeterX402 services agent-friendly

### Implementation Plan

#### Task 1: Enhance Existing MCP Server
**File:** [src/mcp.ts](src/mcp.ts)

**Current tools:**
- `list_services` - discover paid APIs
- `get_service` - get service details
- `get_quote` - get price quote
- `pay_for_service` - execute payment
- `call_service` - call API and pay in one step
- `get_reputation` - check service reputation

**What to add:**
```typescript
// New MCP tools for Bazantic integration
interface BazanticEnhancement {
  // Tool: create_recipe
  // Allows agents to save successful API call patterns as reusable recipes
  create_recipe(params: {
    name: string;
    capability: string;
    steps: Array<{service: string; params: any}>;
    description: string;
  }): Recipe;

  // Tool: list_recipes
  // Browse community-created recipes
  list_recipes(filters: {capability?: string; author?: string}): Recipe[];

  // Tool: execute_recipe
  // Run a saved recipe with custom parameters
  execute_recipe(recipeId: string, params: any): RecipeResult;

  // Tool: publish_to_bazantic
  // Push MeterX402 services to Bazantic marketplace
  publish_to_bazantic(serviceId: string): BazanticListing;
}
```

**Files to create:**
- `src/bazantic/recipes.ts` - Recipe storage and execution engine
- `src/bazantic/marketplace.ts` - Bazantic marketplace integration
- `src/adapters/bazantic-mcp.ts` - Enhanced MCP server with Bazantic tools
- `test/bazantic.test.ts` - Recipe execution tests

#### Task 2: Create Demo Recipes
Create **5 reusable recipes** showing real-world agent workflows:

1. **"Weather-Based Trading Signal"**
   ```typescript
   // Recipe: Fetch weather data → analyze for agriculture impact → return signal
   {
     name: "weather-trading-signal",
     capability: "market_intelligence",
     steps: [
       { service: "weather_forecast", params: { location: "$input.city" } },
       { service: "llm_analysis", params: { prompt: "analyze for crop impact" } },
       { service: "market_data", params: { commodity: "wheat" } }
     ],
     cost_estimate: "0.015 HBAR"
   }
   ```

2. **"Multi-Source Data Aggregation"**
   - Combines crypto prices from CoinGecko + blockchain data + sentiment analysis

3. **"Smart API Cost Optimizer"**
   - Checks multiple services for same capability → picks cheapest with min reputation

4. **"Streaming LLM with Budget Guard"**
   - Uses MeterX402 tabs to cap LLM costs while streaming responses

5. **"Reputation-Aware Service Discovery"**
   - Agent finds best service by balancing price, reputation, and latency

#### Task 3: Bazantic Account Setup
1. Create Bazantic account
2. Setup x402/MPP gateway pointing to MeterX402 hub
3. Publish 3-5 MeterX402 services to Bazantic marketplace
4. Document integration guide for other developers

### Deliverables for Bazantic Submission
- [ ] Enhanced MCP server with recipe tools
- [ ] 5 working recipes with documentation
- [ ] Video demo showing agent using recipes (2-4 min)
- [ ] Integration guide: "How to add your API to MeterX402 + Bazantic"
- [ ] Live Bazantic account with published services

**Estimated Impact:** High chance of winning $1,000-$1,500 across multiple categories

---

## 💰 Sponsor #2: Arc (with Circle) - $10,000

### Why This Fits
Arc wants **"AI agents holding wallets making autonomous payments"** - this is literally what MeterX402 does, we just need to add USDC support!

### Prize Categories
1. **Best Agentic Economy App** - $3,500 + $2,000 mainnet bonus
2. **Best DeFi/Finance App** - $3,500 + $2,000 mainnet bonus
3. **Continuity Track** - $3,000 + $2,000 mainnet bonus

### Implementation Plan

#### Task 1: Add USDC Payment Support
**File:** [src/settlement/usdc-adapter.ts](src/settlement/usdc-adapter.ts) (NEW)

**Current:** MeterX402 only supports HBAR payments
**Add:** Circle USDC on multiple chains (Arc, Base, Ethereum)

```typescript
// New settlement adapter for USDC
export class USDCSettlementAdapter implements SettlementAdapter {
  constructor(
    private network: 'arc' | 'base' | 'ethereum',
    private circleApiKey: string
  ) {}

  async capabilities(): Promise<Capability[]> {
    return [{
      network: this.network,
      asset: 'USDC',
      currency: 'USD',
      decimals: 6,
      schemes: ['exact', 'tab']
    }];
  }

  async quote(req: QuoteRequest): Promise<AdapterQuote> {
    // Convert HBAR price to USDC
    const usdcAmount = await this.convertToUSDC(req.amount);
    return {
      amount: usdcAmount,
      atomicAmount: BigInt(Math.ceil(usdcAmount * 1_000_000)), // 6 decimals
      paymentRequirements: {
        network: this.network,
        asset: 'USDC',
        payTo: req.payTo,
        // Use Circle CCTP for cross-chain transfers
        protocol: 'circle-cctp'
      }
    };
  }

  async settle(payload: PaymentPayload): Promise<Settlement> {
    // Use Circle's Cross-Chain Transfer Protocol (CCTP)
    const transferMessage = await this.circleAPI.burnAndMint({
      amount: payload.amount,
      destinationDomain: this.getCircleDomain(this.network),
      destinationAddress: payload.payTo,
      burnToken: 'USDC'
    });

    return {
      transactionId: transferMessage.messageHash,
      network: this.network,
      confirmedAmount: payload.amount
    };
  }
}
```

**Files to create:**
- `src/settlement/usdc-adapter.ts` - USDC settlement implementation
- `src/settlement/circle-api.ts` - Circle API integration
- `src/chains/arc.ts` - Arc network configuration
- `test/usdc-settlement.test.ts` - USDC payment tests

#### Task 2: Multi-Currency Agent Wallet
**File:** [src/sdk/multi-currency-agent.ts](src/sdk/multi-currency-agent.ts) (NEW)

```typescript
export class MultiCurrencyAgent extends MeterX402Agent {
  constructor(config: {
    wallets: {
      hbar?: HederaWallet;
      usdc?: USDCWallet;
      eth?: EthereumWallet;
    };
    budgets: {
      hbar?: string;
      usdc?: string;
      eth?: string;
    };
  }) {
    super(config);
  }

  // Agent automatically picks cheapest payment method
  async call(capability: string, params?: any): Promise<CallResult> {
    const services = await this.discover({ capability });

    // Find service with best price across all currencies
    const bestOption = this.optimizePaymentRoute(services, this.wallets);

    return await this.callWithOptimalCurrency(bestOption);
  }
}
```

#### Task 3: Deploy to Arc Mainnet (for $2,000 bonus!)
1. Setup Arc RPC endpoint
2. Fund test wallet with USDC on Arc
3. Deploy MeterX402 services to Arc mainnet before **September 30, 2026**
4. Create deployment guide

**Deployment steps:**
```bash
# 1. Configure Arc network
cp .env.example .env.arc
# Add: ARC_RPC_URL, USDC_CONTRACT_ADDRESS, CIRCLE_API_KEY

# 2. Deploy services
npx mx402 publish https://api.coingecko.com/api/v3/coins/markets \
  --network arc \
  --asset USDC \
  --rate 0.002 \
  --wallet <arc-wallet>

# 3. Verify on Arc mainnet
npm run verify:arc
```

#### Task 4: Create Agentic Economy Demo
**Demo:** "AI Agent Portfolio Manager"
- Agent holds USDC wallet
- Autonomously calls multiple paid APIs:
  - Market data (CoinGecko)
  - Price predictions (LLM)
  - Trading signals
  - Risk analysis
- Agent decides which APIs to call based on USDC budget
- Real-time cost tracking and autonomous budgeting

**Files to create:**
- `examples/portfolio-agent/` - Full portfolio manager demo
- `examples/portfolio-agent/agent.ts` - Agent implementation
- `examples/portfolio-agent/README.md` - Demo guide with video

### Deliverables for Arc Submission
- [ ] USDC payment adapter working on Arc testnet
- [ ] Multi-currency agent wallet implementation
- [ ] **Arc mainnet deployment by Sept 30** (critical for $2,000 bonus!)
- [ ] Portfolio manager demo with live USDC payments
- [ ] Architecture diagram showing USDC flow
- [ ] Demo video (2-4 min)
- [ ] GitHub repo with full source code

**Estimated Impact:** $5,500-$7,500 (high probability with mainnet deployment)

---

## 📊 Sponsor #3: The Graph - $15,000

### Why This Fits
The Graph wants **"AI tooling with composable data infrastructure"** - we can wrap Graph data queries as metered MeterX402 services!

### Prize Categories
1. **Best AI Tooling (From Scratch)** - $5,000
2. **Best Use of Composable Products** - $5,000
3. **Best AI Tooling (Continuity)** - $5,000

### Implementation Plan

#### Task 1: The Graph Service Gateway
**File:** [src/adapters/thegraph.ts](src/adapters/thegraph.ts) (NEW)

Wrap The Graph's 15,000+ subgraphs as metered MeterX402 services:

```typescript
export class TheGraphGateway {
  // Discovers available subgraphs by topic
  async discoverSubgraphs(topic: string): Promise<Subgraph[]> {
    // Query The Graph's subgraph registry
    const subgraphs = await this.graphClient.query(`
      {
        subgraphs(where: {categories_contains: ["${topic}"]}) {
          id
          displayName
          description
          currentVersion {
            subgraphDeployment {
              ipfsHash
            }
          }
        }
      }
    `);

    // Register each subgraph as a MeterX402 service
    return subgraphs.map(sg => this.registerAsService(sg));
  }

  // Wraps Graph query as metered service
  async wrapSubgraph(subgraphId: string): Promise<Service> {
    return await wrap({
      upstream: `https://gateway.thegraph.com/api/${subgraphId}`,
      capabilities: ['blockchain_data', 'subgraph_query'],
      meter: 'rows', // Meter by number of entities returned
      rate: 0.0001, // HBAR or USDC per row
      wallet: config.WALLET,
      // Natural language interface via LLM
      enableNaturalLanguage: true
    });
  }
}
```

#### Task 2: Natural Language Query Interface (MCP Tool)
**File:** [src/mcp-tools/graph-nl-query.ts](src/mcp-tools/graph-nl-query.ts) (NEW)

```typescript
// MCP tool: query_blockchain_data
// Agents can query blockchain data using natural language
export async function queryBlockchainDataNL(params: {
  question: string;  // e.g., "What are the top 10 Uniswap pools by TVL?"
  maxCost?: number;  // Budget limit
}): Promise<GraphQueryResult> {
  // 1. Convert natural language to GraphQL query using LLM
  const graphQLQuery = await this.llm.generateQuery({
    prompt: params.question,
    schema: await this.graphClient.getSchema()
  });

  // 2. Estimate query cost (rows returned × rate)
  const estimate = await this.estimateQueryCost(graphQLQuery);
  if (estimate > params.maxCost) {
    throw new BudgetExceededError();
  }

  // 3. Execute via MeterX402 with metered billing
  const result = await this.mx402Agent.call('subgraph_query', {
    query: graphQLQuery
  });

  // 4. Return data + receipt
  return {
    data: result.data,
    cost: result.receipt.amount,
    query: graphQLQuery
  };
}
```

#### Task 3: Multi-Source Data Composition
Show how MeterX402 + The Graph enables composable data infrastructure:

**Example Recipe:** "DeFi Protocol Risk Score"
```typescript
// Composes data from multiple Graph subgraphs + external APIs
async function calculateProtocolRisk(protocol: string): Promise<RiskScore> {
  // Parallel queries across multiple data sources
  const [tvlData, volumeData, govData, priceData] = await Promise.all([
    mx402.call('uniswap-v3-subgraph', { protocol }),  // The Graph
    mx402.call('dex-analytics-subgraph', { protocol }), // The Graph
    mx402.call('governance-subgraph', { protocol }),    // The Graph
    mx402.call('market_data', { token: protocol.token }) // External API
  ]);

  // Composite analysis
  const risk = analyzeRisk({tvlData, volumeData, govData, priceData});

  // Total cost = sum of all metered calls
  console.log(`Total cost: ${sum(receipts)} HBAR`);

  return risk;
}
```

**Files to create:**
- `src/adapters/thegraph.ts` - The Graph integration
- `src/mcp-tools/graph-nl-query.ts` - Natural language query tool
- `examples/graph-defi-analytics/` - Multi-subgraph composition demo
- `test/thegraph.test.ts` - Graph query metering tests

#### Task 4: The Graph MCP Server
Package everything as a standalone MCP server that Claude Desktop can use:

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "meterx402-graph": {
      "command": "npx",
      "args": ["mx402", "mcp", "--enable-graph", "--budget", "1.0"],
      "env": {
        "GRAPH_API_KEY": "your-key",
        "MX402_WALLET": "0.0.1234"
      }
    }
  }
}
```

### Deliverables for The Graph Submission
- [ ] The Graph gateway wrapping 10+ popular subgraphs
- [ ] Natural language query MCP tool
- [ ] Multi-source data composition examples
- [ ] Standalone MCP server package
- [ ] Demo: "Ask blockchain questions in plain English, pay only for data retrieved"
- [ ] Demo video (2-4 min)
- [ ] Public repository with live data consumption

**Estimated Impact:** $7,000-$10,000 (strong fit for both AI tooling categories)

---

## ⚡ Sponsor #4: Hedera - $15,000

### Why This Fits
MeterX402 **already runs on Hedera!** We just need to showcase it better and add more Hedera-specific features.

### Prize Categories
1. **AI & Agentic Payments** - $6,000 (3 teams × $2,000)
2. **Tokenization of Assets** - $6,000 (3 teams × $2,000)
3. **Hedera Harness Improvements** - $2,000
4. **Continuity Track** - $1,000

### Current Hedera Integration ✅
- Settlement via x402 on Hedera testnet
- HCS (Hedera Consensus Service) receipts
- Native HBAR allowances for Metered Tabs
- Mirror node verification
- HCS-14 Universal Agent IDs

### Enhancement Plan

#### Task 1: Enhanced AI Agent Payment Examples
**File:** [examples/hedera-ai-agents/](examples/hedera-ai-agents/) (NEW)

Create 3 compelling demos:

**Demo 1: "Autonomous Research Agent"**
```typescript
// Agent autonomously spends HBAR budget on research APIs
const agent = new MeterX402Agent({
  wallet: hederaWallet,
  budget: "5 HBAR", // ~$0.25 at current prices
  network: 'hedera',
  useTabs: { allowance: "0.5 HBAR" } // Fast repeated calls
});

// Agent decides what to research based on user query
const research = await agent.research({
  topic: "Hedera DeFi ecosystem growth",
  sources: ["market_data", "blockchain_analytics", "news_sentiment"],
  maxCost: "2 HBAR"
});

// Agent paid for 15 API calls automatically:
// - CoinGecko: 0.32 HBAR
// - LLM analysis: 0.89 HBAR
// - Blockchain data: 0.54 HBAR
// Total: 1.75 HBAR, all settled on Hedera in 2 transactions
```

**Demo 2: "Multi-Agent Collaboration"**
```typescript
// Multiple AI agents collaborate and pay each other via Hedera
const coordinator = new MeterX402Agent({ wallet: wallet1 });
const analyst = new MeterX402Agent({ wallet: wallet2 });
const writer = new MeterX402Agent({ wallet: wallet3 });

// Coordinator hires other agents via A2A + Hedera payments
const analysis = await coordinator.a2a(analyst.endpoint, {
  task: "analyze market trends",
  budget: "0.5 HBAR"
}); // Settled on Hedera

const report = await coordinator.a2a(writer.endpoint, {
  task: "write report from analysis",
  data: analysis,
  budget: "0.3 HBAR"
}); // Settled on Hedera

// 3 agents, 2 inter-agent payments, all on Hedera
```

**Demo 3: "Streaming LLM with Hedera Tabs"**
```typescript
// Use Hedera allowances for fast streaming with cost cap
const tab = await agent.openTab('llm_service', {
  allowance: "0.1 HBAR" // Hedera enforces this limit
});

// Stream tokens with live metering
const stream = await agent.callStreaming('llm_service', {
  prompt: "Explain Hedera consensus",
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.content);
  // Live cost updates: "0.0043 HBAR spent, 0.0957 remaining"
}

// Settled in single Hedera transaction when stream ends
```

#### Task 2: Asset Tokenization Demo
**File:** [examples/api-tokenization/](examples/api-tokenization/) (NEW)

**Concept:** Tokenize API access rights as HTS (Hedera Token Service) tokens

```typescript
// Create API Access Token on Hedera
const apiToken = await hederaClient.createToken({
  name: "Weather API Credits",
  symbol: "WTHR",
  decimals: 0,
  initialSupply: 10000,
  customFees: [{
    feeCollectorAccountId: config.TREASURY,
    feeAmount: 1 // 1 token = 100 API calls
  }]
});

// Users buy tokens, redeem for API access
const buyer = await BuyAPITokens({
  token: apiToken.tokenId,
  amount: 10, // 10 tokens = 1000 API calls
  payWith: "HBAR"
});

// MeterX402 accepts tokens as payment
await mx402.call('weather_forecast', {
  params: { location: "London" },
  payWith: { token: apiToken.tokenId, amount: 0.01 }
});
```

**Real-world use case:** API subscriptions as tradeable HTS tokens

#### Task 3: Hedera Harness Integration
**File:** [src/test-utils/hedera-harness.ts](src/test-utils/hedera-harness.ts) (NEW)

Improve Hedera's testing framework with MeterX402 test utilities:

```typescript
export class MeterX402HarnessIntegration {
  // Add MeterX402 scenarios to Hedera Harness
  async setupTestScenario(harness: HederaHarness): Promise<TestEnv> {
    // 1. Create test accounts with HBAR
    const seller = await harness.createAccount({ balance: "10 HBAR" });
    const buyer = await harness.createAccount({ balance: "5 HBAR" });

    // 2. Deploy MeterX402 service
    const service = await harness.deployService({
      type: 'mx402-gateway',
      config: { wallet: seller, rate: 0.001 }
    });

    // 3. Setup allowance for tabs
    await harness.approveAllowance({
      owner: buyer,
      spender: service.spenderAccount,
      amount: "1 HBAR"
    });

    return { seller, buyer, service };
  }

  // Test suite: verify metered payments on Hedera
  async runMeteringTests(harness: HederaHarness): Promise<TestResults> {
    // Tests: quote, pay, settle, verify on mirror node
  }
}
```

### Deliverables for Hedera Submission
- [ ] 3 AI agent payment demos (research, collaboration, streaming)
- [ ] API tokenization demo with HTS tokens
- [ ] Hedera Harness integration and test suite
- [ ] Performance benchmarks (3-5s settlement, 10ms with tabs)
- [ ] Demo video showing all features (5 min max)
- [ ] Testnet deployment with public mirror node receipts
- [ ] GitHub repo with Hedera-specific examples

**Estimated Impact:** $8,000-$10,000 (already built on Hedera, just needs showcasing)

---

## 📋 Unified Architecture: All 4 Sponsors Together

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AI AGENT LAYER                                │
│  (Claude, GPT-4, Custom Agents using MCP or A2A protocol)           │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 METERX402 INTEGRATION LAYER                          │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Bazantic   │  │  The Graph   │  │     Arc      │              │
│  │ MCP Recipes  │  │  Data Layer  │  │ USDC Payment │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┴──────────────────┘                      │
│                             │                                         │
│                ┌────────────▼────────────┐                           │
│                │  MeterX402 Core Engine   │                           │
│                │  - Service Discovery     │                           │
│                │  - Metering & Pricing    │                           │
│                │  - Quote & Budget Check  │                           │
│                │  - Reputation System     │                           │
│                └────────────┬────────────┘                           │
└─────────────────────────────┼────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    HEDERA BLOCKCHAIN LAYER                           │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │ HBAR Payment │  │ USDC Payment │  │  HTS Tokens  │              │
│  │  (x402)      │  │ (Circle CCTP)│  │ (API Credits)│              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                  │                  │                       │
│         └──────────────────┴──────────────────┘                      │
│                             │                                         │
│  ┌──────────────────────────▼──────────────────────────┐            │
│  │        Hedera Consensus & Settlement                │            │
│  │  - HCS Receipts (0.0.10470327)                      │            │
│  │  - Mirror Node Verification                         │            │
│  │  - Native Allowances (Tabs)                         │            │
│  │  - 3-second finality, 10,000+ TPS                   │            │
│  └─────────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

### Integration Flow Example

**Scenario:** Agent needs blockchain data analysis

```typescript
// 1. Agent asks in natural language (Bazantic recipe)
const agent = new MultiCurrencyAgent({
  wallets: { hbar: hederaWallet, usdc: usdcWallet },
  budgets: { hbar: "2 HBAR", usdc: "5 USDC" }
});

// 2. Execute Bazantic recipe: "blockchain-analytics"
const result = await agent.executeRecipe('blockchain-analytics', {
  protocol: 'uniswap-v3',
  metric: 'tvl-change-24h'
});

// Behind the scenes:
// Step 1: Query The Graph (Uniswap V3 subgraph)
//   → Metered: 48 rows returned
//   → Cost: 0.0048 HBAR
//   → Settled on Hedera in 3 seconds

// Step 2: Get price data from CoinGecko
//   → Metered: 5 rows returned
//   → Cost: $0.01 USDC
//   → Paid via Arc/Circle CCTP

// Step 3: LLM analysis
//   → Metered: 342 tokens generated
//   → Cost: 0.0342 HBAR
//   → Settled on Hedera via tab (< 10ms)

// Total cost: 0.039 HBAR + $0.01 USDC
// All receipts on Hedera HCS
// All payments verified on mirror node
// Recipe saved to Bazantic for reuse
```

**This single flow demonstrates ALL 4 sponsors!**

---

## 🗓️ Implementation Timeline

### Week 1 (Sept 13-19): Bazantic Integration
- [ ] Day 1-2: Enhance MCP server with recipe tools
- [ ] Day 3-4: Create 5 demo recipes
- [ ] Day 5-6: Setup Bazantic account and publish services
- [ ] Day 7: Record demo video

### Week 2 (Sept 20-26): Arc/USDC Integration
- [ ] Day 1-3: Implement USDC settlement adapter
- [ ] Day 4-5: Build multi-currency agent wallet
- [ ] Day 6-7: Create portfolio manager demo

### Week 3 (Sept 27-Oct 3): The Graph Integration
- [ ] Day 1-3: Build The Graph gateway
- [ ] Day 4-5: Natural language query interface
- [ ] Day 6-7: Multi-source composition examples

### Week 4 (Oct 4-10): Hedera Showcase + Polish
- [ ] Day 1-3: Create 3 AI agent demos
- [ ] Day 4-5: Asset tokenization example
- [ ] Day 6: Hedera Harness integration
- [ ] Day 7: Final testing and documentation

### Week 5 (Oct 11-17): Arc Mainnet Deployment
- [ ] **Deploy to Arc mainnet by Sept 30** for $2,000 bonus!
- [ ] Integration testing
- [ ] Record all demo videos
- [ ] Write submission documentation

---

## 📦 Deliverables Checklist

### Code
- [ ] `src/bazantic/` - Recipe engine and marketplace integration
- [ ] `src/settlement/usdc-adapter.ts` - USDC payments
- [ ] `src/adapters/thegraph.ts` - The Graph integration
- [ ] `examples/hedera-ai-agents/` - 3 Hedera demos
- [ ] `examples/portfolio-agent/` - Arc agentic economy demo
- [ ] `examples/graph-defi-analytics/` - The Graph composition demo
- [ ] `test/` - Comprehensive test suite for all integrations

### Documentation
- [ ] [README.md](README.md) - Updated with all integrations
- [ ] `INTEGRATION_GUIDE.md` - How to use each sponsor integration
- [ ] `DEPLOYMENT.md` - Arc mainnet deployment guide
- [ ] Architecture diagrams for each sponsor

### Videos (2-4 min each)
- [ ] Bazantic: "AI Agent Using Paid API Recipes"
- [ ] Arc: "Autonomous Portfolio Manager with USDC"
- [ ] The Graph: "Natural Language Blockchain Queries"
- [ ] Hedera: "Multi-Agent Collaboration on Hedera"

### Live Deployments
- [ ] Hedera testnet (already deployed ✅)
- [ ] Arc mainnet (by Sept 30 for bonus!)
- [ ] The Graph gateway (live data consumption)
- [ ] Bazantic marketplace (published services)

---

## 💡 Prize Probability Estimate

| Sponsor | Prize Pool | Our Target | Probability | Expected Value |
|---------|-----------|------------|-------------|----------------|
| Bazantic | $3,000 | $1,000-1,500 | 80% | $1,000 |
| Arc | $10,000 | $5,500-7,500 | 70% | $4,500 |
| The Graph | $15,000 | $7,000-10,000 | 60% | $5,000 |
| Hedera | $15,000 | $8,000-10,000 | 75% | $6,750 |
| **TOTAL** | **$43,000** | **$21,500-29,000** | **71% avg** | **$17,250** |

**Strong differentiation:**
- Only project integrating ALL 4 sponsors together
- Already has working Hedera deployment (head start!)
- Solves real problem: metered API payments for AI agents
- Composable architecture shows technical depth

---

## 🚀 Getting Started

### Setup Development Environment

```bash
# Clone and setup
git clone <your-repo>
cd meterx402
npm install

# Setup environment variables
cp .env.example .env
# Add: HEDERA_WALLET, CIRCLE_API_KEY, GRAPH_API_KEY, BAZANTIC_TOKEN

# Run tests
npm test

# Start development mode
npm run demo:offline  # Local testing
npm run demo          # Live Hedera testnet
```

### Test Each Integration

```bash
# Test Bazantic recipes
npx tsx examples/bazantic-demo.ts

# Test USDC payments
npx tsx examples/usdc-payment-demo.ts

# Test The Graph queries
npx tsx examples/graph-nl-query-demo.ts

# Test Hedera AI agents
npx tsx examples/hedera-ai-agents/research-agent.ts
```

---

## 📞 Support & Resources

- **ETHGlobal Discord:** Get help from sponsors
- **MeterX402 Docs:** [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md)
- **Sponsor Documentation:**
  - [Bazantic Docs](https://bazantic.io/docs)
  - [Arc Docs](https://docs.arc.xyz)
  - [The Graph Docs](https://thegraph.com/docs)
  - [Hedera Docs](https://docs.hedera.com)

---

**Next Steps:** Start with Bazantic integration (highest ROI, builds on existing MCP server)
