import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(process.argv[2]);
const cache = resolve(process.argv[3]);
await mkdir(cache, { recursive: true });
const entry = join(root, "server", "server.js");
let client;
let stderr = "";
async function connect(offline = false) {
  const hook = join(cache, "offline.mjs");
  if (offline)
    await writeFile(
      hook,
      'globalThis.fetch = async () => { throw new Error("offline fixture"); };\n',
    );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(offline ? ["--import", hook] : []), entry],
    env: { DOCS_MCP_CACHE: cache },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client({ name: "package-acceptance", version: "1" });
  await client.connect(transport);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120000,
  });
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}
const checks = [];
try {
  await connect();
  assert.equal((await client.listTools()).tools.length, 5);
  const started = performance.now();
  let status = await call("docs_status");
  assert.equal(status.server.version, "0.1.2");
  const firstSession = status.connection.sessionId;
  assert.ok(
    performance.now() - started < 5000,
    "First-use status blocked on download",
  );
  assert.equal(status.runtime.refreshing, true);
  checks.push("First-use status responds while initial download runs");
  const deadline = Date.now() + 120000;
  while (status.runtime.refreshing && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await call("docs_status");
  }
  assert.ok(
    status.sources.every((source) => source.complete),
    JSON.stringify(status),
  );
  checks.push("First-use download completes for both sources");
  const search = await call("search_docs", {
    query: "nested collections inherit permissions",
  });
  assert.equal(
    search.results[0].url,
    "https://bitwarden.com/help/about-collections/",
  );
  const page = await call("read_doc", {
    id: search.results[0].id,
    sectionId: search.results[0].sectionId,
    revision: search.revision,
  });
  assert.match(page.text, /don't inherit/);
  checks.push("Search and section reading return cited evidence");
  const refreshed = await call("refresh_docs");
  assert.ok(refreshed.sources.every((source) => source.complete));
  checks.push("Explicit refresh completes");
  await client.close();
  const file = join(cache, "corpus.json");
  const corpus = JSON.parse(await readFile(file, "utf8"));
  corpus.pages.forEach((page) => {
    page.fetchedAt = "2000-01-01T00:00:00.000Z";
  });
  await writeFile(file, JSON.stringify(corpus));
  await connect(true);
  const offlineSearch = await call("search_docs", {
    query: "nested collections inherit permissions",
  });
  assert.equal(offlineSearch.results[0].id, search.results[0].id);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const offlineStatus = await call("docs_status");
  assert.notEqual(offlineStatus.connection.sessionId, firstSession);
  assert.equal(offlineStatus.readiness.usable, true);
  assert.ok(
    offlineStatus.sources.every(
      (source) => !source.complete && source.stale > 0,
    ),
  );
  const offlineRead = await call("read_doc", { id: search.results[0].id });
  assert.match(offlineRead.text, /don't inherit/);
  checks.push(
    "Restart with stale cache and blocked network preserves readable documents and reports failures",
  );
  assert.ok(!stderr.includes("nested collections inherit permissions"));
  assert.ok(!stderr.includes("don't inherit"));
  checks.push("Logs exclude query and source text");
  const report = {
    at: new Date().toISOString(),
    pass: true,
    runtime: process.version,
    checks,
    sources: status.sources.map(({ source, cached }) => ({ source, cached })),
    limits:
      "Packaged process over MCP; this does not establish installation or answer quality in Claude Desktop.",
  };
  await writeFile(
    join(cache, "package-acceptance.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client?.close();
}
