import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CACHE, atomicJson } from "./corpus.js";
import { join } from "node:path";

const client = new Client({ name: "docs-live-smoke", version: "1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  env: { DOCS_MCP_CACHE: CACHE },
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
  stderr: "inherit",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 5)
    throw new Error("Expected five documentation tools");
  const results = [];
  for (const query of [
    {
      source: "help",
      query: "single sign-on SSO authentication decryption",
    },
    { source: "sales", query: "business pricing Teams Enterprise" },
  ]) {
    const started = performance.now();
    const response = await client.callTool({
      name: "search_docs",
      arguments: query,
    });
    const content = z
      .array(z.object({ type: z.literal("text"), text: z.string() }))
      .parse(response.content);
    const parsed = z
      .object({
        results: z
          .array(z.object({ id: z.string(), url: z.string().url() }))
          .min(1),
      })
      .parse(JSON.parse(content[0]!.text));
    const id = parsed.results[0]!.id;
    const read = await client.callTool({
      name: "read_doc",
      arguments: { id, lineCount: 200 },
    });
    if (read.isError) throw new Error(`Cannot read retrieved document: ${id}`);
    results.push({
      ...query,
      id,
      url: parsed.results[0]!.url,
      durationMs: performance.now() - started,
    });
  }
  const report = await client.callTool({ name: "docs_status", arguments: {} });
  if (report.isError) throw new Error("Diagnostics call failed");
  const evidence = {
    at: new Date().toISOString(),
    protocol: "real MCP stdio",
    tools: tools.tools.map((tool) => tool.name),
    results,
  };
  await atomicJson(join(CACHE, "smoke.json"), evidence);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await client.close();
}
