// Sell a dataset, not an API.
//
// The rest of this project meters someone else's API. This turns a file you
// already own — a CSV of weather readings, a JSONL export, a JSON array — into
// a metered API in the same marketplace, priced per row the buyer actually
// receives. It is the most natural fit for the whole idea: a dataset IS rows,
// and rows is the meter we count best.
//
// Three endpoints, and the payment path needs no special case for any of them:
//
//   GET /schema   columns with their types, range, spread and null count, the
//                 row total, and a sample spread through the file.
//   GET /count    how many rows a filter matches, so "what would this cost?"
//                 is answerable before paying rather than after.
//   GET /?…       the query itself: filter, sort, select, page, or group and
//                 aggregate. This is the only one that costs anything.
//
// The first two are free because they carry no rows: the meter counts zero,
// priceAtomic returns 0 for zero units even with a minimum set, and the
// gateway already serves free anything that costs nothing.
//
// Priced by CELLS, not rows — values returned, so asking for two columns out of
// eight costs a quarter of asking for all of them. Paying for the data you
// actually take is the whole argument of this project, and rows alone cannot
// express it.
//
// Honest about what this is: once a buyer has the rows, they have them. Metering
// prices access, it does not control redistribution. Aggregates are the answer
// to that — sell the average and keep the readings.

import { createServer, type Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export type ColumnType = "number" | "boolean" | "date" | "string";
export interface Column {
  name: string; type: ColumnType; nulls: number; examples: unknown[];
  /** Free quality signals: enough to judge a column without buying a row. */
  distinct?: number; min?: number | string; max?: number | string; mean?: number;
}
export interface Dataset {
  name: string;
  format: "csv" | "json" | "jsonl";
  rows: Record<string, unknown>[];
  columns: Column[];
  bytes: number;
}

/** Refuse politely rather than dying on a 4 GB file. */
export const MAX_BYTES = 256 * 1024 * 1024;

// ── reading ──────────────────────────────────────────────────────────────

/** A CSV parser that handles the things real CSVs actually contain: quoted
 *  fields, commas and newlines inside quotes, "" escapes, CRLF and a BOM. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h, i) => h.trim() || `column_${i + 1}`);
  return rows.slice(1)
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const isNum = (v: string) => v !== "" && Number.isFinite(Number(v));
const isBool = (v: string) => /^(true|false)$/i.test(v);
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(v);

/** What each column holds, decided from the values rather than declared. */
export function inferColumns(rows: Record<string, unknown>[], sampleSize = 500): Column[] {
  const names: string[] = [];
  for (const r of rows.slice(0, sampleSize)) for (const k of Object.keys(r)) if (!names.includes(k)) names.push(k);
  return names.map((name) => {
    const vals = rows.slice(0, sampleSize).map((r) => r[name]);
    const present = vals.filter((v) => v !== "" && v != null);
    const strs = present.map((v) => String(v));
    const type: ColumnType = !strs.length ? "string"
      : strs.every((v) => typeof v === "string" ? isNum(v) : false) || present.every((v) => typeof v === "number") ? "number"
      : strs.every(isBool) ? "boolean"
      : strs.every(isDate) ? "date"
      : "string";
    const col: Column = {
      name, type,
      nulls: vals.length - present.length,
      examples: present.slice(0, 3).map((v) => coerce(String(v), type)),
    };
    // Stats over the whole column, not the type sample, and given away free:
    // a buyer cannot judge a column from its name.
    const all = rows.map((r) => r[name]).filter((v) => v !== "" && v != null);
    col.distinct = new Set(all.map((v) => String(v))).size;
    if (type === "number") {
      const nums = all.map(Number).filter(Number.isFinite);
      if (nums.length) {
        col.min = Math.min(...nums);
        col.max = Math.max(...nums);
        col.mean = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 1000) / 1000;
      }
    } else if (all.length) {
      const strs = all.map(String).sort();
      col.min = strs[0];
      col.max = strs[strs.length - 1];
    }
    return col;
  });
}

const coerce = (v: string, t: ColumnType): unknown =>
  t === "number" ? Number(v) : t === "boolean" ? /^true$/i.test(v) : v;

/** Read a dataset off disk. CSV values become typed; JSON keeps its own types. */
export function loadDataset(path: string): Dataset {
  const st = statSync(path);
  if (st.size > MAX_BYTES) {
    throw new Error(`${basename(path)} is ${(st.size / 1e6).toFixed(0)} MB; this serves datasets up to ${MAX_BYTES / 1e6} MB in memory`);
  }
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  let rows: Record<string, unknown>[];
  let format: Dataset["format"];

  if (ext === ".csv" || ext === ".tsv") {
    format = "csv";
    rows = parseCsv(ext === ".tsv" ? text.replace(/\t/g, ",") : text);
  } else if (ext === ".jsonl" || ext === ".ndjson") {
    format = "jsonl";
    rows = text.split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
      try { return JSON.parse(l); } catch { throw new Error(`line ${i + 2} is not valid JSON`); }
    });
  } else {
    format = "json";
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : largestArray(parsed);
    if (!Array.isArray(arr)) throw new Error("no array of records found in that JSON");
    rows = arr as Record<string, unknown>[];
  }
  if (!rows.length) throw new Error("that file has no rows");
  const columns = inferColumns(rows);
  // CSV arrives as strings; give buyers real numbers and booleans
  if (format === "csv") {
    const typed = new Map(columns.map((c) => [c.name, c.type]));
    rows = rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) out[k] = v === "" ? null : coerce(String(v), typed.get(k) ?? "string");
      return out;
    });
  }
  return { name: basename(path, extname(path)), format, rows, columns, bytes: st.size };
}

function largestArray(v: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object" || depth > 4) return null;
  let best: unknown[] | null = null;
  for (const x of Object.values(v as Record<string, unknown>)) {
    const found = largestArray(x, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

// ── querying ─────────────────────────────────────────────────────────────

export type Op = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "starts";
export type AggFn = "count" | "sum" | "avg" | "min" | "max";
export interface Agg { fn: AggFn; col: string }
export interface Query {
  limit: number; offset: number; select?: string[];
  where: { col: string; op: Op; value: string }[];
  sort?: { col: string; desc: boolean };
  /** Group and aggregate instead of handing over rows. */
  group?: string[];
  agg: Agg[];
}

const OPS = new Set<Op>(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "starts"]);
const AGGS = new Set<AggFn>(["count", "sum", "avg", "min", "max"]);

/** `?limit=&offset=&select=a,b&where=col:op:value&sort=col:desc` */
export function parseQuery(params: URLSearchParams, defaults: { limit: number; maxLimit: number }): Query {
  // Number(null) is 0 and 0 >= 0, so a missing limit would silently become a
  // zero-row page: absent has to be checked before the value is read.
  const n = (k: string, d: number) => {
    const raw = params.get(k);
    if (raw == null || raw.trim() === "") return d;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const where: Query["where"] = [];
  for (const raw of params.getAll("where")) {
    const [col, op, ...rest] = raw.split(":");
    if (!col || !OPS.has(op as Op)) throw new Error(`bad filter "${raw}": use col:op:value with op one of ${[...OPS].join(", ")}`);
    where.push({ col, op: op as Op, value: rest.join(":") });
  }
  const agg: Agg[] = [];
  for (const raw of params.getAll("agg")) {
    for (const one of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [fn, col] = one.split(":");
      if (!AGGS.has(fn as AggFn)) throw new Error(`bad aggregate "${one}": use fn:column with fn one of ${[...AGGS].join(", ")}`);
      if (fn !== "count" && !col) throw new Error(`${fn} needs a column, e.g. ${fn}:temp_c`);
      agg.push({ fn: fn as AggFn, col: col ?? "*" });
    }
  }
  const group = params.get("group")?.split(",").map((x) => x.trim()).filter(Boolean);
  const sortRaw = params.get("sort");
  const [sortCol, sortDir] = (sortRaw ?? "").split(":");
  return {
    group: group?.length ? group : undefined,
    agg,
    limit: Math.min(n("limit", defaults.limit), defaults.maxLimit),
    offset: n("offset", 0),
    select: params.get("select")?.split(",").map((s) => s.trim()).filter(Boolean),
    where,
    sort: sortCol ? { col: sortCol, desc: /^desc$/i.test(sortDir ?? "") } : undefined,
  };
}

const cmp = (a: unknown, b: string): number => {
  const x = Number(a), y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return String(a ?? "").localeCompare(b);
};

/** Rows that match the filters, before paging: what /count answers, free. */
export function matching(ds: Dataset, q: Pick<Query, "where">): Record<string, unknown>[] {
  let rows = ds.rows;
  for (const f of q.where) {
    rows = rows.filter((r) => {
      const v = r[f.col];
      switch (f.op) {
        case "eq": return String(v ?? "").toLowerCase() === f.value.toLowerCase();
        case "ne": return String(v ?? "").toLowerCase() !== f.value.toLowerCase();
        case "gt": return cmp(v, f.value) > 0;
        case "gte": return cmp(v, f.value) >= 0;
        case "lt": return cmp(v, f.value) < 0;
        case "lte": return cmp(v, f.value) <= 0;
        case "contains": return String(v ?? "").toLowerCase().includes(f.value.toLowerCase());
        case "starts": return String(v ?? "").toLowerCase().startsWith(f.value.toLowerCase());
      }
    });
  }
  return rows;
}

export function runQuery(ds: Dataset, q: Query): { rows: Record<string, unknown>[]; total: number; grouped?: boolean } {
  let rows = matching(ds, q);

  // Aggregating sells the answer rather than the data: 2,160 readings become
  // three rows of averages, which costs the buyer less and leaves the seller
  // still holding the dataset.
  if (q.agg.length || q.group?.length) {
    const keyOf = (r: Record<string, unknown>) => (q.group ?? []).map((g) => String(r[g] ?? "")).join("\u0000");
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = groups.get(k);
      if (g) g.push(r); else groups.set(k, [r]);
    }
    const out: Record<string, unknown>[] = [];
    for (const members of groups.values()) {
      const row: Record<string, unknown> = {};
      for (const g of q.group ?? []) row[g] = members[0][g];
      for (const a of q.agg) {
        const label = a.fn === "count" ? "count" : `${a.fn}_${a.col}`;
        if (a.fn === "count") { row[label] = members.length; continue; }
        const nums = members.map((m) => Number(m[a.col])).filter(Number.isFinite);
        if (!nums.length) { row[label] = null; continue; }
        row[label] =
          a.fn === "sum" ? round(nums.reduce((x, y) => x + y, 0))
          : a.fn === "avg" ? round(nums.reduce((x, y) => x + y, 0) / nums.length)
          : a.fn === "min" ? Math.min(...nums)
          : Math.max(...nums);
      }
      out.push(row);
    }
    const total = out.length;
    const sorted = q.sort ? sortRows(out, q.sort) : out;
    return { rows: sorted.slice(q.offset, q.offset + q.limit), total, grouped: true };
  }

  if (q.sort) {
    const { col, desc } = q.sort;
    rows = [...rows].sort((a, b) => {
      const x = a[col], y = b[col];
      const n = Number(x), m = Number(y);
      const r = Number.isFinite(n) && Number.isFinite(m) ? n - m : String(x ?? "").localeCompare(String(y ?? ""));
      return desc ? -r : r;
    });
  }
  const total = rows.length;
  rows = rows.slice(q.offset, q.offset + q.limit);
  if (q.select?.length) rows = rows.map((r) => Object.fromEntries(q.select!.map((k) => [k, r[k]])));
  return { rows, total };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
function sortRows(rows: Record<string, unknown>[], { col, desc }: { col: string; desc: boolean }) {
  return [...rows].sort((a, b) => {
    const x = a[col], y = b[col];
    const n = Number(x), m = Number(y);
    const r = Number.isFinite(n) && Number.isFinite(m) ? n - m : String(x ?? "").localeCompare(String(y ?? ""));
    return desc ? -r : r;
  });
}

/** A spread through the file rather than the first few rows: on sorted data
 *  the head is all one city, which tells a buyer nothing about the rest. */
export function stratifiedSample(rows: Record<string, unknown>[], n = 3): Record<string, unknown>[] {
  if (rows.length <= n) return rows;
  const step = Math.floor(rows.length / n);
  return Array.from({ length: n }, (_, i) => rows[i * step]);
}

// ── serving ──────────────────────────────────────────────────────────────

export interface DataServer { url: string; port: number; dataset: Dataset; close(): Promise<void>; server: Server }

/** Serve a dataset on loopback. The metered gateway sits in front of it. */
export function serveDataset(ds: Dataset, opts: { port?: number; defaultLimit?: number; maxLimit?: number } = {}): Promise<DataServer> {
  const defaultLimit = opts.defaultLimit ?? 50;
  const maxLimit = opts.maxLimit ?? 1000;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/schema") {
      // No `rows` key, so the meter counts nothing and the gateway serves it
      // free: buyers can always see what they would be paying for.
      return send(200, {
        dataset: ds.name, format: ds.format, rows_total: ds.rows.length, bytes: ds.bytes,
        columns: ds.columns,
        sample: stratifiedSample(ds.rows, 3),
        query: {
          limit: `rows per call (default ${defaultLimit}, max ${maxLimit})`,
          offset: "skip this many rows",
          select: "comma-separated columns — fewer columns, fewer cells, lower price",
          where: `col:op:value, repeatable — ${[...OPS].join(", ")}`,
          sort: "col or col:desc",
          group: "comma-separated columns to group by",
          agg: `fn:column, repeatable — ${[...AGGS].join(", ")}`,
        },
        free: ["/schema", "/count"],
      });
    }
    // How many rows a filter matches. Carries no rows, so it is free — which
    // is what makes the price knowable before the buyer commits to it.
    if (url.pathname === "/count") {
      try {
        const q = parseQuery(url.searchParams, { limit: defaultLimit, maxLimit });
        const matched = matching(ds, q).length;
        const cols = q.select?.length ? q.select.length : ds.columns.length;
        return send(200, {
          matched, of: ds.rows.length,
          columns_selected: cols,
          // what a page of this query would actually be metered as
          cells_per_page: Math.min(matched, q.limit) * cols,
          cells_all: matched * cols,
          limit: q.limit,
        });
      } catch (e) {
        return send(400, { error: String((e as Error)?.message ?? e) });
      }
    }
    if (url.pathname !== "/") return send(404, { error: "not_found", try: ["/", "/schema", "/count"] });
    try {
      const q = parseQuery(url.searchParams, { limit: defaultLimit, maxLimit });
      const { rows, total, grouped } = runQuery(ds, q);
      const cells = rows.reduce((n, r) => n + Object.keys(r).length, 0);
      send(200, { rows, total, limit: q.limit, offset: q.offset, returned: rows.length, cells, ...(grouped ? { grouped: true } : {}) });
    } catch (e) {
      send(400, { error: String((e as Error)?.message ?? e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`, port, dataset: ds, server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
