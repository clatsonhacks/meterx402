// Entry point for the published, bundled CLI (packages/mx402).
import { cli } from "./cli.ts";

await cli(process.argv.slice(2));
