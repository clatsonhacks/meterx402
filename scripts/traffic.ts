// Drive varied, realistic traffic through the hub's test buyer, so the
// dashboard has something to show:  npx tsx scripts/traffic.ts [count]
// Works against the offline demo (npm run demo:offline) or a live hub.

const HUB = process.env.MX_HUB ?? "http://127.0.0.1:4021";
const n = Number(process.argv[2] ?? 24);
const { lanes } = await fetch(`${HUB}/lanes`).then((r) => r.json());
const byName = Object.fromEntries(lanes.map((l: any) => [l.name, l]));
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

const jobs: (() => Record<string, unknown> | null)[] = [
  () => byName.llm && {
    url: `http://127.0.0.1:${byName.llm.port}/v1/chat/completions`, method: "POST",
    body: JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: `Summarise the news in ${pick([8, 15, 40, 90, 160, 300, 700])} words` }] }),
    maxUnits: pick([undefined, undefined, 200, 500]),
  },
  () => byName.pools && {
    url: `http://127.0.0.1:${byName.pools.port}/`, method: "POST",
    body: JSON.stringify({ query: `{ pools(first: ${pick([1, 3, 5, 10, 25])}) { id totalValueLockedUSD } }` }),
  },
  () => byName.blob && { url: `http://127.0.0.1:${byName.blob.port}/blob?kb=${pick([1, 4, 16, 64])}`, method: "GET" },
  () => byName["price-flat"] && { url: `http://127.0.0.1:${byName["price-flat"].port}/price?i=${Math.random()}`, method: "GET" },
];

let paid = 0;
for (let i = 0; i < n; i++) {
  const job = pick(jobs)();
  if (!job) continue;
  const r = await fetch(`${HUB}/testbuyer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) }).then((x) => x.json());
  if (r.paid) paid++;
  const rc = r.receipt;
  console.log(r.paid ? `💸 ${rc.billable} ${rc.unit} → ${rc.amount} ${rc.currency}` : `– ${r.error ?? r.status}`);
}
console.log(`${paid}/${n} paid`);
