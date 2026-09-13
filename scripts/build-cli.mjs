// Bundle the CLI into one standalone file for the published `mx402` package.
//   node scripts/build-cli.mjs
// The bundle carries its own dependencies, so `npx mx402` installs one package
// and starts immediately instead of pulling ~300 transitive ones.
import { build } from "esbuild";
import { chmodSync, mkdirSync, statSync } from "node:fs";

mkdirSync("packages/mx402/dist", { recursive: true });

// The EVM and Solana signers are loaded only when a wallet on those chains is
// used. They stay out of the bundle and ship as optionalDependencies, so a
// Hedera-only `npx mx402` starts fast and Base/Solana work after a normal install.
const CHAIN_LIBS = ["@x402/evm", "@x402/evm/*", "@x402/svm", "@x402/svm/*", "viem", "viem/*", "@solana/kit", "@solana-program/token"];

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: CHAIN_LIBS,
  legalComments: "none",
};
const requireShim = [
  // Bundled CJS dependencies (tweetnacl, protobufjs) call require() at load
  // time; ESM has none, so hand them a real one.
  'import { createRequire as __mxCreateRequire } from "node:module";',
  "const require = __mxCreateRequire(import.meta.url);",
].join("\n");

// the SDK: import { MeterX402, MeterX402Agent, wrap } from "mx402"
await build({ ...shared, entryPoints: ["src/sdk/index.ts"], outfile: "packages/mx402/dist/sdk.mjs", banner: { js: requireShim } });
console.log(`built packages/mx402/dist/sdk.mjs (${(statSync("packages/mx402/dist/sdk.mjs").size / 1e6).toFixed(1)} MB)`);

const out = "packages/mx402/dist/mx402.mjs";
await build({
  entryPoints: ["src/cli-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  // optional chains: only needed for --chain base/solana, so they stay external
  // and the "install @x402/evm" message in chains.ts does its job.
  external: CHAIN_LIBS,
  legalComments: "none",
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Bundled CJS dependencies (tweetnacl, protobufjs) call require() at load
      // time; ESM has none, so hand them a real one.
      'import { createRequire as __mxCreateRequire } from "node:module";',
      'const require = __mxCreateRequire(import.meta.url);',
    ].join("\n"),
  },
});
chmodSync(out, 0o755);
console.log(`built ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
