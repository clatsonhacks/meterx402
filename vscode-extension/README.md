# MeterX402 VSCode Extension

Browse, call, and publish metered APIs directly from Visual Studio Code. Pay only for what you use.

## Features

### 🔍 **Browse Services**
- Search for metered APIs (weather, AI/LLM, blockchain data, etc.)
- View pricing, reputation, and capabilities
- Filter by category or search term

### ⚡ **Call Services**
- Call any MeterX402 service with one click
- See exact price before paying
- Results displayed in JSON editor
- Automatic spending limits

### 📊 **Publish Datasets**
- Right-click any CSV, JSON, or JSONL file
- Select "Publish Dataset" to sell it
- Buyers pay per row/cell they retrieve
- Schema and samples are always free

### 💼 **Manage Your Services**
- View your published APIs and datasets
- Monitor earnings and usage
- Access full dashboard

## Installation

1. Install the extension from the VSCode Marketplace
2. Open the MeterX402 sidebar (click the icon in the activity bar)
3. Configure your settings (optional):
   - Hub URL (default: http://localhost:4021)
   - Buyer account credentials
   - Spending limits

## Quick Start

### As a Buyer

1. **Search for services:**
   - Click the search icon in the MeterX402 sidebar
   - Enter a capability (e.g., "weather", "llm", "crypto")

2. **Call a service:**
   - Click on any service in the list
   - Enter the API path and parameters
   - Set your maximum price
   - View results instantly

### As a Seller

1. **Publish a dataset:**
   - Right-click any `.csv`, `.json`, or `.jsonl` file in Explorer
   - Select "MeterX402: Publish Dataset"
   - Enter your payout wallet
   - Set price per row
   - Done! Your data is now earning

2. **Publish an API:**
   - Open Command Palette (`Ctrl+Shift+P`)
   - Run "MeterX402: Publish API"
   - Or use the full web dashboard for more options

## Commands

| Command | Description |
|---------|-------------|
| `MeterX402: Search Services` | Search for metered APIs |
| `MeterX402: Refresh Services` | Reload the services list |
| `MeterX402: Call Service` | Call a selected service |
| `MeterX402: Publish Dataset` | Publish a CSV/JSON file as a metered API |
| `MeterX402: Publish API` | Publish your API endpoint |
| `MeterX402: View Wallet` | Check balance and spending limits |
| `MeterX402: Open Dashboard` | Open the web dashboard |

## Settings

Configure the extension in VSCode settings:

```json
{
  "meterx402.hubUrl": "http://localhost:4021",
  "meterx402.buyerAccountId": "0.0.xxxxx",
  "meterx402.maxPerCall": "0.1",
  "meterx402.budget": "1"
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `hubUrl` | MeterX402 hub URL | `http://localhost:4021` |
| `buyerAccountId` | Your Hedera account ID | - |
| `buyerPrivateKey` | Your private key (secure) | - |
| `maxPerCall` | Max HBAR per API call | `0.1` |
| `budget` | Total HBAR budget | `1` |

## Requirements

- MeterX402 hub running locally or accessible remotely
- Hedera testnet account (for transactions)
- Node.js 18+ (if running hub locally)

## How It Works

MeterX402 meters APIs by what each call actually uses:
- **LLMs**: Tokens generated
- **Datasets**: Rows/cells returned
- **APIs**: Bytes, milliseconds, or requests

Payments settle on Hedera with exact pricing. No subscriptions, no flat fees—just usage-based billing.

## Support

- **Documentation**: [MeterX402 Docs](https://github.com/yourusername/meterx402)
- **Issues**: [GitHub Issues](https://github.com/yourusername/meterx402/issues)
- **Discord**: Join our community

## License

MIT License - See LICENSE file for details
