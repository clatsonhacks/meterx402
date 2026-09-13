# MeterX402 · submission video script

Five parts, each recorded as its own clip. In every part, **SHOW** is what is on screen and
**SAY** is the voiceover. Commands and numbers are from real testnet runs.

**Bounty callouts** are the lines starting with 🏆. Say each one while the feature it belongs to is on
screen, so judges hear the sponsor next to the working thing: **Hedera** (settlement, identity,
receipts), **The Graph** (AI tooling and standardized subgraphs), **Uniswap** (the Trading API stack).

| Part | What it covers |
|---|---|
| [1. Intro](#part-1--intro-any-api-becomes-a-hedera-api) | Any API becomes a Hedera API for the agent economy, published in seconds, and datasets make money too |
| [2. Publish with npm](#part-2--publish-in-seconds-with-npm) | `npx mx402 check`, `publish`, the 402 a buyer sees, `data` for a dataset, publishing an AI agent |
| [3. The Deployer page](#part-3--the-deployer-page-concept-by-concept) | Income, metering, pricing, settlement, payments with proof, registry and reputation |
| [4. Use it from your AI](#part-4--use-it-from-claude-vs-code-and-chatgpt) | Claude, VS Code (Copilot + the MeterX402 extension), ChatGPT, always with your own wallet |
| [5. The web app](#part-5--the-agent-marketplace-and-playground) | Landing page, agent marketplace, Try it, Playground, the DEX analyst, close |

---

## Part 1 · Intro: any API becomes a Hedera API

> **Before recording:** landing page open at `http://localhost:4021`, light theme, zoom 125%.

**SHOW:** Black screen. Big white captions, one line at a time.

**SAY:**
> Every AI agent runs on APIs. Weather, prices, blockchain data, language models.
>
> But APIs were built for humans with credit cards and monthly plans. Agents don't have credit
> cards. They need to pay per call, on their own, instantly.
>
> What if you could turn any API into a Hedera API that agents pay by themselves?
> And what if it took one command?

**SHOW:** Cut to the landing page. The globe turns; arcs fly to Hedera, Base and Solana; the receipt
card counts up.

**SAY:**
> This is MeterX402. It turns any API into a paid API for the agent economy, settled on Hedera.
>
> You publish in seconds with npm. Buyers, people or AI agents, pay for exactly what each call
> returns: the tokens, the rows, the data they actually get. Not a flat price.
>
> And it's not only APIs. If you have a dataset, a CSV or a JSON file, you can sell it too, and get
> paid for every cell someone buys.
>
> Every payment settles on chain and comes with a receipt anyone can verify.
>
> Let me show you how fast this is, starting from a terminal.

---

## Part 2 · Publish in seconds with npm

> **Before recording:** a terminal with font size 18, in a folder with a small `cities.csv`. Your
> Hedera testnet account id ready for `--wallet`. `npm run demo` running so the registry is up.
> Run each command once beforehand; the first `npx` download takes about a minute.
>
> **Commands are for PowerShell.** A long command is split with a backtick (`` ` ``) at the end of
> the line, with nothing after it; or paste it as one line. In bash, use `\` instead, and plain `curl`.

### 2.1 · Check the API

**SHOW:**

```powershell
npx mx402 check https://api.open-meteo.com/v1/forecast `
  --sample "/?latitude=13.08&longitude=80.27&hourly=temperature_2m&forecast_days=1"
```

Hold on the output:

```
✓ 200 in 1045ms, 0.8 KB back
  meter      rows:hourly.time   priced per row returned
  rate       0.0002 HBAR / row
  this call          24 rows    0.0048 HBAR
  forecast_days=2    48 rows    0.0096 HBAR
  flat, at the cap   96 rows    0.0192 HBAR   ← every call without metering
```

**SAY:**
> Here's a free weather API, Open-Meteo. I haven't written any code for it.
>
> `mx402 check` calls it once, for free, and reads the response. It found a list of hourly readings,
> so it decides to charge per row, and suggests a price.
>
> Look at this table: one day is 24 rows, two days is 48 rows, double the price. A flat price would
> have to charge the biggest possible answer, every single time. With metering, buyers pay for what
> they get.

### 2.2 · Publish it

**SHOW:**

```powershell
npx mx402 publish https://api.open-meteo.com/v1/forecast `
  --sample "/?latitude=13.08&longitude=80.27&hourly=temperature_2m&forecast_days=1" `
  --wallet 0.0.YOUR_ACCOUNT --title "Weather Forecast" --port 4811 --yes
```

```
✓ API detected: REST, 200 in 910ms
✓ Authentication: none needed
✓ Meter detected: rows:hourly.time
✓ Suggested rate: 0.0002 HBAR / row
✓ Settlement: Hedera: HBAR per call (x402 exact via blocky402)
✓ Service registered
  Service ID        weather-forecast
  Payment endpoint  http://127.0.0.1:4811
  A2A agent card    http://127.0.0.1:4811/.well-known/agent.json
  MCP               listed by the MeterX402 MCP server
```

**SAY:**
> Now I publish it. One command, with my Hedera account as the payout wallet.
>
> In a few seconds it detected the API, the authentication, the meter and the price. It started a
> payment gateway in front of the API, and registered it so agents can discover it.
>
> That's it. This API is now a Hedera API. Every call pays HBAR straight into my account.
>
> It also got an A2A agent card and MCP tools automatically, so AI agents can find it and use it
> without any extra work from me.
>
> If the API needs a key, I pass it once here. The key stays on my gateway and is never shown to
> buyers.

🏆 **Bounty: Hedera.** SAY:
> Hedera is the default settlement layer. Payments go straight to my Hedera account in HBAR, or in any
> Hedera token, and every service gets a Hedera HCS-14 agent identity the moment it's published.

### 2.3 · What a buyer sees

**SHOW:** In a second terminal (the publish terminal keeps the gateway running):

```powershell
curl.exe -i "http://127.0.0.1:4811/?latitude=13.08&longitude=80.27&hourly=temperature_2m&forecast_days=1"
```

Type `curl.exe`, not `curl`: in Windows PowerShell, `curl` is a shortcut for `Invoke-WebRequest`,
which rejects `-i`.

```
HTTP/1.1 402 Payment Required
x-meter-unit: rows
x-meter-measured: 24
x-meter-amount: 0.0048
x-meter-currency: HBAR
x-meter-body-sha256: …
```

Zoom in on `x-meter-amount`.

**SAY:**
> If someone calls it without paying, they get HTTP 402, Payment Required. That's the x402 standard.
>
> But notice: the price isn't a fixed number. The gateway already ran the request, counted 24 rows,
> and quotes the exact price of this answer. It even includes a hash of the answer it's holding, so
> the buyer knows they'll get exactly what they paid for.

### 2.4 · Sell a dataset

**SHOW:**

```powershell
npx mx402 data cities.csv --wallet 0.0.YOUR_ACCOUNT --rate 0.0001 --title "World Cities" --port 4812
```

```
✓ Read 8 rows × 5 columns (csv, 0.3 KB)
What buyers would pay (per cell, a row of 5 columns is 5 cells)
  a 50-row page, every column    0.025 HBAR
  the same page, 2 columns        0.01 HBAR ← narrower is cheaper
  /schema and /count are free
✓ Serving http://127.0.0.1:4812
```

**SAY:**
> Now the money-making part for data. I have a CSV file. One command, `mx402 data`, turns it into an
> API that anyone can query and pay for.
>
> It's priced per cell. If a buyer only needs two columns, they pay for two columns. The schema and
> the row count are free, so they can see what's inside before they pay.
>
> And the file never leaves my machine. Only the cells someone pays for do.
>
> Want to be paid in USDC instead? Add `--chain base-sepolia` or `--chain solana-devnet`. Same
> command.
>
> So in under a minute, I've monetized an API and a dataset.

### 2.5 · Publish an AI agent

> **Before recording:** a Groq API key (free at console.groq.com). Any OpenAI-compatible model works
> the same way, and so does your own agent's HTTP endpoint. `--tab` needs the account that collects
> tab allowances in the terminal's `.env` or environment: `TAB_SPENDER_ID`/`TAB_SPENDER_KEY`, or
> `HEDERA_ACCOUNT_ID`/`HEDERA_PRIVATE_KEY` (fix the stray `x` on `.env` line 1 first). Without it,
> drop `--tab` and skip that sentence. Commands are for PowerShell; in bash, replace the trailing
> `` ` `` with `\` and `$env:GROQ_API_KEY` with `$GROQ_API_KEY`.

**SHOW:** Set the key, then check the model's API:

```powershell
$env:GROQ_API_KEY = "gsk_…"

npx mx402 check https://api.groq.com/openai/v1 --sample /chat/completions --method POST `
  --body '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"Explain x402 in 40 words"}]}' `
  --header "Authorization: Bearer $env:GROQ_API_KEY"
```

Point at `meter  tokens` in the output.

**SAY:**
> Now the agent economy part: selling AI itself. This is a language model on Groq. `mx402 check`
> sends one prompt and sees that the reply reports how many tokens it used, so it prices per token.
> A short answer costs a little; a long answer costs more.

**SHOW:** Publish it as a paid AI agent, with streaming:

```powershell
npx mx402 publish https://api.groq.com/openai/v1 --sample /chat/completions --method POST `
  --body '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"Explain x402 in 40 words"}]}' `
  --header "Authorization: Bearer $env:GROQ_API_KEY" `
  --wallet 0.0.YOUR_ACCOUNT --name my-ai-agent --title "My AI Agent" --capability text_generation `
  --rate 0.01 --per 1000 --tab --port 4821 --yes
```

```
✓ API detected: REST
✓ Authentication: Bearer token (held by your gateway, never sent to buyers)
✓ Meter detected: tokens
✓ Suggested rate: 0.01 HBAR / 1000 tokens
✓ Settlement: Hedera: HBAR per call (x402 exact) + Metered Tabs (allowance)
✓ Service registered (capabilities: text_generation)
  A2A agent card    http://127.0.0.1:4821/.well-known/agent.json
  MCP               listed by the MeterX402 MCP server
```

Open the two addresses in the browser: `http://127.0.0.1:4821/.well-known/agent.json` (the A2A card
and its skills) and `http://127.0.0.1:4821/.well-known/mx402` (the descriptor; scroll to `uaid`).

**SAY:**
> One command, and my AI is a paid agent. My Groq key stays on my gateway; buyers never see it.
>
> It's priced per token, 0.01 HBAR per thousand. With `--tab`, a buyer can open a Metered Tab:
> approve an allowance once on Hedera, and the answer streams token by token, billed as it goes.
>
> It now has an A2A agent card, so other agents can talk to it, and a Hedera HCS-14 identity, this
> `uaid`, so anyone can check which agent they're paying.
>
> It works for your own agent too. If your agent has an HTTP endpoint, point `mx402 publish` at it,
> and it's a paid agent in the marketplace.

**SHOW:** Any agent can now look it up:

```bash
npx mx402 inspect my-ai-agent
```

**SAY:**
> Let's see everything I just published on the Deployer page.

---

## Part 3 · The Deployer page, concept by concept

> **Before recording:** a few paid calls already made to your weather API and dataset (use Try it
> once or twice), so the charts have data. Open `http://localhost:4021/app#deployer`.

### 3.1 · Your services

**SHOW:** Deployer → Overview. Type your payout account into **Payout wallet** so only your
services show.

**SAY:**
> This is the Deployer page, the seller's dashboard. I've filtered it to my payout wallet.

### 3.2 · Income and paid calls

**SHOW:** Point at **Income**, **Paid calls** and **Units sold**.

**SAY:**
> At the top: my income in HBAR, how many paid calls, and how many units I sold. Units are whatever
> my API is metered on: rows for the weather API, cells for the dataset, tokens for an AI model.

### 3.3 · Metering: price per call is not fixed

**SHOW:** Point at **Price per call** (median and p90), then the **What each call cost** chart,
one column per paid call.

**SAY:**
> This is the core idea. Price per call isn't one number. It has a median and a p90, because every
> call costs what it returned.
>
> In this chart, every column is one paid call. Small answers are cheap, big answers cost more.
> With a flat price, every one of these columns would be the same height, at the maximum.

### 3.4 · Buyers saved vs flat

**SHOW:** Point at **Buyers saved vs flat** (green).

**SAY:**
> And this number is what buyers saved compared to charging every call at its cap. That's why
> agents choose metered services: they don't overpay for small answers.

### 3.5 · Calls by hour

**SHOW:** The **Calls by hour (UTC)** chart.

**SAY:**
> Calls by hour shows when agents are using my API.

### 3.6 · Selling from the browser

**SHOW:** Deployer → **APIs** → **Sell an API**. Click through **An API / A dataset**, then the
three steps **Connect → Price → Get paid**. Don't publish; just show the steps and **Prefer the
terminal?**

**SAY:**
> If you don't like terminals, you can do the same thing here. Sell an API, or a dataset: drop the
> file in.
>
> Step one, connect: paste your API's URL and an example request. It checks it for free.
>
> Step two, price: it shows the unit it detected and what buyers would pay, and you can change it.
>
> Step three, get paid: your Hedera account. You can also turn on Metered Tabs, where a buyer
> approves an allowance once on Hedera and then streams answers without signing every call.
>
> Publish, and it's live. And it always shows you the matching terminal command.

### 3.7 · Test your API as a buyer

**SHOW:** Scroll to the **APIs** cards. Open your weather card and send a test buyer.

**SAY:**
> Every API I sell has a card here. I can send a test buyer to see exactly what a customer would pay.

### 3.8 · Payments with proof

**SHOW:** Deployer → **Payments**. Point at the columns **units**, **cap**, **rate**, **charged**,
**flat at cap**, then click a **receipt** link to open HashScan.

**SAY:**
> Every payment is here, with the units it was priced from, the cap, the rate, what was charged,
> and what a flat price would have charged.
>
> And every row has a receipt. This link opens the actual transaction on HashScan. Nothing here is
> just a database entry; it's on the Hedera ledger.

**SHOW:** **Analytics** (endpoints, top payers) and **Live events** feed.

**SAY:**
> Below: which endpoints earn the most, my top payers, and a live feed of every call as it's
> metered, quoted, paid and settled.

### 3.9 · The registry and reputation

**SHOW:** Deployer → **Registry**. Point at **capabilities**, **price**, **interfaces**,
**reputation**, **median ms**, **uptime**, **disputes**. Click **Anchor reputation to HCS**.

**SAY:**
> Finally, the registry. This is what AI agents see when they look for a service: what it does, its
> price, how to call it (REST, MCP, A2A, the SDK), and a reputation score.
>
> The reputation isn't reviews. It's calculated from real settlements: did calls succeed, how fast,
> any disputes, uptime, did payments settle.
>
> And with one click, I anchor every score's evidence to the Hedera Consensus Service, so anyone can
> verify the reputation hasn't been changed.

🏆 **Bounty: Hedera.** SAY:
> This is where Hedera does the heavy lifting: every payment checked on the mirror node, receipts and
> reputation anchored on the Consensus Service, Metered Tabs on native allowances, and subscriptions
> as scheduled transactions the buyer can cancel.
>
> So that's the seller side. Now, how do people actually use these APIs? The easiest way is from
> the AI you already use.

---

## Part 4 · Use it from Claude, VS Code and ChatGPT

> **Before recording:**
> - Claude Desktop configured with the Connect Claude config (your own buyer account,
>   `MX_HUB=http://127.0.0.1:4021`), fully restarted, MeterX402 tools visible.
> - VS Code with `.vscode/mcp.json` from the Connect VS Code guide, and the MeterX402 extension
>   installed from the VSIX, with your buyer account in the workspace `.env`.
> - For ChatGPT: `npx mx402 connector` running, a tunnel (`ngrok http 3402`), and a Custom GPT with
>   the action imported. If you can't set this up, show the guide instead.

### 4.1 · Connect your AI

**SHOW:** `http://localhost:4021/app` → Explore → **Use it from your AI** → the three cards. Open
**Connect Claude** and scroll slowly past the banner "Pays from your own testnet account".

**SAY:**
> In the app there's a section called Use it from your AI: Claude, ChatGPT and VS Code. Each one is
> a short step-by-step guide.
>
> The most important thing: it pays from your own testnet account, on your own machine, inside a
> budget you set. Your private key never leaves your computer.

### 4.2 · Claude

**SHOW:** The Claude config from the guide:

```json
{
  "mcpServers": {
    "meterx402": {
      "command": "npx",
      "args": ["-y", "mx402", "mcp"],
      "env": {
        "MX_HUB": "http://127.0.0.1:4021",
        "BUYER_ACCOUNT_ID": "0.0.your-account",
        "BUYER_PRIVATE_KEY": "your-testnet-private-key",
        "BUYER_BUDGET": "1 HBAR"
      }
    }
  }
}
```

Then Claude Desktop. Type:

> Use MeterX402 to get tomorrow's weather forecast for Chennai. Tell me the price before you pay.

Show `list_services` → `get_quote` (the price) → you reply "yes" → `pay_for_service` → the answer
with the line `PAID 0.0048 HBAR for 24 rows … tx 0.0.…`.

**SAY:**
> For Claude, it's one entry in the config: `npx mx402 mcp`, with my account and a budget of 1 HBAR.
>
> Now I just talk to Claude. It searches the registry, finds the weather service I published,
> and gets a quote. It tells me the price first.
>
> I say yes. It pays from my wallet, checks that the data matches what it was quoted, and shows me
> the receipt with the Hedera transaction.
>
> Claude gets 12 tools: find services, quote, pay, and also live DeFi data from The Graph and a DEX
> analyst.

🏆 **Bounty: The Graph (AI tooling).** SHOW: in Claude, ask "Use MeterX402 to find where USDC earns the
most in lending" → `find_lending_markets` → the paid table. SAY:
> For The Graph, this is AI tooling any agent can use today: MCP tools for DEX pools, lending markets,
> any subgraph and the analyst, plus an agent skill file that teaches an AI when to buy which data. The
> agent pays per result and never needs its own Graph API key.

### 4.3 · VS Code: Copilot

**SHOW:** VS Code → `.vscode/mcp.json` from the Connect VS Code guide. VS Code asks for the account
and the key (password prompt). Then Copilot Chat → **Agent** mode → the tools list shows meterx402.
Ask:

> Find the best USDC lending rate using MeterX402, and show the price first.

**SAY:**
> In VS Code, GitHub Copilot uses the same MCP server. I add this file to my project. VS Code asks
> for my account and key once and keeps the key in its secure storage, not in the file.
>
> Now Copilot in agent mode can buy data while I code. Here it's buying lending rates from The Graph,
> and again, I see the price before it pays.

### 4.4 · VS Code: the MeterX402 extension

**SHOW:** The MeterX402 icon in the activity bar → **Start My Connector** (a terminal opens running
`npx -y mx402 connector`) → **Search Services** → "weather" → click the play button on your service
→ path and max price → the JSON result opens and the notification "Paid 0.0048 HBAR".

Then in the Explorer, right-click `cities.csv` → **MeterX402: Publish Dataset**.

**SAY:**
> We also built a VS Code extension. It has a sidebar with every service in the marketplace.
>
> Start My Connector runs a small local connector with my own key. Then I search, click play, set
> the most I'll pay, and the result opens right in my editor, already paid for.
>
> And selling is a right-click: Publish Dataset on any CSV or JSON file in my project. A developer
> can monetize data without leaving the editor.

### 4.5 · ChatGPT

**SHOW:** Connect ChatGPT guide steps. Then the terminal:

```bash
npx mx402 connector
```

```
MeterX402 connector on http://localhost:3402
  OpenAPI spec   http://localhost:3402/openapi.json
  pays from      0.0.your-account
  bearer token   ••••••••
```

Then the GPT editor → Actions → **Import from URL** `https://your-tunnel/openapi.json` →
Authentication **API Key, Bearer**. Then chat with the GPT: "What's the weather in Paris tomorrow?
Quote first." Show `getQuote` then `payQuote`.

**SAY:**
> ChatGPT doesn't speak MCP, so we built a connector. `npx mx402 connector` runs a small API on my
> machine with an OpenAPI spec, protected by a token.
>
> I give it a public address with a tunnel, import the spec into a Custom GPT, and paste the token.
>
> Now my GPT can find services, get a quote and pay, from my own account, just like Claude.
>
> So whatever AI you use, Claude, VS Code or ChatGPT, it can pay for APIs in seconds.

---

## Part 5 · The agent marketplace and Playground

> **Before recording:** `http://localhost:4021` in the browser. Wallet pill shows at least 1 HBAR.
> Tabs ready: HashScan, BaseScan, Solscan.

### 5.1 · The landing page

**SHOW:** Landing page, slow scroll: the globe, "A flat price is the wrong unit", "How a call is
paid" (the coin flips to PAID), the Chains section (the globe turns to Hedera, Base, Solana).

**SAY:**
> Finally, the web app. On the landing page, every arc on this globe is a real payment flying to the
> chain that settled it.
>
> Here's how every call works: the service meters the answer, quotes the exact price, your wallet
> checks your limit and pays, and you get a receipt.
>
> It settles on Hedera with HBAR or Hedera tokens, and also in USDC on Base and Solana. Same flow,
> three chains.

### 5.2 · The agent marketplace

**SHOW:** Get started → Explore. The live receipt replay, the stats, the receipts ticker, the search
and categories, the service cards with reputation.

**SAY:**
> This is the agent marketplace. At the top, a real recent payment replays: metered, quoted, paid,
> settled, with the link to the chain.
>
> Below, every service that's live, with its price per unit and its reputation. Search by what you
> need: weather, chat, lending, blockchain data.

### 5.3 · Try it

**SHOW:** Open your **Weather Forecast** → **Try it** → **Today** → the price before paying → Pay →
the data and the receipt → open HashScan. Back → **2 days** → Pay (48 rows, 0.0048). Then the
wallet button → **Most I'll pay for one request** = `0.003` → **A week** → it asks first.

**SAY:**
> Anyone can try a service right here. Today's forecast is 24 rows, so the price is 0.0024 HBAR.
> I see it before I pay. Pay, and here's the data and the transaction on HashScan.
>
> Two days: 48 rows, exactly double. Same API, different work, different price.
>
> And I set my own limit. If a call costs more than I allow, it asks me first. Nothing above my limit
> is ever signed.

**SHOW:** **Activity** tab: your payments with receipts across chains.

**SAY:**
> Activity shows everything I've paid for, each with its receipt.

### 5.4 · Onchain data: The Graph and Uniswap

**SHOW:** Explore → **Lending Rates Everywhere** → Try it: USDC, earn on a deposit → Pay → the table
and the coverage chips. Then **Any Subgraph, Per Entity** → a preset → 9 entities, 0.0009 HBAR.

**SAY:**
> We also sell live onchain data. This one queries The Graph's standardized lending subgraphs, Aave,
> Compound, Spark and more, all at once, and I pay per market returned.
>
> And this one runs any query on any subgraph on The Graph, charged per result, with no API key. If
> the query fails, it costs nothing.

🏆 **Bounty: The Graph (standardized, composable).** SAY:
> Because these subgraphs follow Messari's standard schemas, one query covers 15 DEX subgraphs and
> another covers 15 lending subgraphs, across chains, in the same shape, and the analyst composes the
> two. When a standardized indexer fails, Uniswap's own subgraph answers instead, and the result says so.

### 5.5 · The Playground: the DEX analyst

**SHOW:** **Playground** → **Ask the DEX analyst** → pick "Where can USDC earn the most fees against
ETH?" → the four steps light up → the receipts → the answer.

**SAY:**
> In the Playground there's an AI agent that pays for its own research.
>
> I ask where USDC earns the most. It pays for an AI model to plan, pays The Graph for pools and
> lending rates, pays Uniswap for a quote, and pays again to write the answer. Four small payments,
> four receipts, about one cent of test HBAR.
>
> And it can only state numbers it actually paid for. Anything it made up is removed.
>
> This is the agent economy: agents buying data from other services, one metered payment at a time.

🏆 **Bounty: Uniswap.** SHOW: under the answer, click **Build this swap for my wallet** → approval
needed, Permit2 signed, swap calldata, not sent. SAY:
> The trade step uses the Uniswap Trading API, sold per quote like any other service. From the quote we
> build the real swap for a wallet: the token approval, the Permit2 signature and the swap transaction,
> ready to sign but never broadcast. Our notes on the API are in FEEDBACK.md.

### 5.6 · The Playground: call from code

**SHOW:** **Call a service from code** → tabs **Buyer SDK**, **Agent SDK**, **MCP connector**,
**A2A**, **HTTP / x402**, **CLI**. Pick your weather service, click **Run** on one tab.

**SAY:**
> For developers, every way to call a service is here, with live code: the SDK, the agent SDK, MCP,
> A2A, plain HTTP with x402, or the command line. Pick a service, press Run, and it makes the real
> paid call.
>
> It's all one npm package: `mx402`.

### 5.7 · Close

**SHOW:** Landing page final section, the globe rising. End card:
`npmjs.com/package/mx402` · `github.com/clatsonhacks/meterx402`

**SAY:**
> So that's MeterX402.
>
> Turn any API into a Hedera API in seconds. Sell your datasets. Get paid for exactly what every call
> returns.
>
> And use it from Claude, VS Code or ChatGPT, with your own wallet.
>
> Pay per use, not per call. `npx mx402`.

---

## Recording checklist

- [ ] `.env` line 1 reads `HEDERA_ACCOUNT_ID=` (no stray `x`), then restart `npm run demo`.
- [ ] `npm run demo` running; `http://localhost:4021` shows services live.
- [ ] Every `npx mx402` command run once today, so nothing downloads during a take.
- [ ] `GROQ_API_KEY` set for Part 2.5, and `--port 4821` free (it must not clash with the demo's own
      AI Chat lane).
- [ ] A few paid calls made to your new services before Part 3, so the Deployer charts have data.
- [ ] Claude Desktop, VS Code (`.vscode/mcp.json` + the extension) and, if used, the Custom GPT set
      up with **your own** buyer account.
- [ ] Browser 1920×1080, zoom 125%, light theme, bookmarks hidden, notifications off.
- [ ] Terminal font 18. Cursor highlight on.
- [ ] While editing, speed up every wait (npx, settlement, the analyst) instead of talking over it,
      and caption prices the moment they appear.
