# @meterx402/mcp-server

MCP (Model Context Protocol) server for MeterX402 - a pay-per-use API marketplace with metered pricing on Hedera.

## What is MeterX402?

MeterX402 enables AI agents to discover and pay for APIs based on actual usage (tokens, rows, bytes, milliseconds) rather than flat pricing. Every call is metered, priced exactly, and settled on Hedera with verification.

## Installation

```bash
npx @meterx402/mcp-server
```

Or install globally:

```bash
npm install -g @meterx402/mcp-server
```

## Quick Start

### 1. Add to your MCP client config

For **Claude Desktop**, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["-y", "@meterx402/mcp-server"],
      "env": {
        "HUB_URL": "https://meterx402.com/hub",
        "BUYER_ACCOUNT_ID": "0.0.YOUR_ACCOUNT",
        "BUYER_PRIVATE_KEY": "your-private-key",
        "BUYER_BUDGET": "1 HBAR"
      }
    }
  }
}
```

For **.mcp.json** (project-level config):

```json
{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["-y", "@meterx402/mcp-server"],
      "env": {
        "HUB_URL": "https://meterx402.com/hub",
        "BUYER_ACCOUNT_ID": "0.0.YOUR_ACCOUNT",
        "BUYER_PRIVATE_KEY": "your-private-key",
        "BUYER_BUDGET": "1 HBAR"
      }
    }
  }
}
```

### 2. Get a Hedera testnet account

```bash
# Create a new funded testnet account
npx @meterx402/mcp-server wallet new
```

This will output:
- Account ID (e.g., `0.0.12345`)
- Private key
- Testnet balance

Use these credentials in your MCP config.

### 3. Start using services

Once configured, your AI agent can:

```
You: "Find weather APIs on MeterX402"
Agent: [Uses list_services tool]

You: "Call the weather service for London"
Agent: [Uses call_service tool, pays exactly for the response size]
```

## Available Tools

### `list_services`
Discover paid services by capability, price, and reputation.

**Parameters:**
- `capability` - e.g., "weather_forecast", "text_generation", "blockchain_data"
- `query` - Free text search
- `max_price` - Maximum price filter
- `min_reputation` - Minimum reputation score (0-100)

### `get_service`
Get full details of a specific service including pricing, interfaces, and sample requests.

**Parameters:**
- `service_id` - The service identifier

### `call_service`
Call a service and pay exactly for what it uses.

**Parameters:**
- `service_id` - The service to call
- `method` - GET or POST
- `path` - Path and query string
- `body` - Request body (for POST)
- `max_units` - Cap the work (e.g., max tokens)
- `max_price` - Maximum price in HBAR

### `get_quote`
Get an exact price quote without paying yet.

**Parameters:**
- Same as `call_service`

### `pay_for_service`
Pay for a quote received from `get_quote`.

**Parameters:**
- `quote_id` - The quote to pay
- `max_price` - Optional price cap

## Environment Variables

- `HUB_URL` - MeterX402 hub URL (default: `http://localhost:4021`)
- `BUYER_ACCOUNT_ID` - Your Hedera account ID
- `BUYER_PRIVATE_KEY` - Your Hedera private key
- `BUYER_BUDGET` - Session budget (e.g., "1 HBAR", "0.5 HBAR")
- `BUYER_MAX_PER_CALL` - Optional max price per call

## How It Works

1. **Discovery**: Services register with capabilities, pricing, and reputation scores
2. **Metering**: Each API response is measured (tokens, rows, bytes, ms)
3. **Quote**: Get exact price before paying based on actual usage
4. **Settlement**: Pay via x402 protocol, settled on Hedera
5. **Verification**: Response hash is verified against the quote

## Pricing Example

```
Weather API: 0.0002 HBAR per row
Call for 48-hour forecast → 48 rows → 0.0096 HBAR
Call for 7-day forecast → 168 rows → 0.0336 HBAR

Same API, different work, different price.
vs flat pricing: every call costs the same regardless of usage
```

## Running Your Own Hub

For development or private deployment:

```bash
git clone https://github.com/clatsonhacks/meterx402
cd meterx402
npm install
npm run demo  # Live on Hedera testnet
# or
npm run demo:offline  # Mock facilitator
```

Then set `HUB_URL=http://localhost:4021` in your MCP config.

## Links

- **Hub**: https://meterx402.com
- **GitHub**: https://github.com/clatsonhacks/meterx402
- **Docs**: https://github.com/clatsonhacks/meterx402#readme

## License

MIT
