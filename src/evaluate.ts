import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { CACHE, atomicJson } from "./corpus.js";
import { evaluationCases } from "./evaluation-cases.js";

const client = new Client({
  name: "bitwarden-retrieval-evaluation",
  version: "1",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
  env: { DOCS_MCP_CACHE: CACHE },
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  if (!Array.isArray(response.content) || response.content[0]?.type !== "text")
    throw new Error("Invalid tool reply");
  if (response.isError) throw new Error(response.content[0].text);
  if (
    name !== "docs_status" &&
    Buffer.byteLength(response.content[0].text) > 16000
  )
    throw new Error("Oversized tool reply");
  return JSON.parse(response.content[0].text);
}
const results = [];
try {
  await client.connect(transport);
  for (const item of evaluationCases) {
    const response = await call("search_docs", {
      query: item.query,
      source: item.source,
      limit: 5,
    });
    const found = response.results.find(
      (page: { url: string }) => new URL(page.url).pathname === item.path,
    );
    let evidenceText = "";
    let fetchedAt: string | undefined;
    if (found) {
      // Read the retrieved document through MCP, preserving full text for evidence checks.
      let startLine = 1;
      do {
        const page = await call("read_doc", {
          id: found.id,
          startLine,
          lineCount: 200,
          revision: response.revision,
        });
        evidenceText += page.text + "\n";
        fetchedAt = page.fetchedAt;
        if (page.nextLine === null) break;
        startLine = page.nextLine;
      } while (true);
    }
    const index = evidenceText
      .toLowerCase()
      .indexOf(item.evidence.toLowerCase());
    const pass = item.path
      ? !!found && index >= 0
      : response.results.length === 0;
    results.push({
      ...item,
      pass,
      rank: found ? response.results.indexOf(found) + 1 : null,
      linkStatus: found?.linkStatus ?? null,
      sectionUrl: found?.sectionUrl ?? null,
      retrieved: response.results.map((page: { url: string }) => page.url),
      fetchedAt,
      evidenceExcerpt:
        item.path && index >= 0
          ? evidenceText.slice(Math.max(0, index - 250), index + 650)
          : null,
      answerCheck: item.path
        ? "Expected-answer rubric requires human/model review; retrieval pass is not an answer-quality score."
        : item.expected,
    });
  }
  const report = {
    at: new Date().toISOString(),
    method:
      "20 authored retrieval scenarios over real MCP stdio; 18 source/evidence checks and two no-match scope checks. No LLM judge or independent blind benchmark.",
    pass: results.every((item) => item.pass),
    passed: results.filter((item) => item.pass).length,
    total: results.length,
    results,
  };
  await atomicJson(join(CACHE, "evaluation.json"), report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  await client.close();
}
