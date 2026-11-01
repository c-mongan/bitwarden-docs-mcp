import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const root = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
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
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "capture_evidence",
    "docs_status",
    "get_guidance",
    "list_docs",
    "read_doc",
    "refresh_docs",
    "search_docs",
  ]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name).sort(),
    tools.map((tool) => tool.name).sort(),
  );
  const started = performance.now();
  let status = await call("docs_status");
  assert.equal(status.server.version, manifest.version);
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
  const linkDeadline = Date.now() + 120000;
  while (
    (status.runtime.checkingLinks || !status.links.pagesWithVerifiedAnchors) &&
    Date.now() < linkDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await call("docs_status");
  }
  assert.ok(
    status.links.pagesWithVerifiedAnchors > 300,
    JSON.stringify(status.links),
  );
  checks.push(
    `Background section-link check verified anchors on ${status.links.pagesWithVerifiedAnchors} pages`,
  );
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
  assert.equal(page.linkStatus, "verified");
  assert.equal(
    page.sectionUrl,
    "https://bitwarden.com/help/about-collections/#nested-collections",
  );
  checks.push(
    "Search and section reading return cited evidence with verified section links",
  );
  const guide = await call("get_guidance", {
    question:
      "Does our identity provider get vault decryption keys when we enable SSO?",
  });
  assert.notEqual(guide.guideReviewedAt, "not reviewed");
  assert.equal(guide.topics[0].id, "sso-decryption");
  assert.ok(guide.documentation.length && guide.recommendations.length);
  checks.push(
    `Packaged guidance uses the shipped review lock (status ${guide.status})`,
  );
  const refusal = await call("get_guidance", {
    question: "What discount did we negotiate in our renewal contract?",
  });
  assert.equal(refusal.status, "unsupported");
  checks.push("Packaged guidance refuses private commercial questions");
  const lines = page.text.split("\n");
  const line =
    page.startLine + lines.findIndex((text) => text.includes("don't inherit"));
  const capture = await client.callTool(
    {
      name: "capture_evidence",
      arguments: {
        id: page.id,
        revision: page.revision,
        startLine: line,
        endLine: line,
        sectionId: "nested-collections",
      },
    },
    undefined,
    { timeout: 60000 },
  );
  assert.ok(!capture.isError, JSON.stringify(capture));
  assert.equal(capture.structuredContent.status, "captured");
  assert.ok(capture.content.some((item) => item.type === "image"));
  checks.push(
    `Packaged capture_evidence used installed ${capture.structuredContent.browser} and returned a highlighted PNG`,
  );
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
