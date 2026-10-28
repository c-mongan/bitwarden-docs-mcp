import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchIndex, type Corpus, type Page } from "../src/corpus.js";
const page = (id: string, text: string, title = "Options"): Page => ({
  id,
  text,
  title,
  source: "help",
  version: "live",
  url: "https://bitwarden.com/help/configure",
  fetchedFrom: "https://bitwarden.com/help/configure",
  fetchedAt: new Date().toISOString(),
  sha256: "fixture",
});
const corpus = (pages: Page[]): Corpus => ({
  schemaVersion: 1,
  pages,
  reports: [],
});

test("ranked retrieval finds identifiers and returns cited paginated source", () => {
  const index = new SearchIndex(
    corpus([
      page(
        "help:configure",
        "# Options\n\nonlyChanged uses the dependency graph.\n```js\nconst a = true;\n```",
      ),
      page("help:other", "# Other\n\nSomething unrelated.", "Other"),
    ]),
  );
  assert.equal(index.search("onlyChanged")[0]?.id, "help:configure");
  assert.equal(
    index.search("only changed dependency")[0]?.id,
    "help:configure",
  );
  assert.deepEqual(index.search("qzxvplmokn987654321"), []);
  assert.deepEqual(index.search("onlyChanged", "sales"), []);
  const first = index.read("help:configure", 1, 3);
  assert.equal(first.nextLine, 4);
  assert.match(index.read("help:configure", 4, 10).text, /```js/);
  assert.throws(() => index.read("missing"));
  assert.throws(() => index.read("help:configure", 99));
});

test("section search skips version boilerplate and exposes exact heading-aware source ranges", () => {
  const text = [
    "> **Version 10.6** — React / TypeScript",
    "> Version boilerplate should not be indexed.",
    "# Configuration[](#configuration)",
    "",
    "## Deployment[](#deployment)",
    "General setup.",
    "",
    "### Exit zero[](#exitzero)",
    "exitZeroOnChanges exits successfully without accepting changes.",
    "",
    "### Acceptance",
    "autoAcceptChanges accepts changes automatically.",
  ].join("\n");
  const index = new SearchIndex(corpus([page("help:configure", text)]));
  const found = index.search("exitZeroOnChanges accepting changes")[0]!;
  assert.equal(found.sectionId, "exitzero");
  assert.equal(found.heading, "Exit zero");
  assert.deepEqual(found.headingPath, [
    "Configuration",
    "Deployment",
    "Exit zero",
  ]);
  assert.match(found.excerpt, /exitZeroOnChanges/);
  assert.doesNotMatch(found.excerpt, /Version boilerplate|autoAcceptChanges/);
  assert.equal(
    found.excerpt,
    text
      .split("\n")
      .slice(found.startLine - 1, found.endLine)
      .join("\n"),
  );
  const section = index.read(found.id, undefined, 200, found.sectionId);
  assert.equal(section.startLine, 8);
  assert.equal(section.nextLine, null);
  assert.doesNotMatch(section.text, /autoAcceptChanges/);
  const parent = index.read(found.id, undefined, 200, "deployment");
  assert.match(parent.text, /autoAcceptChanges/);
  assert.equal(index.read(found.id).sections.length, 4);
});

test("section directories ignore fenced example headings and disambiguate duplicate names", () => {
  const index = new SearchIndex(
    corpus([
      page(
        "help:configure",
        [
          "# Guide",
          "## Example",
          "```md",
          "# Not a section",
          "~~~",
          "```js",
          "# Still not a section",
          "```",
          "Content.",
          "## Example",
          "Second content.",
          "### Details",
          "Last detail.",
          "## example-2",
          "Explicitly suffixed heading.",
        ].join("\n"),
      ),
    ]),
  );
  const directory = index.read("help:configure").sections;
  assert.deepEqual(
    directory.map((item) => item.id),
    ["guide", "example", "example-2", "details", "example-2-2"],
  );
  assert.throws(
    () => index.read("help:configure", undefined, 200, "Example"),
    /ambiguous/,
  );
  assert.throws(
    () => index.read("help:configure", undefined, 200, "missing"),
    /missing/,
  );
  const first = index.read("help:configure", undefined, 2, "example-2");
  assert.equal(first.nextLine, 12);
  const second = index.read(
    "help:configure",
    first.nextLine!,
    200,
    "example-2",
  );
  assert.match(second.text, /Last detail/);
  assert.equal(second.nextLine, null);
  assert.throws(
    () => index.read("help:configure", 1, 200, "example-2"),
    /startLine/,
  );
});

test("documents without Markdown headings remain searchable and fully readable", () => {
  const text =
    "A plain-text guide to environmentFingerprint and snapshot stability.";
  const index = new SearchIndex(corpus([page("help:plain", text)]));
  const found = index.search("environmentFingerprint")[0]!;
  assert.equal(found.id, "help:plain");
  assert.equal(
    index.read(found.id, undefined, 200, found.sectionId).text,
    text,
  );
});

test("catalogue pagination discovers every document and detects a changed snapshot", () => {
  const data = corpus([
    page("help:z", "# Last\n\nLast page."),
    page("help:a", "# First\n\nFirst page."),
    { ...page("sales:m", "# Middle\n\nMiddle page."), source: "sales" },
  ]);
  const index = new SearchIndex(data);
  const first = index.list(undefined, 0, 2);
  assert.deepEqual(
    first.documents.map((document) => document.id),
    ["help:a", "help:z"],
  );
  assert.equal(first.nextOffset, 2);
  assert.equal(first.total, 3);
  assert.ok(first.documents.every((document) => !("text" in document)));
  const last = index.list(undefined, first.nextOffset!, 2, first.revision);
  assert.deepEqual(
    last.documents.map((document) => document.id),
    ["sales:m"],
  );
  assert.equal(last.nextOffset, null);
  assert.deepEqual(
    index.list("sales").documents.map((document) => document.id),
    ["sales:m"],
  );
  assert.deepEqual(index.list(undefined, 3).documents, []);
  assert.throws(() => index.list(undefined, 4), /offset/);
  const changed = new SearchIndex({
    ...data,
    pages: data.pages.map((document) => ({ ...document, sha256: "changed" })),
  });
  assert.throws(() => changed.list(undefined, 2, 2, first.revision), /changed/);
  assert.throws(
    () => changed.read("help:a", 1, 200, undefined, first.revision),
    /changed/,
  );
});

test("byte-bounded catalogue pages never hide entries behind client truncation", () => {
  const data = corpus(
    Array.from({ length: 75 }, (_, number) =>
      page(
        `help:guide-${number}`,
        "# Guide\n\nBody.",
        "Long title " + "x".repeat(100),
      ),
    ),
  );
  data.reports.push({
    source: "help",
    version: "live",
    discovered: 75,
    refreshed: 0,
    failed: Array.from({ length: 300 }, (_, number) => ({
      url: `https://bitwarden.com/help/unavailable-${number}`,
      error: "Upstream request failed; last-good page retained.",
    })),
    discoveryErrors: [],
    excluded: [],
    validatedExtras: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const index = new SearchIndex(data);
  const ids: string[] = [];
  let offset = 0;
  do {
    const result = index.list(undefined, offset, 100);
    assert.equal(result.coverage.sources[0]?.complete, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16_000);
    assert.ok(result.documents.length < 75);
    ids.push(...result.documents.map((document) => document.id));
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  } while (offset < 75);
  assert.equal(ids.length, 75);
  assert.equal(new Set(ids).size, 75);
});

test("byte-bounded document pagination preserves Unicode, escaped text and final newlines", () => {
  const text =
    "# Guide\n\n" +
    Array.from(
      { length: 200 },
      (_, number) => `${number}: "quoted" \\escaped ${"é字".repeat(90)}`,
    ).join("\n") +
    "\n";
  const index = new SearchIndex(corpus([page("help:large", text)]));
  const parts: string[] = [];
  let startLine = 1;
  let calls = 0;
  do {
    const result = index.read("help:large", startLine, 200);
    calls++;
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16_000);
    parts.push(result.text);
    if (result.nextLine === null) break;
    assert.ok(result.nextLine > startLine);
    startLine = result.nextLine;
  } while (startLine <= text.split("\n").length);
  assert.ok(calls > 2);
  assert.equal(parts.join("\n"), text);
});

test("large heading directories paginate without blocking full-document access", () => {
  const text =
    "# Release notes\n\n" +
    Array.from(
      { length: 300 },
      (_, i) => `## Release ${i}\n\nChanges for release ${i}.\n`,
    ).join("\n");
  const index = new SearchIndex(corpus([page("help:release", text)]));
  let offset = 0;
  const ids: string[] = [];
  do {
    const result = index.read(
      "help:release",
      1,
      200,
      undefined,
      index.revision,
      offset,
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 16000);
    ids.push(...result.sections.map((s) => s.id));
    if (result.nextSectionOffset === null) break;
    offset = result.nextSectionOffset;
  } while (true);
  assert.equal(ids.length, 301);
  assert.equal(new Set(ids).size, 301);
  assert.match(
    index.read("help:release", undefined, 200, ids.at(-1)).text,
    /release 299/,
  );
});
