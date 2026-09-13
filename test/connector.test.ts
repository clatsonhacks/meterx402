// mx402 connector: the REST/OpenAPI surface for ChatGPT Actions and the VS Code
// extension. It must refuse anything but /health and /openapi.json without the
// bearer token, since a tunnel exposes it to the internet with the user's key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { startConnector } from "../src/connector.ts";

test("connector: spec is public, everything else needs the token", async () => {
  const c = await startConnector({ port: 0, token: "t0k3n-for-tests", registry: "http://127.0.0.1:9" });
  const base = `http://127.0.0.1:${c.port}`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const spec = await fetch(`${base}/openapi.json`, { headers: { "x-forwarded-host": "abc.ngrok.app" } }).then((r) => r.json());
    assert.equal(spec.servers[0].url, "https://abc.ngrok.app");
    const ops = Object.values(spec.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    assert.deepEqual(ops.sort(), ["callService", "getQuote", "getService", "getWallet", "listServices", "payQuote"]);
    assert.equal(spec.components.securitySchemes.bearer.scheme, "bearer");

    for (const [path, init] of [["/services", {}], ["/wallet", {}], ["/call", { method: "POST", body: "{}" }], ["/pay", { method: "POST", body: "{}" }]] as const) {
      const r = await fetch(`${base}${path}`, init);
      assert.equal(r.status, 401, `${path} without a token`);
      const wrong = await fetch(`${base}${path}`, { ...init, headers: { authorization: "Bearer nope" } });
      assert.equal(wrong.status, 401, `${path} with a wrong token`);
    }

    const auth = { authorization: "Bearer t0k3n-for-tests", "content-type": "application/json" };
    const noId = await fetch(`${base}/call`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(noId.status, 400);
    const expired = await fetch(`${base}/pay`, { method: "POST", headers: auth, body: JSON.stringify({ quote_id: "missing" }) });
    assert.equal(expired.status, 404);
  } finally {
    c.close();
  }
});

test("sellers are warned when a Solana payout wallet has no USDC token account", async () => {
  const { solanaUsdcAccount } = await import("../src/settlement/verify-chains.ts");
  const devnet = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
  const rpc = (value: unknown[]) => (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.method, "getTokenAccountsByOwner");
    assert.equal(body.params[1].mint, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }));
  }) as typeof fetch;
  assert.equal(await solanaUsdcAccount(devnet, "NewWallet111", { fetch: rpc([]) }), false);
  assert.equal(await solanaUsdcAccount(devnet, "Funded111", { fetch: rpc([{ pubkey: "ata" }]) }), true);
  const down = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal(await solanaUsdcAccount(devnet, "Any", { fetch: down }), null);
});
