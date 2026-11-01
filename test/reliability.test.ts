import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { atomicJson, refresh, status, type Corpus } from "../src/corpus.js";

const execute = promisify(execFile);
const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
const fetcher = async (url: string) => {
  if (url.endsWith("llms-full.txt"))
    return (
      "---\nURL: https://bitwarden.com/help/fixture/\n---\n# Fixture\n\n" +
      "Reliable documentation for the fixture. ".repeat(4)
    );
  if (url.endsWith("sitemap.xml"))
    return "<urlset><url><loc>https://bitwarden.com/help/fixture/</loc></url></urlset>";
  throw new Error("Unexpected URL");
};
function fixture(): Corpus {
  const value: Corpus = {
    schemaVersion: 1,
    reports: [],
    pages: (["help", "sales"] as const).map((source) => {
      const text =
        "# Regression fixture\nsingle sign-on SSO authentication decryption business pricing Teams Enterprise args";
      return {
        id: `${source}:regression-fixture`,
        source,
        title: "Regression fixture",
        url: `https://bitwarden.com/${source === "help" ? "help/fixture" : "products/business"}/`,
        fetchedFrom: "https://bitwarden.com/products/business",
        version: "live",
        fetchedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(text).digest("hex"),
        text,
        anchors: { "regression-fixture": "Regression fixture" },
        anchorsCheckedAt: new Date().toISOString(),
        anchorsSha256: createHash("sha256").update(text).digest("hex"),
      };
    }),
  };
  value.reports = value.pages.map((page) => ({
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
  return value;
}

test(
  "refresh recovers an expired lock after its writer is killed, but rejects a live writer",
  { timeout: 20000 },
  async () => {
    const cache = await mkdtemp(join(tmpdir(), "docs-lock-regression-"));
    const moduleUrl = new URL("../src/corpus.js", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {refresh} from ${JSON.stringify(moduleUrl)}; await refresh(['help'],process.env.DOCS_MCP_CACHE,async()=>{process.send('locked'); await new Promise(()=>setInterval(()=>{},1000));});`,
      ],
      {
        env: { ...process.env, DOCS_MCP_CACHE: cache },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    child.stderr?.resume();
    try {
      await once(child, "message");
      await delay(11_000); // Longer than the lease; the active writer must renew it.
      await assert.rejects(
        refresh(["help"], cache, fetcher),
        /Refresh lock unavailable/,
      );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      // Simulate the recovery window after a crash without making this test sleep.
      const expired = new Date(Date.now() - 60_000);
      await utimes(join(cache, "refresh.lock"), expired, expired);
      const recovered = await refresh(["help"], cache, fetcher);
      assert.equal(status(recovered).sources[0]?.complete, true);
      assert.equal(recovered.pages[0]?.id, "help:help/fixture");
      // Successful completion must release ownership for the next refresh.
      assert.equal(
        status(await refresh(["help"], cache, fetcher)).sources[0]?.complete,
        true,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(cache, { recursive: true, force: true });
    }
  },
);

test("smoke uses the selected custom cache in its child server", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-smoke-regression-"));
  try {
    await atomicJson(join(cache, "corpus.json"), fixture());
    await execute(
      process.execPath,
      [fileURLToPath(new URL("../src/smoke.js", import.meta.url))],
      { env: { ...process.env, DOCS_MCP_CACHE: cache }, timeout: 15000 },
    );
    const report = JSON.parse(
      await readFile(join(cache, "smoke.json"), "utf8"),
    );
    assert.deepEqual(
      report.results.map((item: { id: string }) => item.id),
      ["help:regression-fixture", "sales:regression-fixture"],
    );
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("MCP preserves successful results and original errors when the event log cannot be written", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-logging-regression-"));
  await atomicJson(join(cache, "corpus.json"), fixture());
  await mkdir(join(cache, "events.jsonl"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { DOCS_MCP_CACHE: cache },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "logging-regression", version: "1" });
  try {
    await client.connect(transport);
    const search = await client.callTool({
      name: "search_docs",
      arguments: { query: "args" },
    });
    assert.equal(search.isError, undefined);
    assert.match(JSON.stringify(search), /regression-fixture/);
    const missing = await client.callTool({
      name: "read_doc",
      arguments: { id: "missing" },
    });
    assert.equal(missing.isError, true);
    assert.match(JSON.stringify(missing), /Unknown document id/);
    assert.doesNotMatch(JSON.stringify(missing), /EISDIR/);
    assert.match(stderr, /Event log write failed/);
  } finally {
    await client.close();
    await rm(cache, { recursive: true, force: true });
  }
});

test("a completed refresh is successful even when its event log cannot be written", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-refresh-log-regression-"));
  try {
    await mkdir(join(cache, "events.jsonl"));
    const result = await refresh(["help"], cache, fetcher);
    assert.equal(status(result).sources[0]?.complete, true);
    assert.equal(
      JSON.parse(await readFile(join(cache, "corpus.json"), "utf8")).pages
        .length,
      1,
    );
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
