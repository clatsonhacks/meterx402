# Publishing MeterX402 MCP Server

## Package Created ✅

The `@meterx402/mcp-server` package is ready at `packages/mcp-server/`

## How to Publish to npm

### 1. Test locally first

```bash
cd packages/mcp-server
npm link
```

Then in any MCP config, use:
```json
{
  "mcpServers": {
    "meterx402": {
      "command": "meterx402-mcp",
      "args": []
    }
  }
}
```

### 2. Publish to npm

```bash
cd packages/mcp-server

# Login to npm (one time)
npm login

# Publish
npm publish --access public
```

After publishing, anyone can use:
```bash
npx @meterx402/mcp-server
```

## How LLMs Will Use It

### Claude Desktop

Users add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["-y", "@meterx402/mcp-server"],
      "env": {
        "HUB_URL": "https://meterx402.com/hub",
        "BUYER_ACCOUNT_ID": "0.0.12345",
        "BUYER_PRIVATE_KEY": "302e...",
        "BUYER_BUDGET": "1 HBAR"
      }
    }
  }
}
```

### Any MCP Client

The package works with any MCP-compatible client:
- Claude Desktop
- Claude Code
- Continue.dev
- Any custom MCP client

## What's Included

The package bundles:
- ✅ MCP server implementation (`src/mcp.ts`)
- ✅ All MeterX402 SDK functionality
- ✅ Connection to the hub
- ✅ Payment capabilities
- ✅ Service discovery
- ✅ Reputation checking

## Available Tools

Once installed, LLMs get these tools:
- `list_services` - Browse the marketplace
- `get_service` - Get service details
- `call_service` - Call and pay for a service
- `get_quote` - Get exact price first
- `pay_for_service` - Pay a quote
- `get_reputation` - Check service reputation

## Example Usage

User prompt in Claude:
```
"Find weather APIs on MeterX402 and get me the forecast for London"
```

Claude will:
1. Call `list_services` with `capability="weather_forecast"`
2. Call `call_service` to get the weather
3. Show the result and payment receipt

## Next Steps

1. ✅ **Built** - The package is ready
2. **Test** - Test with `npm link` locally
3. **Publish** - `npm publish` to make it public
4. **Deploy Hub** - Deploy the MeterX402 hub to production
5. **Document** - Add more examples and guides

## Package Structure

```
packages/mcp-server/
├── package.json       # Package metadata
├── build.mjs          # Build script
├── README.md          # User documentation
└── dist/
    └── index.js       # Bundled executable
```

## Cost to Users

- Installing: **Free** (npm package)
- Using services: **Pay-per-use** (actual usage in HBAR)
- Typical costs: **0.001-0.1 HBAR per call** depending on usage

## Production Deployment

For production, you'll want to:

1. **Deploy the hub**:
   ```bash
   # On your server
   git clone https://github.com/clatsonhacks/meterx402
   cd meterx402
   npm install
   npm run demo  # Production mode with real Hedera
   ```

2. **Update package README** with production hub URL

3. **Monitor** using the deployer dashboard at the hub URL

## Support

Users can:
- File issues: https://github.com/clatsonhacks/meterx402/issues
- Read docs: README.md in the package
- View dashboard: Hub URL for monitoring
