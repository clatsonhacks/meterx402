// Load the repo .env into process.env without a dependency. Existing
// environment variables always win, so a shell export overrides the file.
// Processes that aren't started by serve.ts (the MCP server, a gateway run by
// hand) would otherwise never see the operator's credentials.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Load .env from the directory the command was run in first (what `npx mx402`
 *  in someone else's project expects), then the package's own root. Values
 *  already in the environment always win, and so does the first file loaded. */
export function loadEnv(file?: string): void {
  if (file === undefined) {
    for (const f of [resolve(process.cwd(), ".env"), resolve(ROOT, ".env")]) loadEnv(f);
    return;
  }
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    // strip an inline "# comment" only when it follows whitespace, so values
    // containing '#' (rare in keys, common in URLs) survive
    const val = m[2].replace(/\s+#.*$/, "").trim().replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

/** Replace ${VAR} (or ${VAR:-default}) from the environment. Returns null if a
 *  var without a default is unset, so a caller can refuse to start a lane
 *  rather than sell a broken one. */
export function interpolate(s: string): string | null {
  let missing = false;
  const out = s.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, k: string, def?: string) => {
    const v = process.env[k];
    if (v) return v;
    if (def !== undefined) return def;
    missing = true;
    return "";
  });
  return missing ? null : out;
}
