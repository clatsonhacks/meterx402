// Connect an AI to MeterX402: Claude, ChatGPT, VS Code.
//
// Every guide sets up the person's OWN testnet account. The demo wallet on
// this page only pays for calls made in this browser; a connected AI signs
// with the key on the user's machine (the MCP server or `mx402 connector`),
// inside a budget they set, and never pays from the hub's wallet.
//
// openLLMModal("claude" | "chatgpt" | "vscode") opens a guide; /app?connect=claude
// opens one on load.

(() => {
  const HUB = location.origin;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const PLACEHOLDER = { account: "0.0.your-account", key: "your-testnet-private-key" };
  const mcpEnv = { MX_HUB: HUB, BUYER_ACCOUNT_ID: PLACEHOLDER.account, BUYER_PRIVATE_KEY: PLACEHOLDER.key, BUYER_BUDGET: "1 HBAR", BUYER_MAX_PER_CALL: "0.05" };
  const mcpServer = { command: "npx", args: ["-y", "mx402", "mcp"], env: mcpEnv };

  const OWN_ACCOUNT = {
    title: "Use your own testnet account",
    body: `<p>A connected AI pays from <b>your</b> account, never this site's demo wallet. Create a free Hedera testnet account at
      <a href="https://portal.hedera.com" target="_blank" rel="noopener">portal.hedera.com</a> and copy its <b>Account ID</b> (0.0.…) and <b>private key</b>.</p>
      <p>Your key stays on your machine. <code>BUYER_BUDGET</code> caps the whole session and <code>BUYER_MAX_PER_CALL</code> caps one call: nothing above them is ever signed.
      Services on Base Sepolia or Solana devnet also need <code>BUYER_EVM_PRIVATE_KEY</code> or <code>BUYER_SOLANA_SECRET_KEY</code>.</p>`,
  };

  const GUIDES = {
    claude: {
      title: "Connect Claude",
      sub: "Claude Desktop or Claude Code gets MeterX402's tools over MCP: find services, see the exact price, pay within your budget.",
      steps: [
        OWN_ACCOUNT,
        {
          title: "Add MeterX402 to Claude Desktop",
          body: `<p>In Claude Desktop open <b>Settings → Developer → Edit Config</b> and add this to <code>claude_desktop_config.json</code>, with your account and key:</p>`,
          code: JSON.stringify({ mcpServers: { meterx402: mcpServer } }, null, 2),
          after: `<p class="fine">The file is in <code>%APPDATA%\\Claude\\</code> on Windows and <code>~/Library/Application Support/Claude/</code> on macOS.</p>`,
        },
        {
          title: "Or, in Claude Code: one command",
          code: `claude mcp add meterx402 -e MX_HUB=${HUB} -e BUYER_ACCOUNT_ID=${PLACEHOLDER.account} -e BUYER_PRIVATE_KEY=${PLACEHOLDER.key} -e "BUYER_BUDGET=1 HBAR" -- npx -y mx402 mcp`,
        },
        {
          title: "Restart and ask",
          body: `<p>Quit Claude Desktop completely (from the tray or menu bar) and reopen it, then start a new chat. Try:</p>`,
          code: "Use MeterX402 to find where USDC earns the most right now. Tell me the price before you pay.",
        },
      ],
    },
    chatgpt: {
      title: "Connect ChatGPT",
      sub: "A Custom GPT calls MeterX402 through a small connector you run. The connector signs with your key; ChatGPT only ever sees a bearer token.",
      steps: [
        OWN_ACCOUNT,
        {
          title: "Start your connector",
          body: `<p>In an empty folder, save your account in a <code>.env</code> file:</p>`,
          code: `BUYER_ACCOUNT_ID=${PLACEHOLDER.account}\nBUYER_PRIVATE_KEY=${PLACEHOLDER.key}\nBUYER_BUDGET=1 HBAR\nBUYER_MAX_PER_CALL=0.05\nMX_HUB=${HUB}`,
          after: `<p>Then run it there. It prints a <b>bearer token</b>; keep it for step 4.</p>`,
          code2: "npx -y mx402 connector",
        },
        {
          title: "Give it a public HTTPS address",
          body: `<p>ChatGPT has to reach your connector, so open a tunnel to port 3402 and copy the <code>https://…</code> address it shows:</p>`,
          code: "ngrok http 3402",
          after: `<p class="fine">Or <code>cloudflared tunnel --url http://localhost:3402</code>. Anyone with that address still needs your token to spend anything.</p>`,
        },
        {
          title: "Create the GPT",
          body: `<p>Open the <a href="https://chatgpt.com/gpts/editor" target="_blank" rel="noopener">GPT editor</a> → <b>Configure</b> → <b>Create new action</b> → <b>Import from URL</b>:</p>`,
          code: "https://YOUR-TUNNEL-ADDRESS/openapi.json",
          after: `<p>Set <b>Authentication</b> to <b>API Key</b>, auth type <b>Bearer</b>, and paste the token from step 2. (Building GPTs needs a ChatGPT plan that includes it.)</p>`,
        },
        {
          title: "Tell it how to spend",
          body: `<p>Paste into the GPT's <b>Instructions</b>:</p>`,
          code: "You can buy data and AI calls with MeterX402. Find services with listServices. Before paying, call getQuote and tell me the exact price; only call payQuote if I agree or it is under 0.01 HBAR.",
        },
      ],
    },
    vscode: {
      title: "Connect VS Code",
      sub: "Use MeterX402 from GitHub Copilot's agent mode or Cursor over MCP, or browse and call services from the MeterX402 extension.",
      steps: [
        OWN_ACCOUNT,
        {
          title: "GitHub Copilot, agent mode",
          body: `<p>Add <code>.vscode/mcp.json</code> to your project. VS Code asks for your account and key once and keeps the key in its secret storage, not in the file:</p>`,
          code: JSON.stringify({
            inputs: [
              { type: "promptString", id: "hedera-account", description: "Your Hedera testnet account ID (0.0.…)" },
              { type: "promptString", id: "hedera-key", description: "Your Hedera testnet private key", password: true },
            ],
            servers: {
              meterx402: {
                type: "stdio", command: "npx", args: ["-y", "mx402", "mcp"],
                env: { MX_HUB: HUB, BUYER_ACCOUNT_ID: "${input:hedera-account}", BUYER_PRIVATE_KEY: "${input:hedera-key}", BUYER_BUDGET: "1 HBAR", BUYER_MAX_PER_CALL: "0.05" },
              },
            },
          }, null, 2),
          after: `<p>Open Copilot Chat, switch to <b>Agent</b>, and the MeterX402 tools are listed under the tools button.</p>`,
        },
        {
          title: "Cursor",
          body: `<p>Add <code>.cursor/mcp.json</code> with your account and key:</p>`,
          code: JSON.stringify({ mcpServers: { meterx402: mcpServer } }, null, 2),
        },
        {
          title: "The MeterX402 extension",
          body: `<p>A sidebar to browse services, call them and publish datasets. Build and install it from the repo:</p>`,
          code: "cd vscode-extension\nnpm install\nnpm run package\n# Extensions view → … → Install from VSIX → meterx402-0.1.0.vsix",
          after: `<p>Put your account in your workspace <code>.env</code> and run <b>MeterX402: Start My Connector</b>. Every call is paid through it, from your account.</p>`,
        },
      ],
    },
  };

  const codeBlock = (code, key) => `<div class="code-block"><pre>${esc(code)}</pre><button class="copy-btn" type="button" data-copy="${key}">Copy</button></div>`;

  function build(id) {
    const g = GUIDES[id];
    const codes = [];
    const push = (c) => { codes.push(c); return codeBlock(c, codes.length - 1); };
    const el = document.createElement("div");
    el.className = "llm-modal";
    el.id = `modal-${id}`;
    el.innerHTML = `
      <div class="llm-modal-content" role="dialog" aria-modal="true" aria-labelledby="modal-${id}-h">
        <button class="llm-modal-close" type="button" aria-label="Close">&times;</button>
        <h2 id="modal-${id}-h">${esc(g.title)}</h2>
        <p class="label">${esc(g.sub)}</p>
        <div class="own-wallet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6Z"/><path d="m8.8 12 2.2 2.2 4.3-4.4"/></svg>
          <span>Pays from <b>your own</b> testnet account, inside your budget. Never from this site's demo wallet.</span></div>
        ${g.steps.map((s, i) => `
          <div class="llm-step">
            <div class="llm-step-num">${i + 1}</div>
            <div class="llm-step-content">
              <h3>${esc(s.title)}</h3>
              ${s.body ?? ""}
              ${s.code ? push(s.code) : ""}
              ${s.after ?? ""}
              ${s.code2 ? push(s.code2) : ""}
            </div>
          </div>`).join("")}
      </div>`;
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest(".llm-modal-close")) return closeLLMModal(id);
      const btn = e.target.closest(".copy-btn");
      if (btn) copy(codes[Number(btn.dataset.copy)], btn);
    });
    document.body.appendChild(el);
    return el;
  }

  function copy(text, button) {
    const done = (label) => { button.textContent = label; button.classList.toggle("copied", label === "Copied"); setTimeout(() => { button.textContent = "Copy"; button.classList.remove("copied"); }, 1800); };
    navigator.clipboard?.writeText(text).then(() => done("Copied"), () => done("Press Ctrl+C")) ?? done("Press Ctrl+C");
  }

  let lastFocus = null;
  function openLLMModal(id) {
    if (!GUIDES[id]) return;
    const el = document.getElementById(`modal-${id}`) ?? build(id);
    lastFocus = document.activeElement;
    el.classList.add("show");
    document.body.style.overflow = "hidden";
    el.querySelector(".llm-modal-close").focus();
  }
  function closeLLMModal(id) {
    const el = document.getElementById(`modal-${id}`);
    if (!el || !el.classList.contains("show")) return;
    el.classList.remove("show");
    document.body.style.overflow = "";
    lastFocus?.focus?.();
  }
  window.openLLMModal = openLLMModal;
  window.closeLLMModal = closeLLMModal;

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") Object.keys(GUIDES).forEach(closeLLMModal); });
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-llm]");
    if (t) { e.preventDefault(); openLLMModal(t.dataset.llm); }
  });

  const want = new URLSearchParams(location.search).get("connect");
  if (want && GUIDES[want]) {
    const open = () => openLLMModal(want);
    if (document.readyState === "complete") open(); else addEventListener("load", open, { once: true });
  }
})();
