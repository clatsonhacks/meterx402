# Quick Start Guide - MeterX402 VSCode Extension

## Installation & Setup (2 minutes)

### 1. Start the MeterX402 Hub

First, ensure the MeterX402 hub is running:

```bash
# In the main meterx402 directory
npm install
npm run hub
```

The hub will start on `http://localhost:4021`

### 2. Install the Extension

**Option A: From Development (Recommended for testing)**
```bash
cd vscode-extension
npm install
npm run compile
```

Then press `F5` in VSCode to launch Extension Development Host.

**Option B: Install VSIX Package**
```bash
cd vscode-extension
npm install
npm run package
# Then: Extensions → Install from VSIX → select meterx402-0.1.0.vsix
```

### 3. Start your connector (pays with your own account)

Add your own Hedera testnet account (free at portal.hedera.com) to your workspace `.env`:

```
BUYER_ACCOUNT_ID=0.0.your-account
BUYER_PRIVATE_KEY=your-testnet-private-key
BUYER_BUDGET=1 HBAR
```

Then run **MeterX402: Start My Connector** from the Command Palette. Calls are paid through it,
from your account, inside your budget. Settings (search "meterx402"): Hub URL
(`http://localhost:4021`), Connector URL (`http://localhost:3402`), Max Per Call.

## Using the Extension

### Browse & Search Services

1. Click the **MeterX402** icon in the Activity Bar (sidebar)
2. Click the **Search** icon in the Services view
3. Enter a search term (e.g., "weather", "llm", "crypto")
4. Browse the results with pricing and reputation

### Call a Service

1. Click on any service in the list
2. Enter the API path (e.g., `/?latitude=51.5&longitude=-0.1`)
3. Set your max price (default: 0.1 HBAR)
4. View the result in a new JSON editor

### Publish a Dataset

**Right from the File Explorer:**

1. Right-click any `.csv`, `.json`, or `.jsonl` file
2. Select **"MeterX402: Publish Dataset"**
3. Enter:
   - Payout wallet (your Hedera account)
   - Price per row (e.g., 0.0001 HBAR)
   - Dataset title
4. Done! Your dataset is now earning money

**Example with test data:**
```bash
# Create a sample dataset
echo "city,temp,humidity
London,15,75
Paris,18,65
Tokyo,22,55" > weather.csv

# Right-click weather.csv → "MeterX402: Publish Dataset"
```

## Quick Examples

### Example 1: Search for Weather APIs

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type: `MeterX402: Search Services`
3. Enter: `weather`
4. See all weather APIs with pricing

### Example 2: Call a Service

```
1. Select service: "Weather Forecast"
2. Path: /?latitude=40.7128&longitude=-74.0060
3. Max price: 0.01 HBAR
4. Result: JSON weather data for New York
```

### Example 3: Publish Your Dataset

```bash
# You have: cities.csv (1000 rows)
# Right-click → Publish Dataset
# Price: 0.0001 HBAR per row
# Buyers pay: 0.1 HBAR for all 1000 rows
```

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Command Palette | `Ctrl+Shift+P` / `Cmd+Shift+P` |
| Search Services | No default (assign in Keyboard Shortcuts) |
| Open Dashboard | Click status bar item |

## Status Bar

Look for the **MeterX402** item in the bottom-right status bar:
- Click it to open the web dashboard
- Shows connection status

## Troubleshooting

### "Failed to load services"

**Solution:** Ensure the hub is running:
```bash
npm run hub
```

### "No wallet configured"

**Solution:** Either:
1. Use the playground mode (works without wallet)
2. Configure wallet in settings (for real transactions)

### Services list is empty

**Solution:**
1. Click the refresh icon
2. Check hub URL in settings
3. Ensure hub has registered services

## Next Steps

- Explore the [full documentation](README.md)
- Read the [development guide](DEVELOPMENT.md)
- Join the community on Discord
- Browse services at http://localhost:4021

## Tips

💡 **Spending Limits**: The extension respects your `maxPerCall` setting. Nothing above this amount will be signed.

💡 **Dataset Preview**: The `/schema` endpoint is always free, so buyers can preview your data before paying.

💡 **Reputation**: Higher reputation services appear first. Reputation is computed from real payment history.

💡 **Multiple Formats**: You can publish CSV, JSON, and JSONL datasets. All are automatically typed and queryable.

## Need Help?

- Check the [README](README.md) for detailed documentation
- Open an issue on GitHub
- Ask in our Discord community
