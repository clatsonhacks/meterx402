# Troubleshooting MeterX402 Extension

## Extension Not Working / Nothing Happens When Clicking

### Step 1: Is the Extension Installed?

1. Open VSCode
2. Click Extensions icon (left sidebar) or press `Ctrl+Shift+X`
3. Search for "MeterX402"
4. You should see it listed under "Installed"

If not installed:
- Install the `.vsix` file via Extensions → `⋯` → Install from VSIX

### Step 2: Is the Extension Activated?

**Check Developer Console:**
1. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac)
2. Type: `Developer: Toggle Developer Tools`
3. Click the **Console** tab
4. Look for: `"MeterX402 extension is now active"`

**If you see errors:**
- Red error messages indicate activation failed
- Common error: `Cannot find module './client'` → Recompile the extension
- Fix: `cd vscode-extension && npm run compile`

### Step 3: Is the MeterX402 Hub Running?

The extension needs the hub to be running.

**Start the hub:**
```bash
# In the main meterx402 directory (not vscode-extension)
npm install
npm run hub
```

**You should see:**
```
MeterX402 hub listening at http://localhost:4021
```

**Test the hub is working:**
```bash
curl http://localhost:4021/
```

### Step 4: Check What You're Clicking

**The extension has multiple clickable areas:**

#### A) Activity Bar Icon (Left Sidebar)
- Look for the MeterX402 icon in the left sidebar
- Click it to open the Services panel
- If missing: The icon might not show if extension failed to activate

#### B) Status Bar Item (Bottom Right)
- Look for `$(globe) MeterX402` at the bottom right
- Click it to open the dashboard in browser
- If missing: Extension not activated

#### C) Commands (Command Palette)
- Press `Ctrl+Shift+P`
- Type "MeterX402"
- You should see:
  - MeterX402: Search Services
  - MeterX402: Publish Dataset
  - MeterX402: View Wallet
  - MeterX402: Open Dashboard

#### D) Right-Click Menu (Explorer)
- Right-click any `.csv`, `.json`, or `.jsonl` file
- Look for "MeterX402: Publish Dataset"

### Step 5: Common Issues & Fixes

#### Issue: "Extension is installed but icon doesn't appear"

**Fix:**
1. Check Developer Console for errors
2. Reload VSCode: `Ctrl+Shift+P` → "Reload Window"
3. Reinstall the extension

#### Issue: "Search Services shows empty list"

**Fix:**
1. Ensure hub is running: `npm run hub`
2. Check hub URL in settings: `Ctrl+,` → Search "meterx402.hubUrl"
3. Default should be: `http://localhost:4021`

#### Issue: "Cannot connect to hub"

**Fix:**
1. Start the hub: `npm run hub`
2. Test connection:
   ```bash
   curl http://localhost:4021/registry/services
   ```
3. If hub is on different port, update settings

#### Issue: "Click does nothing / No response"

**Possible causes:**
- Extension not activated (check Console for errors)
- Hub not running
- JavaScript error in extension code

**Debug steps:**
1. Open Developer Console (`Ctrl+Shift+P` → Developer Tools)
2. Click the thing that doesn't work
3. Look for error messages in Console tab
4. Share the error for help

### Step 6: Reinstall Extension (Clean Install)

If nothing works:

```bash
cd vscode-extension

# Clean rebuild
rm -rf node_modules dist *.vsix
npm install
npm run compile
npm run package

# In VSCode:
# 1. Uninstall MeterX402 extension
# 2. Reload Window
# 3. Install from VSIX (the new one you just created)
# 4. Reload Window again
```

### Step 7: Verify Installation

**After installing, verify:**

1. **Extension appears in Extensions list**
2. **Activity Bar has MeterX402 icon** (left sidebar)
3. **Status Bar shows MeterX402** (bottom right)
4. **Command Palette has MeterX402 commands** (`Ctrl+Shift+P`)
5. **Developer Console shows**: `"MeterX402 extension is now active"`

### Getting Help

**When reporting issues, include:**
1. What you clicked (icon, command, menu item)
2. What you expected to happen
3. What actually happened
4. Any error messages from Developer Console
5. Is the hub running? (`npm run hub`)
6. VSCode version: `Ctrl+Shift+P` → "About"

## Quick Checklist

- [ ] Extension installed (visible in Extensions panel)
- [ ] Hub running (`npm run hub`)
- [ ] No errors in Developer Console
- [ ] MeterX402 icon visible in Activity Bar
- [ ] Status bar shows MeterX402
- [ ] Commands appear in Command Palette
- [ ] Right-click CSV shows "Publish Dataset"

If all checked and still not working, check Developer Console for errors!
