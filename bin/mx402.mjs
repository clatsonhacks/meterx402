#!/usr/bin/env node
// mx402 CLI entry for running from the repo (TypeScript via tsx, no build step).
// The published package ships a bundled build instead: see packages/mx402.
import { register } from "tsx/esm/api";

register();
const { cli } = await import("../src/cli.ts");
await cli(process.argv.slice(2));
