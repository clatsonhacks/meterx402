# MeterX402 VSCode Extension - Development Guide

## Setup

1. **Install dependencies:**
   ```bash
   cd vscode-extension
   npm install
   ```

2. **Compile TypeScript:**
   ```bash
   npm run compile
   ```

3. **Watch mode (auto-compile on changes):**
   ```bash
   npm run watch
   ```

## Testing the Extension

### Method 1: Run in Development Mode

1. Open the `vscode-extension` folder in VSCode
2. Press `F5` to launch Extension Development Host
3. The extension will be loaded in a new VSCode window
4. Test features:
   - Search for services
   - Call a service
   - Publish a dataset

### Method 2: Install Locally

1. **Package the extension:**
   ```bash
   npm run package
   ```
   This creates a `.vsix` file.

2. **Install the VSIX:**
   - Open VSCode
   - Go to Extensions (`Ctrl+Shift+X`)
   - Click the `...` menu → "Install from VSIX..."
   - Select the generated `.vsix` file

## Project Structure

```
vscode-extension/
├── src/
│   ├── extension.ts          # Main entry point
│   ├── client.ts             # MeterX402 API client
│   └── servicesProvider.ts   # Tree view provider
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
├── README.md                 # User documentation
└── DEVELOPMENT.md            # This file
```

## Key Files

### `package.json`
- Extension metadata
- Commands, views, and menus
- Configuration settings
- Activation events

### `src/extension.ts`
- Extension activation/deactivation
- Command registration
- Status bar integration
- UI interactions

### `src/client.ts`
- HTTP client for MeterX402 hub
- Service search and discovery
- API calling logic
- Dataset publishing

### `src/servicesProvider.ts`
- Tree view data provider
- Service list rendering
- Refresh and search logic

## Available Commands

During development, you can test these commands via Command Palette (`Ctrl+Shift+P`):

- `MeterX402: Search Services`
- `MeterX402: Refresh Services`
- `MeterX402: Call Service`
- `MeterX402: Publish Dataset`
- `MeterX402: Publish API`
- `MeterX402: View Wallet`
- `MeterX402: Open Dashboard`

## Configuration

Test the extension with different configurations in `.vscode/settings.json`:

```json
{
  "meterx402.hubUrl": "http://localhost:4021",
  "meterx402.buyerAccountId": "0.0.12345",
  "meterx402.buyerPrivateKey": "your-private-key",
  "meterx402.maxPerCall": "0.1",
  "meterx402.budget": "1"
}
```

## Debugging

1. Set breakpoints in TypeScript files
2. Press `F5` to start debugging
3. Extension Host window will open
4. Trigger commands to hit breakpoints
5. Debug console shows logs

## Building for Production

1. **Compile:**
   ```bash
   npm run compile
   ```

2. **Package:**
   ```bash
   npm run package
   ```

3. **Publish to Marketplace:**
   ```bash
   npx vsce publish
   ```
   (Requires Azure DevOps personal access token)

## Testing Checklist

- [ ] Search for services
- [ ] View service details (tooltip)
- [ ] Call a free service
- [ ] Call a paid service
- [ ] Cancel when price exceeds max
- [ ] Publish CSV dataset
- [ ] Publish JSON dataset
- [ ] Publish JSONL dataset
- [ ] View wallet info
- [ ] Open dashboard
- [ ] Status bar item works
- [ ] Settings are respected
- [ ] Error messages are clear

## Common Issues

### "Hub not reachable"
- Ensure MeterX402 hub is running: `npm run hub`
- Check `meterx402.hubUrl` setting

### "No wallet configured"
- Set `meterx402.buyerAccountId` in settings
- Set `meterx402.buyerPrivateKey` (optional)

### TypeScript errors
- Run `npm install` to ensure dependencies are installed
- Run `npm run compile` to check for errors

## Next Steps

Ideas for future enhancements:

- [ ] Inline webview for service details
- [ ] Dataset preview before publishing
- [ ] Activity history viewer
- [ ] Real-time earnings notifications
- [ ] Code snippets for SDK integration
- [ ] Multi-wallet support
- [ ] Subscription management
- [ ] A2A agent integration
