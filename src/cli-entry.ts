// Entry point for the published, bundled CLI (packages/mx402).
//
// One thing has to happen before anything else is imported: in `mx402 mcp`,
// stdout is the MCP transport and carries nothing but JSON-RPC frames. A
// dependency deep in the Hedera SDK greets the world with "Patching Protobuf
// Long.js instance..." on stdout as it loads, which is not JSON, and a strict
// client is entitled to drop the connection over it. Since ES imports are
// hoisted, the guard is installed here and the real CLI is pulled in
// dynamically afterwards.

if (process.argv[2] === "mcp") {
  const toStderr = process.stderr.write.bind(process.stderr);
  const toStdout = process.stdout.write.bind(process.stdout);
  // Anything that is not a protocol frame is diagnostics: send it to stderr,
  // where an MCP client shows it as server log output instead of choking.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const isFrame = s.startsWith("{") || s.startsWith("[") || s.trim() === "";
    return (isFrame ? toStdout : toStderr)(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
  console.log = (...a: unknown[]) => { console.error(...a); };
}

const { cli } = await import("./cli.ts");
await cli(process.argv.slice(2));
