import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { atomicJson, type Corpus } from "../src/corpus.js";
import { SERVER_VERSION } from "../src/version.js";

const configureText =
  "# Configuration reference\n\nonlyChanged enables TurboSnap.\n\n```js\nconst onlyChanged = true;\n```";
const configureSha = createHash("sha256").update(configureText).digest("hex");

test("real stdio MCP handshake, tool calls, validation, errors and diagnostics", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-mcp-protocol-"));
  const fixture: Corpus = {
    schemaVersion: 1,
    reports: [],
    pages: [
      {
        id: "help:configure",
        source: "help",
        title: "Configuration reference",
        url: "https://bitwarden.com/help/configure",
        fetchedFrom: "https://bitwarden.com/help/configure",
        version: "live",
        fetchedAt: new Date().toISOString(),
        sha256: configureSha,
        text: configureText,
        anchors: { "configuration-reference": "Configuration reference" },
        anchorsCheckedAt: new Date().toISOString(),
        anchorsSha256: configureSha,
      },
      {
        id: "sales:args",
        source: "sales",
        title: "Args",
        url: "https://bitwarden.com/products/business",
        fetchedFrom: "https://bitwarden.com/products/business.md",
        version: "fixture",
        fetchedAt: new Date().toISOString(),
        sha256: "fixture",
        text: "# Args\n\nComponent inputs.",
      },
    ],
  };
  fixture.reports = fixture.pages.map((page) => ({
    source: page.source,
    version: "live",
    discovered: 1,
    refreshed: 1,
    failed: [],
    discoveryErrors: [],
    excluded: [],
    validatedExtras: [],
    startedAt: page.fetchedAt,
    finishedAt: page.fetchedAt,
  }));
  await atomicJson(join(cache, "corpus.json"), fixture);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env: { DOCS_MCP_CACHE: cache },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const client = new Client({ name: "docs-mcp-test", version: "1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "capture_evidence",
      "docs_status",
      "get_guidance",
      "list_docs",
      "read_doc",
      "refresh_docs",
      "search_docs",
    ]);
    for (const tool of tools.tools)
      assert.ok(tool.outputSchema, `${tool.name} has an output schema`);
    const listed = await client.callTool({
      name: "list_docs",
      arguments: { limit: 1 },
    });
    assert.ok(Array.isArray(listed.content));
    const catalogue = JSON.parse(listed.content[0].text);
    assert.equal(catalogue.total, 2);
    assert.equal(catalogue.nextOffset, 1);
    assert.equal(catalogue.documents[0].id, "help:configure");
    assert.equal(catalogue.documents[0].text, undefined);
    const finalPage = await client.callTool({
      name: "list_docs",
      arguments: { offset: 1, limit: 1, revision: catalogue.revision },
    });
    assert.ok(Array.isArray(finalPage.content));
    const finalCatalogue = JSON.parse(finalPage.content[0].text);
    assert.equal(finalCatalogue.nextOffset, null);
    assert.equal(finalCatalogue.documents[0].id, "sales:args");
    assert.equal(
      tools.tools.find((tool) => tool.name === "search_docs")?.annotations
        ?.readOnlyHint,
      true,
    );
    const search = await client.callTool({
      name: "search_docs",
      arguments: { query: "onlyChanged" },
    });
    assert.equal(search.isError, undefined);
    assert.match(JSON.stringify(search), /help:configure/);
    const hit = (
      search.structuredContent as {
        results: {
          sectionUrl: string | null;
          linkStatus: string;
          excerpt: string;
          excerptSha256: string;
        }[];
      }
    ).results[0]!;
    assert.equal(hit.linkStatus, "verified");
    assert.equal(
      hit.sectionUrl,
      "https://bitwarden.com/help/configure#configuration-reference",
    );
    assert.equal(
      hit.excerptSha256,
      createHash("sha256").update(hit.excerpt).digest("hex"),
    );
    const read = await client.callTool({
      name: "read_doc",
      arguments: { id: "help:configure" },
    });
    assert.match(JSON.stringify(read), /const onlyChanged/);
    const section = await client.callTool({
      name: "read_doc",
      arguments: {
        id: "help:configure",
        sectionId: "configuration-reference",
        lineCount: 2,
        revision: catalogue.revision,
      },
    });
    assert.equal(section.isError, undefined);
    assert.ok(Array.isArray(section.content));
    const sectionContent = section.content[0];
    assert.equal(sectionContent?.type, "text");
    assert.equal(typeof sectionContent?.text, "string");
    const sectionData = JSON.parse(sectionContent.text);
    assert.deepEqual(section.structuredContent, sectionData);
    assert.equal(
      sectionData.excerptSha256,
      createHash("sha256").update(sectionData.text).digest("hex"),
    );
    assert.equal(sectionData.section.id, "configuration-reference");
    assert.ok(Array.isArray(sectionData.sections));
    const wrongSection = await client.callTool({
      name: "read_doc",
      arguments: { id: "help:configure", sectionId: "missing" },
    });
    assert.equal(wrongSection.isError, true);
    const missing = await client.callTool({
      name: "read_doc",
      arguments: { id: "missing" },
    });
    assert.equal(missing.isError, true);
    const invalid = await client.callTool({
      name: "read_doc",
      arguments: { id: "help:configure", startLine: 0 },
    });
    assert.equal(invalid.isError, true);
    const status = await client.callTool({
      name: "docs_status",
      arguments: {},
    });
    assert.match(JSON.stringify(status), /observability/);
    assert.ok(Array.isArray(status.content));
    const statusData = JSON.parse(status.content[0].text);
    assert.equal(statusData.server.version, SERVER_VERSION);
    assert.equal(statusData.links.pagesWithVerifiedAnchors, 1);
    const salesRead = await client.callTool({
      name: "read_doc",
      arguments: { id: "sales:args" },
    });
    assert.equal(
      (salesRead.structuredContent as { linkStatus: string }).linkStatus,
      "unverified",
    );
    const privateGuidance = await client.callTool({
      name: "get_guidance",
      arguments: { question: "What is our negotiated discount?" },
    });
    assert.equal(privateGuidance.isError, undefined);
    const privateData = privateGuidance.structuredContent as {
      status: string;
      documentation: unknown[];
      recommendations: unknown[];
    };
    assert.equal(privateData.status, "unsupported");
    assert.equal(privateData.documentation.length, 0);
    assert.equal(privateData.recommendations.length, 0);
    const staleCapture = await client.callTool({
      name: "capture_evidence",
      arguments: {
        id: "help:configure",
        revision: "0".repeat(64),
        startLine: 3,
        endLine: 3,
      },
    });
    assert.equal(staleCapture.isError, true);
    assert.ok(
      !(staleCapture.content as { type: string }[]).some(
        (item) => item.type === "image",
      ),
    );
    assert.equal(statusData.readiness.state, "ready");
    assert.match(statusData.connection.sessionId, /^[a-f0-9-]{36}$/);
    assert.match(stderr, /"operation":"search_docs"/);
    assert.doesNotMatch(stderr, /"query"/);
    // Clients must notice external refreshes without restarting the MCP process.
    fixture.pages[0]!.text += "\nUpdated external cache.";
    fixture.pages[0]!.sha256 = createHash("sha256")
      .update(fixture.pages[0]!.text)
      .digest("hex");
    fixture.reports = [
      {
        source: "help",
        version: "live",
        discovered: 1,
        refreshed: 1,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        failed: [],
        discoveryErrors: [],
        excluded: [],
        validatedExtras: [],
      },
    ];
    await atomicJson(join(cache, "corpus.json"), fixture);
    const updated = await client.callTool({
      name: "read_doc",
      arguments: { id: "help:configure" },
    });
    assert.match(JSON.stringify(updated), /Updated external cache/);
    const staleSnapshot = await client.callTool({
      name: "read_doc",
      arguments: { id: "help:configure", revision: catalogue.revision },
    });
    assert.equal(staleSnapshot.isError, true);
    assert.match(JSON.stringify(staleSnapshot), /changed during pagination/);
  } finally {
    await client.close();
    await rm(cache, { recursive: true });
  }
});
