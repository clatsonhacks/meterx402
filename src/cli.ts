// The mx402 command line.
//
//   mx402 check <api-url> [...]        what it would meter, and what calls would cost (no payments)
//   mx402 <api-url> --wallet <acct>    put it behind a metered x402 paywall
//   mx402 wallet new                   create a funded Hedera testnet account to be paid into
//
// Pricing flags are optional: with no --meter, the API is probed once and the
// meter + a starting rate are detected from the shape of its response.

import { loadEnv } from "./env.ts";
import { detect, probe, variants, priceOf, type Detection, type ProbeRequest } from "./detect.ts";
import { describeRate } from "./pricing.ts";
import { parseArgs, startGateway, type GatewayConfig } from "./gateway.ts";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const HELP = `
${bold("mx402")} — turn any API into an x402 API that charges for what each call uses.

  ${bold("mx402 check <api-url>")} [--sample /path] [--method POST] [--body '{...}'] [--header "K: V"] [--query k=v]
      Call the API once (no payments, no wallet) and report what it would meter,
      what sample calls would cost, and what a flat price would have charged.

  ${bold("mx402 <api-url> --wallet <account>")} [pricing flags] [lane flags]
      Serve it behind a metered paywall. With no --meter, the meter and a starting
      rate are detected from the API's own response.

  ${bold("mx402 publish <api-url> --wallet <account>")} [--title s] [--unit-label s] [--capability c] [--description s] [--registry url] [--yes]
      The one command to sell an API: detect its type, auth and meter, confirm the
      pricing, start the payment endpoint, and register it so agents can discover it.

  ${bold("mx402 data <file.csv|.json|.jsonl>")} --wallet <account> [--rate 0.0001] [--title "Weather 2024"]
      Sell a dataset you already have. It is served as a queryable API (filter,
      sort, select, page) and priced per row a buyer actually receives. The
      schema and a sample are always free, so buyers can see before they pay.

  ${bold("mx402 inspect <service-id | url>")} [--registry url]
      A service's descriptor, pricing, settlement options and reputation.

  ${bold("mx402 mcp")}
      Run the MeterX402 MCP server over stdio (list_services, get_quote, pay_for_service, …).
      Configure with MX_HUB and BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY / BUYER_BUDGET.

  ${bold("mx402 wallet new")} [--hbar 5]
      Create a Hedera testnet account (needs HEDERA_ACCOUNT_ID/HEDERA_PRIVATE_KEY
      in .env) and print it, to use as --wallet.

Run ${bold("mx402 --help-all")} for every pricing, lane and tab flag.
`;

export async function cli(argv: string[]): Promise<void> {
  loadEnv();
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { console.log(HELP); process.exit(cmd ? 0 : 1); }
  if (cmd === "--help-all") { const { GATEWAY_HELP } = await import("./gateway.ts"); console.log(GATEWAY_HELP); return; }
  if (cmd === "mcp") { await import("./mcp.ts"); return; } // the MCP server, over stdio
  if (cmd === "check") return check(argv.slice(1));
  if (cmd === "data") return data(argv.slice(1));
  if (cmd === "publish") return publish(argv.slice(1));
  if (cmd === "inspect") return inspect(argv.slice(1));
  if (cmd === "wallet") return wallet(argv.slice(1));
  return serve(argv);
}

/** Flags shared by `check` and the live gateway. */
function probeArgs(argv: string[]): ProbeRequest & { upstream: string } {
  const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const flagAll = (n: string) => argv.reduce<string[]>((acc, a, i) => (a === `--${n}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
  const upstream = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  if (!upstream) { console.error("usage: mx402 check <api-url> [--sample /path] [--method POST] [--body '{...}']"); process.exit(1); }
  const headers: Record<string, string> = {};
  for (const h of flagAll("header")) { const i = h.indexOf(":"); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
  const query: Record<string, string> = {};
  for (const q of flagAll("query")) { const i = q.indexOf("="); if (i > 0) query[q.slice(0, i).trim()] = q.slice(i + 1).trim(); }
  let sample = flag("sample", "/")!;
  // Git Bash / MSYS rewrites a leading "/path" argument into "C:/Program Files/…".
  // Undo it rather than calling a nonsense URL and blaming the API.
  const mangled = /^[A-Za-z]:[\\/].*?[\\/]([^\\/].*)$/.exec(sample);
  if (mangled) {
    sample = "/" + mangled[1].replaceAll("\\", "/");
    console.error(`note: your shell rewrote --sample into a Windows path; using "${sample}". Prefix MSYS_NO_PATHCONV=1 to avoid this.`);
  }
  return { upstream, sample, method: flag("method", flag("body") ? "POST" : "GET"), body: flag("body"), headers, query };
}

// ── mx402 check ───────────────────────────────────────────────────────────

async function check(argv: string[]): Promise<void> {
  const req = probeArgs(argv);
  console.log(`\n${bold("mx402 check")} ${dim(req.upstream)}`);
  console.log(dim(`calling it once, nothing is charged…\n`));
  const { probe: p, detection } = await detect(req);

  if ("error" in detection) {
    console.log(`${red("✖")} could not read the API: ${detection.error}`);
    console.log(dim(`   ${req.method} ${p.url}`));
    console.log(dim(`   if it needs a key, pass it: --header "Authorization: Bearer \$KEY"  or  --query "apikey=\$KEY"`));
    process.exit(1);
  }

  const d: Detection = detection;
  const card = { rate: d.rate, per: d.per, min: d.min };
  console.log(`${green("✓")} ${bold(`${p.status} in ${Math.round(p.ms)}ms`)}, ${(p.bytes / 1000).toFixed(1)} KB back`);
  console.log(`\n${bold("What it should be metered on")}`);
  console.log(`  meter      ${bold(d.meter)}   ${dim(d.why)}`);
  console.log(`  rate       ${bold(describeRate({ unit: d.unit, rate: d.rate, per: d.per }))}${d.min ? dim(`   (minimum ${d.min} per paid call)`) : ""}`);
  console.log(`  seller cap ${d.maxUnits} ${d.unit} per call`);

  // show the price MOVING: that is the whole point of metering
  const rows: { label: string; units: number; price: string }[] = [
    { label: "this call", units: d.measured, price: priceOf(d.measured, card) },
  ];
  for (const v of variants(req)) {
    const r = await probe(v.req);
    if (!r.ok) continue;
    const { detectFrom } = await import("./detect.ts");
    const dd = detectFrom(r, v.req.body ? JSON.parse(v.req.body) : undefined);
    if ("error" in dd) continue;
    rows.push({ label: v.label, units: dd.measured, price: priceOf(dd.measured, card) });
  }

  const flat = priceOf(d.maxUnits, card);
  console.log(`\n${bold("What calls would cost")}`);
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) console.log(`  ${r.label.padEnd(w)}  ${String(r.units).padStart(7)} ${d.unit.padEnd(7)} ${bold(r.price.padStart(12))} HBAR`);
  if (rows.length > 1 && rows.some((r) => r.price !== rows[0].price)) {
    console.log(dim(`  ↳ same API, different work, different price. A flat price has to cover the worst case:`));
  } else {
    console.log(dim(`  ↳ a flat price has to cover the worst case:`));
  }
  console.log(`  ${"flat, at the cap".padEnd(w)}  ${String(d.maxUnits).padStart(7)} ${d.unit.padEnd(7)} ${bold(flat.padStart(12))} HBAR   ${dim("← what every call would cost without metering")}`);

  const parts = [req.upstream, "--wallet", "<your-account>"];
  if (req.sample && req.sample !== "/") parts.push("--sample", `'${req.sample}'`);
  if (req.method && req.method !== "GET") parts.push("--method", req.method);
  if (req.body) parts.push("--body", `'${req.body.length > 60 ? req.body.slice(0, 57) + "…" : req.body}'`);
  for (const [k, v] of Object.entries(req.headers ?? {})) parts.push("--header", `'${k}: ${v.length > 12 ? v.slice(0, 6) + "…" : v}'`);
  for (const k of Object.keys(req.query ?? {})) parts.push("--query", `'${k}=…'`);
  console.log(`\n${bold("Go live with")}`);
  console.log(`  npx mx402 ${parts.join(" ")}`);
  console.log(dim(`  (add --meter/--rate/--per to override what was detected, --tab to offer allowance-backed sessions)\n`));
}

// ── mx402 wallet new ──────────────────────────────────────────────────────

async function wallet(argv: string[]): Promise<void> {
  if (argv[0] !== "new") { console.error("usage: mx402 wallet new [--hbar 5]"); process.exit(1); }
  const hbar = Number(argv[argv.indexOf("--hbar") + 1]) || 5;
  const { hederaEnabled, initHedera, lookupAccount } = await import("./hedera.ts");
  if (!hederaEnabled()) {
    console.error("✖ set HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY in .env first (a funded testnet account from portal.hedera.com)");
    process.exit(1);
  }
  const { AccountCreateTransaction, Hbar, PrivateKey } = await import("@hiero-ledger/sdk");
  const client = initHedera();
  const key = PrivateKey.generateECDSA();
  const tx = await new AccountCreateTransaction().setKeyWithoutAlias(key.publicKey).setInitialBalance(new Hbar(hbar)).execute(client);
  const accountId = (await tx.getReceipt(client)).accountId!.toString();
  client.close();
  const acct = await lookupAccount(accountId);
  console.log(`\n${green("✓")} created ${bold(accountId)} with ${acct?.balance ?? hbar} HBAR`);
  console.log(`  https://hashscan.io/testnet/account/${accountId}`);
  console.log(`\n  add to .env:`);
  console.log(`  WALLET=${accountId}                 ${dim("# to be paid into")}`);
  console.log(`  BUYER_ACCOUNT_ID=${accountId}`);
  console.log(`  BUYER_PRIVATE_KEY=${key.toStringDer()}\n`);
}

// ── mx402 <url> --wallet … ────────────────────────────────────────────────

async function serve(argv: string[]): Promise<void> {
  const cfg: GatewayConfig = parseArgs(argv);
  // No --meter? Ask the API what it should be metered on.
  if (!argv.includes("--meter")) {
    const req = probeArgs(argv);
    process.stdout.write(dim(`probing ${req.upstream} to detect what to meter… `));
    const { detection } = await detect(req);
    if ("error" in detection) {
      console.log(red("failed"));
      console.error(`✖ ${detection.error}`);
      console.error(dim(`  pass --meter tokens|rows|bytes|ms|request to skip detection, or fix the sample request (--sample/--body/--header)`));
      process.exit(1);
    }
    console.log(green("done"));
    cfg.meter = detection.meter;
    if (!argv.includes("--rate")) cfg.card.rate = detection.rate;
    if (!argv.includes("--per")) cfg.card.per = detection.per;
    if (!argv.includes("--min") && detection.min) cfg.card.min = detection.min;
    if (!argv.includes("--max-units")) cfg.card.maxUnits = detection.maxUnits;
    console.log(dim(`  detected ${detection.meter}: ${detection.why}`));
    console.log(dim(`  pricing at ${describeRate({ unit: detection.unit, rate: String(cfg.card.rate), per: Number(cfg.card.per) })}, cap ${cfg.card.maxUnits} — override with --meter/--rate/--per/--max-units`));
  }
  try {
    await startGateway(cfg);
  } catch (e) {
    console.error(`${red("✖")} ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

// ── mx402 publish ─────────────────────────────────────────────────────────
// The seller's one command: detect the API's type, auth and meter, confirm the
// pricing, start the payment-enabled endpoint and register it for discovery.

async function publish(argv: string[]): Promise<void> {
  const { inferAuth, inferCapabilities, inferType } = await import("./protocol/describe.ts");
  const { HUB_URL } = await import("./events.ts");
  const req = probeArgs(argv);
  const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const registry = (flag("registry") ?? flag("hub") ?? HUB_URL).replace(/\/+$/, "");
  const ok = (s: string) => console.log(`${green("✓")} ${s}`);

  console.log(`\n${bold("mx402 publish")} ${dim(req.upstream)}\n`);
  const { probe: p, detection } = await detect(req);
  if (!p.ok && (p.status === 401 || p.status === 403)) {
    console.log(`${red("✖")} Authentication: the API answered ${p.status}, so it needs a key`);
    console.log(dim(`  pass it once here; it stays in your gateway and is never sent to buyers:`));
    console.log(dim(`  --header "Authorization: Bearer $KEY"   or   --query "apikey=$KEY"`));
    process.exit(1);
  }
  if ("error" in detection) { console.log(`${red("✖")} could not read the API: ${detection.error}`); process.exit(1); }

  const type = (flag("type") as any) ?? inferType(detection.unit, req.body);
  const auth = inferAuth(req.headers, req.query);
  const authLabel = {
    none: "none needed",
    bearer: "Bearer token (held by your gateway, never sent to buyers)",
    "api-key": "API key (held by your gateway, never sent to buyers)",
    header: "custom header (held by your gateway)",
  }[auth];
  ok(`API detected: ${type.toUpperCase()}, ${p.status} in ${Math.round(p.ms)}ms`);
  ok(`Authentication: ${authLabel}`);
  ok(`Meter detected: ${bold(detection.meter)} ${dim(`(${detection.why})`)}`);

  const card = {
    rate: flag("rate") ?? detection.rate,
    per: Number(flag("per") ?? detection.per),
    min: flag("min") ?? detection.min ?? "0",
    maxUnits: Number(flag("max-units") ?? detection.maxUnits),
  };
  const priced = () => `${describeRate({ unit: detection.unit, rate: String(card.rate), per: card.per })} ${dim(`(this call: ${priceOf(detection.measured, card)} HBAR; flat at the cap of ${card.maxUnits}: ${priceOf(card.maxUnits, card)} HBAR)`)}`;
  ok(`Suggested rate: ${priced()}`);

  // confirm or edit, unless told not to ask
  if (!argv.includes("--yes") && process.stdin.isTTY) {
    const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`  Accept this pricing? [Y/n/e = edit] `)).trim().toLowerCase();
    if (answer === "n") { rl.close(); console.log("  not published."); process.exit(0); }
    if (answer === "e") {
      card.rate = (await rl.question(`  rate (HBAR per ${card.per} ${detection.unit}) [${card.rate}]: `)).trim() || card.rate;
      card.per = Number((await rl.question(`  per [${card.per}]: `)).trim() || card.per);
      card.maxUnits = Number((await rl.question(`  seller cap per call [${card.maxUnits}]: `)).trim() || card.maxUnits);
      ok(`Rate: ${priced()}`);
    }
    rl.close();
  }

  const cfg: GatewayConfig = parseArgs(argv.filter((a) => a !== "--yes"));
  cfg.meter = flag("meter") ?? detection.meter;
  cfg.card = { ...cfg.card, rate: card.rate, per: card.per, min: card.min, maxUnits: card.maxUnits };
  cfg.type = type;
  cfg.hub = registry;
  if (!cfg.capabilities?.length) cfg.capabilities = inferCapabilities(req.upstream, type, req.sample);
  ok(`Settlement: ${cfg.tab ? "Hedera: HBAR per call (x402 exact) + Metered Tabs (allowance)" : "Hedera: HBAR per call (x402 exact via blocky402)"}`);

  let gw;
  try { gw = await startGateway({ ...cfg, quiet: true }); }
  catch (e) { console.log(`${red("✖")} ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
  const d = gw.descriptor;

  // wait for the registry to list it
  let registered = false;
  for (let i = 0; i < 25 && !registered; i++) {
    try { registered = (await fetch(`${registry}/registry/services/${d.service_id}`)).ok; } catch {}
    if (!registered) await new Promise((r) => setTimeout(r, 200));
  }
  if (registered) ok(`Service registered in ${registry} ${dim(`(capabilities: ${d.capabilities.join(", ")})`)}`);
  else console.log(`${red("!")} registry unreachable at ${registry}: serving, but agents cannot discover it (start a hub, or pass --registry)`);

  console.log(`
  Service ID        ${bold(d.service_id)}
  Payment endpoint  ${bold(d.endpoint)}${d.sample?.path && d.sample.path !== "/" ? dim(d.sample.path) : ""}
  Descriptor        ${d.links.descriptor}
  A2A agent card    ${d.links.a2a_card}
  MCP               listed by the MeterX402 MCP server (list_services, call_service)
${dim("  Ctrl+C to stop selling.")}
`);
}


// ── mx402 data ────────────────────────────────────────────────────────────
// A dataset is rows, and rows is the meter this project counts best. So a file
// becomes a queryable, metered API with the same machinery as any other
// service: same descriptor, same registry, same receipts.

async function data(argv: string[]): Promise<void> {
  const { loadDataset, serveDataset } = await import("./data.ts");
  const { HUB_URL } = await import("./events.ts");
  const { wrap } = await import("./sdk/seller.ts");
  const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const file = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
  const ok = (s: string) => console.log(`${green("✓")} ${s}`);

  if (!file) { console.error("usage: mx402 data <file.csv|.json|.jsonl> --wallet <account>"); process.exit(1); }
  const wallet = flag("wallet") ?? flag("pay-to") ?? process.env.WALLET;
  if (!wallet) { console.error("--wallet <your payout account> is required (payments settle there)"); process.exit(1); }

  console.log(`
${bold("mx402 data")} ${dim(file)}
`);
  let ds;
  try { ds = loadDataset(file); }
  catch (e) { console.log(`${red("✖")} ${String((e as Error)?.message ?? e)}`); process.exit(1); }

  ok(`Read ${bold(ds.rows.length.toLocaleString())} rows × ${bold(String(ds.columns.length))} columns ${dim(`(${ds.format}, ${(ds.bytes / 1000).toFixed(1)} KB)`)}`);
  const w = Math.min(22, Math.max(...ds.columns.map((c) => c.name.length)));
  for (const c of ds.columns.slice(0, 12)) {
    console.log(`  ${c.name.padEnd(w)} ${dim(c.type.padEnd(8))} ${dim(c.examples.map((e) => String(e)).join(", ").slice(0, 46))}`);
  }
  if (ds.columns.length > 12) console.log(dim(`  … and ${ds.columns.length - 12} more`));

  const rate = flag("rate", "0.0001")!;
  const perCall = Number(flag("limit", "50"));
  const maxRows = Number(flag("max-rows", "1000"));
  const price = (n: number) => priceOf(n, { rate, per: 1, min: "0" });
  console.log(`
${bold("What buyers would pay")}`);
  console.log(`  a ${perCall}-row page      ${bold(price(perCall).padStart(12))} HBAR`);
  console.log(`  the whole dataset  ${bold(price(ds.rows.length).padStart(12))} HBAR ${dim(`(${ds.rows.length.toLocaleString()} rows, over ${Math.ceil(ds.rows.length / maxRows)} calls)`)}`);
  console.log(dim(`  the schema and a 3-row sample are free: zero rows metered, so nothing to pay`));

  const data = await serveDataset(ds, { defaultLimit: perCall, maxLimit: maxRows });
  const title = flag("title") ?? ds.name.replace(/[-_]+/g, " ").replace(/\w/g, (c) => c.toUpperCase());
  const name = flag("name") ?? ds.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const registry = (flag("registry") ?? flag("hub") ?? HUB_URL).replace(/\/+$/, "");

  const svc = await wrap({
    upstream: data.url,
    sample: `/?limit=${perCall}`,
    wallet,
    meter: "rows:rows",
    rate, per: 1, min: flag("min", "0"), maxUnits: maxRows,
    name, title,
    unitLabel: "row",
    description: flag("description") ?? `${ds.rows.length.toLocaleString()} rows of ${title.toLowerCase()}, queryable and priced per row returned.`,
    capabilities: (flag("capability") ? [flag("capability")!] : ["dataset"]),
    dataset: { rows: ds.rows.length, format: ds.format, columns: ds.columns.map((c) => ({ name: c.name, type: c.type })) },
    port: Number(flag("port", "0")) || undefined,
    registry,
    quiet: true,
  });

  ok(`Serving ${bold(svc.url)} ${dim(`→ ${data.url}`)}`);
  console.log(`
${bold("Buyers call")}`);
  console.log(`  ${dim("free  ")} curl ${svc.url}/schema`);
  console.log(`  ${dim("paid  ")} curl '${svc.url}/?limit=10&where=${ds.columns[0]?.name}:contains:a&sort=${ds.columns[0]?.name}'`);
  console.log(`
${dim("Ctrl-C to stop serving. The dataset stays on this machine; only the rows a buyer pays for leave it.")}
`);

  const stop = async () => { await svc.close(); await data.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ── mx402 inspect ─────────────────────────────────────────────────────────

async function inspect(argv: string[]): Promise<void> {
  const { HUB_URL } = await import("./events.ts");
  const target = argv.find((a) => !a.startsWith("--"));
  const i = argv.indexOf("--registry");
  const registry = (i >= 0 ? argv[i + 1] : HUB_URL).replace(/\/+$/, "");
  if (!target) { console.error("usage: mx402 inspect <service-id | gateway-url> [--registry url]"); process.exit(1); }
  let listing: any;
  if (/^https?:\/\//.test(target)) {
    const d = await fetch(`${target.replace(/\/+$/, "")}/.well-known/mx402`).then((r) => r.json()).catch(() => null);
    if (!d?.service_id) { console.error(`✖ ${target} does not serve a MeterX402 descriptor`); process.exit(1); }
    listing = (await fetch(`${registry}/registry/services/${d.service_id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)) ?? { descriptor: d };
  } else {
    const r = await fetch(`${registry}/registry/services/${encodeURIComponent(target)}`).catch(() => null);
    if (!r?.ok) { console.error(`✖ no service "${target}" in ${registry}`); process.exit(1); }
    listing = await r.json();
  }
  const d = listing.descriptor, rep = listing.reputation;
  console.log(`\n${bold(d.name)} ${dim(`(${d.service_id})`)}  ${d.description ?? ""}`);
  console.log(`  type          ${d.type}   interfaces ${d.interfaces.join(", ")}`);
  console.log(`  capabilities  ${d.capabilities.join(", ")}`);
  console.log(`  pricing       ${d.pricing.rate} ${d.pricing.currency} per ${d.pricing.per === 1 ? "" : d.pricing.per + " "}${d.pricing.unit} ${dim(`(meter ${d.pricing.meter}, min ${d.pricing.min}, cap ${d.pricing.max_units ?? "none"})`)}`);
  console.log(`  settlement    ${d.payment.settlement.map((o: any) => `${o.currency} on ${o.network} [${o.schemes.join("+")}]`).join("; ")}${d.payment.streaming ? " · streaming" : ""}`);
  console.log(`  endpoint      ${d.endpoint}   owner ${d.owner.account}`);
  if (listing.price) console.log(`  typical call  ${listing.price.typical_call ?? "no payments yet"} ${d.pricing.currency}   worst case ${listing.price.worst_case_call ?? "uncapped"}`);
  if (rep) {
    console.log(`  reputation    ${bold(rep.score == null ? "unrated" : `${rep.score}/100`)} ${dim(`(${rep.confidence} confidence, ${rep.sample_size} samples)`)}`);
    for (const [k, v] of Object.entries(rep.components)) console.log(dim(`                ${k.padEnd(20)} ${(Number(v) * 100).toFixed(0).padStart(3)}%  x ${rep.weights[k]}`));
    console.log(dim(`                ${rep.stats.paid_calls} paid calls, ${rep.stats.upstream_errors} upstream errors, ${rep.stats.disputes} disputes, median ${rep.stats.median_latency_ms ?? "-"} ms, uptime ${rep.stats.uptime_ratio ?? "-"}`));
    if (rep.anchor) console.log(dim(`                anchored on HCS topic ${rep.anchor.topic_id}, tx ${rep.anchor.transaction_id}`));
  }
  console.log();
}
