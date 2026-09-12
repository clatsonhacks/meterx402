// Sell a dataset, not an API.
//
// The rest of this project meters someone else's API. This turns a file you
// already own — a CSV of weather readings, a JSONL export, a JSON array — into
// a metered API in the same marketplace, priced per row the buyer actually
// receives. It is the most natural fit for the whole idea: a dataset IS rows,
// and rows is the meter we count best.
//
// Two endpoints, and the payment path needs no special case for either:
//
//   GET /schema   columns, types, row count and three sample rows. The `rows`
//                 meter counts zero here, priceAtomic returns 0 for zero units
//                 even when a minimum is set, and the gateway serves anything
//                 free that costs nothing. So buyers can always see what they
//                 would be buying before they pay for it.
//   GET /?…       the query: filter, sort, select, page. Priced per row back.
//
// Honest about what this is: once a buyer has the rows, they have them. Per-row
// pricing meters access, it does not control redistribution, and this file
// makes no attempt to pretend otherwise.

import { createServer, type Server } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export type ColumnType = "number" | "boolean" | "date" | "string";
export interface Column { name: string; type: ColumnType; nulls: number; examples: unknown[] }
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
    return {
      name, type,
      nulls: vals.length - present.length,
      examples: present.slice(0, 3).map((v) => coerce(String(v), type)),
    };
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
export interface Query { limit: number; offset: number; select?: string[]; where: { col: string; op: Op; value: string }[]; sort?: { col: string; desc: boolean } }

const OPS = new Set<Op>(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "starts"]);

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
  const sortRaw = params.get("sort");
  const [sortCol, sortDir] = (sortRaw ?? "").split(":");
  return {
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

export function runQuery(ds: Dataset, q: Query): { rows: Record<string, unknown>[]; total: number } {
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
        sample: ds.rows.slice(0, 3),
        query: {
          limit: `rows per call (default ${defaultLimit}, max ${maxLimit})`,
          offset: "skip this many rows",
          select: "comma-separated columns",
          where: `col:op:value, repeatable — ${[...OPS].join(", ")}`,
          sort: "col or col:desc",
        },
      });
    }
    if (url.pathname !== "/") return send(404, { error: "not_found", try: ["/", "/schema"] });
    try {
      const q = parseQuery(url.searchParams, { limit: defaultLimit, maxLimit });
      const { rows, total } = runQuery(ds, q);
      send(200, { rows, total, limit: q.limit, offset: q.offset, returned: rows.length });
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
