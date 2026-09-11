// Drive the MCP server the way Claude would (stdio), against a running hub.
//   npx tsx scripts/mcp-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp.ts"], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: "mcp-check", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const list: any = await client.callTool({ name: "list_paid_apis", arguments: {} });
const menu = JSON.parse(list.content[0].text);
console.log("for sale:", menu.map((m: any) => `${m.name} (${m.pricing})`).join(" | "));

const llm = menu.find((m: any) => m.name === "llm");
const body = JSON.stringify({ model: "mock-1", messages: [{ role: "user", content: "What is x402? answer in 120 words" }] });
const paid: any = await client.callTool({ name: "paid_fetch", arguments: { url: llm.url, method: "POST", body, max_units: 80 } });
console.log("\npaid_fetch (max_units 80):\n" + paid.content[0].text.split("\n").slice(0, 5).join("\n"));
const refused: any = await client.callTool({ name: "paid_fetch", arguments: { url: llm.url, method: "POST", body, max_hbar: 0.0001 } });
console.log("\npaid_fetch (max_hbar 0.0001):\n" + refused.content[0].text, refused.isError ? "(isError)" : "");
await client.close();
