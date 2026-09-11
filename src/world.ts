// World ID: is a real, unique human behind this caller? (ported from GlassBox402)
//
//   verifyWorldProof()    async, network. Runs ONCE, in the hub, when the buyer
//                         completes a World ID flow. Talks to World's cloud verify.
//   verifySessionToken()  sync, local. Runs on EVERY request, in the gateway.
//
// The hub verifies once and mints a short-lived HMAC token bound to the
// rp-scoped nullifier; the gateway checks that signature locally per request.
// So human pricing adds no network hop, and `-H "x-world-proof: lol"` buys
// nothing: a token can't be forged without the shared secret.
//
// In MeterX402 the tier changes the RATE, not a flat price: a bot's call is
// metered exactly like a human's and then multiplied (policy.botMultiplier).

import { createHmac, timingSafeEqual } from "node:crypto";

const env = (k: string) => process.env[k];
export const worldMode = () => env("WORLD_MODE") ?? (env("WORLD_RP_ID") && env("WORLD_RP_SIGNING_KEY") ? "live" : "simulated");
export const worldLive = () => worldMode() === "live" && !!env("WORLD_RP_ID") && !!env("WORLD_RP_SIGNING_KEY");

const TTL_MS = () => Number(env("WORLD_TOKEN_TTL_MS") ?? 15 * 60 * 1000);

// Hub and gateways are separate processes and share this via .env. The dev
// fallback keeps the local demo working out of the box; it is public, so it is
// announced and must be replaced in any real deployment.
const DEV_SECRET = "meterx402-dev-secret-not-for-production";
let warned = false;
function secret(): string {
  const s = env("WORLD_TOKEN_SECRET");
  if (s) return s;
  if (!warned) {
    warned = true;
    console.warn("⚠️  WORLD_TOKEN_SECRET unset: using the public dev secret. Set it in .env for a real deployment.");
  }
  return DEV_SECRET;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export interface WorldSession { ok: boolean; nullifier?: string; simulated?: boolean; exp?: number; }

export function issueSessionToken(nullifier: string, simulated = !worldLive()): string {
  const exp = Date.now() + TTL_MS();
  const payload = `v1.${nullifier.replaceAll(".", "_")}.${exp}.${simulated ? "s" : "l"}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): WorldSession {
  if (!token) return { ok: false };
  const i = token.lastIndexOf(".");
  if (i < 0) return { ok: false };
  const payload = token.slice(0, i);
  const got = token.slice(i + 1);
  const want = sign(payload);
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) return { ok: false };
  const [v, nullifier, expRaw, mode] = payload.split(".");
  if (v !== "v1" || !nullifier || !expRaw) return { ok: false };
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || Date.now() > exp) return { ok: false };
  return { ok: true, nullifier, simulated: mode === "s", exp };
}

/** The signed request context the IDKit widget needs (World ID 4.0 requires the
 *  RP backend to sign every proof request). Null when World isn't configured. */
export async function rpContext(action = env("WORLD_ACTION") ?? "x402-verify") {
  if (!worldLive()) return null;
  // optional dependency: only needed when World ID is live
  const mod = "@worldcoin/idkit-core/signing";
  const { signRequest } = await import(mod);
  const s: any = signRequest({ signingKeyHex: env("WORLD_RP_SIGNING_KEY")!, action });
  return {
    app_id: env("WORLD_APP_ID"),
    action,
    credential: env("WORLD_CREDENTIAL") ?? "selfie",
    rp_context: {
      rp_id: env("WORLD_RP_ID"),
      nonce: s.nonce,
      created_at: s.createdAt ?? s.created_at,
      expires_at: s.expiresAt ?? s.expires_at,
      signature: s.sig ?? s.signature,
    },
  };
}

/** Verify a World ID 4.0 proof with the Developer Portal. Returns the rp-scoped
 *  nullifier the session token is bound to: one human = one session, however
 *  many wallets their agent rotates through. */
export async function verifyWorldProof(result: any): Promise<{ ok: boolean; nullifier?: string; error?: string }> {
  if (!worldLive()) return { ok: false, error: "world_not_configured" };
  const p = result?.responses || result?.merkle_root ? result : (result?.result ?? result?.payload ?? result);
  const is40 = Array.isArray(p?.responses) && p.responses.length > 0;
  const is30 = !!(p?.proof && (p?.nullifier_hash || p?.merkle_root));
  if (!is40 && !is30) return { ok: false, error: "malformed_proof" };
  const action = p.action ?? env("WORLD_ACTION") ?? "x402-verify";
  const body = is40
    ? { protocol_version: p.protocol_version ?? "4.0", nonce: p.nonce, action, environment: p.environment, responses: p.responses, user_presence_completed: p.user_presence_completed }
    : { nullifier_hash: p.nullifier_hash, merkle_root: p.merkle_root, proof: p.proof, verification_level: p.verification_level, signal_hash: p.signal_hash, action };
  try {
    const r = await fetch(`https://developer.world.org/api/v4/verify/${env("WORLD_RP_ID")}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok && j?.success === true) return { ok: true, nullifier: j.nullifier ?? p.nullifier_hash ?? p.responses?.[0]?.nullifier };
    return { ok: false, error: j?.code ?? j?.detail ?? `verify_failed_${r.status}` };
  } catch (e) {
    return { ok: false, error: String(e).split("\n")[0] };
  }
}
