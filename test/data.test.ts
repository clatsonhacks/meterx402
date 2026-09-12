// Selling a dataset: reading it, typing it, querying it, and the property that
// makes the whole thing work — looking is free, because zero rows cost zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsv, inferColumns, loadDataset, parseQuery, runQuery, serveDataset, type Dataset } from "../src/data.ts";
import { priceAtomic } from "../src/pricing.ts";

const dir = mkdtempSync(join(tmpdir(), "mx402-data-"));
const write = (name: string, body: string) => { const p = join(dir, name); writeFileSync(p, body); return p; };

// ── reading what real files contain ──────────────────────────────────────
test("CSV: quoted commas, escaped quotes, CRLF and a BOM", () => {
  const rows = parseCsv('﻿city,note,n\r\n"Chennai, TN","he said ""hi""",3\r\nLondon,plain,4\r\n');
  assert.deepEqual(rows, [
    { city: "Chennai, TN", note: 'he said "hi"', n: "3" },
    { city: "London", note: "plain", n: "4" },
  ]);
});

test("CSV: newlines inside quotes stay inside the field", () => {
  const rows = parseCsv('a,b\n"line one\nline two",x\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, "line one\nline two");
});

test("CSV: blank lines are skipped, missing trailing fields are empty", () => {
  const rows = parseCsv("a,b,c\n1,2,3\n\n4,5\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { a: "4", b: "5", c: "" });
});

test("CSV: unnamed columns still get a name", () => {
  assert.deepEqual(Object.keys(parseCsv("a,,c\n1,2,3\n")[0]), ["a", "column_2", "c"]);
});

// ── working out what the columns hold ────────────────────────────────────
test("types come from the values, not a declaration", () => {
  const cols = inferColumns([
    { city: "Chennai", temp: "30.1", wet: "true", at: "2026-09-01 00:00", note: "" },
    { city: "London", temp: "14", wet: "false", at: "2026-09-01 01:00", note: "x" },
  ]);
  const t = Object.fromEntries(cols.map((c) => [c.name, c.type]));
  assert.deepEqual(t, { city: "string", temp: "number", wet: "boolean", at: "date", note: "string" });
  assert.equal(cols.find((c) => c.name === "note")!.nulls, 1, "empty values are counted as missing");
});

test("one bad value makes a column a string, not a silent NaN", () => {
  const [c] = inferColumns([{ n: "1" }, { n: "2" }, { n: "n/a" }]);
  assert.equal(c.type, "string");
});

// ── loading files ────────────────────────────────────────────────────────
test("CSV values arrive typed, not as strings", () => {
  const ds = loadDataset(write("t.csv", "city,temp,wet\nChennai,30.1,true\nLondon,,false\n"));
  assert.equal(ds.format, "csv");
  assert.equal(ds.rows[0].temp, 30.1);
  assert.equal(ds.rows[0].wet, true);
  assert.equal(ds.rows[1].temp, null, "an empty cell is null, not 0 or an empty string");
});

test("JSON array, JSONL, and an array nested in an object all load", () => {
  assert.equal(loadDataset(write("a.json", '[{"a":1},{"a":2}]')).rows.length, 2);
  assert.equal(loadDataset(write("b.jsonl", '{"a":1}\n{"a":2}\n')).rows.length, 2);
  assert.equal(loadDataset(write("c.json", '{"meta":{"x":1},"data":{"items":[{"a":1},{"a":2},{"a":3}]}}')).rows.length, 3);
});

test("unreadable files fail with something a person can act on", () => {
  assert.throws(() => loadDataset(write("e.jsonl", '{"a":1}\nnot json\n')), /line 3 is not valid JSON/);
  assert.throws(() => loadDataset(write("f.json", '{"a":1}')), /no array of records/);
  assert.throws(() => loadDataset(write("g.csv", "a,b\n")), /no rows/);
});

// ── querying ─────────────────────────────────────────────────────────────
const ds: Dataset = {
  name: "t", format: "json", bytes: 0,
  rows: [
    { city: "Chennai", temp: 30, wet: false },
    { city: "London", temp: 14, wet: true },
    { city: "Tokyo", temp: 22, wet: false },
    { city: "Chennai", temp: 33, wet: true },
  ],
  columns: [],
};
const q = (s: string) => parseQuery(new URLSearchParams(s), { limit: 50, maxLimit: 100 });

test("every filter operator does what it says", () => {
  const only = (s: string) => runQuery(ds, q(s)).rows.map((r) => `${r.city}:${r.temp}`);
  assert.deepEqual(only("where=city:eq:chennai"), ["Chennai:30", "Chennai:33"], "eq ignores case");
  assert.deepEqual(only("where=city:ne:Chennai"), ["London:14", "Tokyo:22"]);
  assert.deepEqual(only("where=temp:gt:22"), ["Chennai:30", "Chennai:33"]);
  assert.deepEqual(only("where=temp:gte:22"), ["Chennai:30", "Tokyo:22", "Chennai:33"]);
  assert.deepEqual(only("where=temp:lt:22"), ["London:14"]);
  assert.deepEqual(only("where=temp:lte:22"), ["London:14", "Tokyo:22"]);
  assert.deepEqual(only("where=city:contains:on"), ["London:14"]);
  assert.deepEqual(only("where=city:starts:to"), ["Tokyo:22"]);
});

test("filters combine, and sort, select and paging apply after them", () => {
  const r = runQuery(ds, q("where=city:eq:Chennai&where=temp:gt:31&select=city,temp"));
  assert.deepEqual(r.rows, [{ city: "Chennai", temp: 33 }], "select drops the columns not asked for");
  assert.deepEqual(runQuery(ds, q("sort=temp:desc")).rows.map((x) => x.temp), [33, 30, 22, 14]);
  assert.deepEqual(runQuery(ds, q("sort=city")).rows.map((x) => x.city), ["Chennai", "Chennai", "London", "Tokyo"]);
  const page = runQuery(ds, q("limit=2&offset=1&sort=temp"));
  assert.deepEqual(page.rows.map((x) => x.temp), [22, 30]);
  assert.equal(page.total, 4, "total is what matched, not what was returned");
});

test("the seller's row cap binds, and a bad filter is refused clearly", () => {
  assert.equal(q("limit=9999").limit, 100, "maxLimit wins");
  assert.throws(() => q("where=temp:roughly:20"), /bad filter/);
  assert.throws(() => q("where=:eq:x"), /bad filter/);
});

// ── the property the free preview rests on ───────────────────────────────
test("zero rows costs nothing, even with a minimum set", () => {
  const card = { rate: "0.0002", per: 1, min: "0.001" };
  assert.equal(priceAtomic(0, card), 0n, "a schema call bills nothing");
  assert.equal(priceAtomic(1, card), 100000n, "one row still pays the minimum");
  assert.equal(priceAtomic(10, card), 200000n);
});

// ── serving ──────────────────────────────────────────────────────────────
test("/schema is free to read and says what the data is", async () => {
  const srv = await serveDataset(ds, { defaultLimit: 2, maxLimit: 3 });
  try {
    const s = await fetch(`${srv.url}/schema`).then((r) => r.json() as any);
    assert.equal(s.rows_total, 4);
    assert.equal(s.sample.length, 3, "three rows, so a buyer can see the shape");
    assert.ok(!("rows" in s), "no rows key, so the meter counts nothing and the gateway serves it free");

    const page = await fetch(`${srv.url}/?limit=99`).then((r) => r.json() as any);
    assert.equal(page.rows.length, 3, "the seller's cap binds even when the buyer asks for more");
    assert.equal(page.total, 4);

    const bad = await fetch(`${srv.url}/?where=nope`);
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${srv.url}/nowhere`)).status, 404);
  } finally { await srv.close(); }
});
