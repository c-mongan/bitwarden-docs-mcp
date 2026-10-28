import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import {
  CACHE,
  atomicJson,
  discover,
  errorMessage,
  loadCorpus,
  sourceSchema,
  status,
} from "./corpus.js";

const documentSchema = z.object({
  id: z.string(),
  source: sourceSchema,
  url: z.string().url(),
  version: z.string(),
  sha256: z.string(),
  totalLines: z.number().int().positive(),
});
const sectionSchema = z.object({
  id: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
const readSchema = documentSchema.extend({
  revision: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  nextLine: z.number().int().positive().nullable(),
  text: z.string(),
  sections: z.array(sectionSchema),
  nextSectionOffset: z.number().nullable(),
  totalSections: z.number(),
  section: sectionSchema.nullable(),
});
const listSchema = z.object({
  revision: z.string(),
  offset: z.number(),
  total: z.number(),
  nextOffset: z.number().nullable(),
  documents: z.array(documentSchema),
});

const client = new Client({
  name: "docs-exhaustive-access-audit",
  version: "1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  env: { DOCS_MCP_CACHE: CACHE },
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
  stderr: "pipe",
});
let stderrTail = "";
transport.stderr?.on("data", (chunk: Buffer) => {
  stderrTail = (stderrTail + chunk.toString()).slice(-8000);
});
let calls = 0;
async function call<T>(
  name: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  calls++;
  const result = await client.callTool({ name, arguments: args });
  const content = z
    .array(z.object({ type: z.literal("text"), text: z.string() }))
    .min(1)
    .parse(result.content);
  if (result.isError) throw new Error(`${name}: ${content[0]!.text}`);
  if (name !== "docs_status")
    assert.ok(
      Buffer.byteLength(content[0]!.text) <= 16_000,
      `${name} exceeds the client-safe reply size`,
    );
  return schema.parse(JSON.parse(content[0]!.text));
}

const started = performance.now();
const documents: {
  id: string;
  pass: boolean;
  sections?: number;
  lines?: number;
  bytes?: number;
  sha256?: string;
  error?: string;
}[] = [];
const upstream: {
  source: string;
  pass: boolean;
  discovered?: number;
  missing?: string[];
  unexpected?: string[];
  error?: string;
}[] = [];
let cataloguePages = 0;
let sectionsChecked = 0;
let fatal: string | undefined;
let revision: string | undefined;
try {
  const corpus = await loadCorpus();
  assert.ok(corpus.pages.length, "No corpus: run npm run refresh first");
  assert.ok(
    status(corpus).sources.every((source) => source.complete),
    "Cache coverage is incomplete or stale",
  );
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(
    tools.tools.some((tool) => tool.name === "list_docs"),
    "Agents cannot enumerate the full corpus: list_docs is missing",
  );
  const catalogue: z.infer<typeof documentSchema>[] = [];
  let offset = 0;
  do {
    const result = await call(
      "list_docs",
      { offset, limit: 37, revision },
      listSchema,
    );
    cataloguePages++;
    revision ??= result.revision;
    assert.equal(result.revision, revision);
    assert.equal(result.offset, offset);
    assert.equal(result.total, corpus.pages.length);
    assert.ok(
      result.documents.length > 0 &&
        result.documents.length <= Math.min(37, result.total - offset),
    );
    catalogue.push(...result.documents);
    assert.equal(
      result.nextOffset,
      offset + result.documents.length < result.total
        ? offset + result.documents.length
        : null,
    );
    if (result.nextOffset === null) break;
    assert.ok(
      result.nextOffset > offset,
      "Catalogue pagination did not advance",
    );
    offset = result.nextOffset;
  } while (offset <= corpus.pages.length);
  assert.equal(
    new Set(catalogue.map((page) => page.id)).size,
    corpus.pages.length,
    "Catalogue repeats or omits pages",
  );
  assert.deepEqual(
    catalogue.map((page) => page.id).sort(),
    corpus.pages.map((page) => page.id).sort(),
  );

  for (const source of ["help", "sales"] as const) {
    const filtered: z.infer<typeof listSchema> = await call(
      "list_docs",
      { source, limit: 100, revision },
      listSchema,
    );
    assert.equal(
      filtered.total,
      corpus.pages.filter((page) => page.source === source).length,
    );
    assert.ok(filtered.documents.every((page) => page.source === source));
  }

  for (const entry of catalogue) {
    try {
      const original = corpus.pages.find((page) => page.id === entry.id)!;
      assert.equal(entry.sha256, original.sha256);
      assert.equal(entry.url, original.url);
      assert.equal(entry.version, original.version);
      const lines = original.text.split("\n");
      assert.equal(entry.totalLines, lines.length);
      async function readRange(section?: z.infer<typeof sectionSchema>) {
        const first = section?.startLine ?? 1;
        const last = section?.endLine ?? lines.length;
        assert.ok(
          first <= last && last <= lines.length,
          "Invalid section range",
        );
        const parts: string[] = [];
        let directory: z.infer<typeof sectionSchema>[] = [];
        let startLine = first;
        do {
          const response = await call(
            "read_doc",
            {
              id: entry.id,
              startLine,
              lineCount: 200,
              sectionId: section?.id,
              revision,
            },
            readSchema,
          );
          const endLine = response.endLine;
          assert.ok(
            endLine >= startLine && endLine <= Math.min(last, startLine + 199),
          );
          assert.equal(response.revision, revision);
          assert.equal(response.sha256, original.sha256);
          assert.equal(response.url, original.url);
          assert.equal(response.version, original.version);
          assert.equal(response.totalLines, lines.length);
          assert.equal(response.startLine, startLine);
          assert.equal(response.section?.id, section?.id);
          assert.equal(response.nextLine, endLine < last ? endLine + 1 : null);
          if (response.text !== lines.slice(startLine - 1, endLine).join("\n"))
            throw new Error(
              `Source text differs on lines ${startLine}-${endLine}`,
            );
          directory = response.sections;
          parts.push(response.text);
          if (response.nextLine === null) break;
          startLine = response.nextLine;
        } while (startLine <= last);
        if (!section) {
          const allSections: z.infer<typeof sectionSchema>[] = [];
          let sectionOffset = 0;
          do {
            const page = await call(
              "read_doc",
              { id: entry.id, lineCount: 1, revision, sectionOffset },
              readSchema,
            );
            allSections.push(...page.sections);
            if (page.nextSectionOffset === null) {
              assert.equal(allSections.length, page.totalSections);
              break;
            }
            assert.ok(page.nextSectionOffset > sectionOffset);
            sectionOffset = page.nextSectionOffset;
          } while (true);
          directory = allSections;
        }
        const text = parts.join("\n");
        if (text !== lines.slice(first - 1, last).join("\n"))
          throw new Error("Pagination lost or duplicated source lines");
        return { text, directory };
      }
      const whole = await readRange();
      const sha256 = createHash("sha256").update(whole.text).digest("hex");
      assert.equal(
        sha256,
        original.sha256,
        "Full document bytes do not match the cached source hash",
      );
      assert.equal(
        new Set(whole.directory.map((section) => section.id)).size,
        whole.directory.length,
        "Section IDs are not unique",
      );
      for (const section of whole.directory) {
        await readRange(section);
        sectionsChecked++;
      }
      documents.push({
        id: entry.id,
        pass: true,
        sections: whole.directory.length,
        lines: lines.length,
        bytes: Buffer.byteLength(whole.text),
        sha256,
      });
    } catch (error) {
      documents.push({ id: entry.id, pass: false, error: errorMessage(error) });
    }
  }
  for (const source of ["help", "sales"] as const) {
    try {
      const discovery = await discover(source);
      assert.deepEqual(
        discovery.errors,
        [],
        "Official discovery reported errors",
      );
      assert.deepEqual(
        discovery.failed,
        [],
        "Official page validation reported failures",
      );
      const cached = corpus.pages.filter((page) => page.source === source);
      const cachedUrls = new Set(cached.map((page) => page.url));
      const discovered = new Set(discovery.urls);
      const missing = [...discovered].filter((url) => !cachedUrls.has(url));
      const unexpected = [...cachedUrls].filter((url) => !discovered.has(url));
      const versionMatches = cached.every(
        (page) => page.version === discovery.version,
      );
      upstream.push({
        source,
        pass: !missing.length && !unexpected.length && versionMatches,
        discovered: discovered.size,
        missing,
        unexpected,
        ...(!versionMatches
          ? { error: "Cached version differs from official index" }
          : {}),
      });
    } catch (error) {
      upstream.push({ source, pass: false, error: errorMessage(error) });
    }
  }
} catch (error) {
  fatal = errorMessage(error);
} finally {
  await client.close();
  const pass =
    !fatal &&
    documents.length > 0 &&
    documents.every((page) => page.pass) &&
    upstream.length === 2 &&
    upstream.every((source) => source.pass);
  const report = {
    at: new Date().toISOString(),
    protocol:
      "Real MCP stdio; no filesystem access is used to discover or read agent-visible content",
    methodology:
      "Enumerate every page through list_docs, reconstruct every document and exposed section through read_doc pagination, compare all text to cached source and full-document SHA256, and compare catalogue coverage with fresh official discovery sources.",
    limits:
      "Full textual access to the declared indexed corpus, not proof of model comprehension or rendered-site extraction completeness. Does not include vault data, private sales material, blog archives, linked PDFs, image pixels or video.",
    pass,
    revision,
    cataloguePages,
    toolCalls: calls,
    sectionsChecked,
    pagesChecked: documents.length,
    lines: documents.reduce((sum, page) => sum + (page.lines ?? 0), 0),
    bytes: documents.reduce((sum, page) => sum + (page.bytes ?? 0), 0),
    durationMs: performance.now() - started,
    upstream,
    documents,
    ...(fatal ? { fatal, serverStderrTail: stderrTail } : {}),
  };
  await atomicJson(join(CACHE, "access-audit.json"), report);
  const { documents: _, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  if (!pass) process.exitCode = 1;
}
