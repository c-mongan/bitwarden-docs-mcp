import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CACHE, atomicJson } from "./corpus.js";
import { sha256 } from "./evidence-text.js";

const client = new Client({ name: "docs-evidence-end-to-end", version: "1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./server.js", import.meta.url))],
  env: { DOCS_MCP_CACHE: CACHE },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-3000);
});
const evidence = [];
try {
  await client.connect(transport);
  for (const target of [
    {
      id: "help:help/account-recovery",
      sectionId: "how-it-works",
      phrase: "encrypted with the organization's public key",
    },
    {
      id: "help:help/about-collections",
      sectionId: "nested-collections",
      phrase: "don't inherit",
    },
    {
      id: "help:help/forgot-master-password",
      sectionId: undefined,
      phrase: "no way to access, retrieve, or reset your master password",
    },
  ]) {
    const result = await client.callTool({
      name: "read_doc",
      arguments: { id: target.id, sectionId: target.sectionId, lineCount: 100 },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    const doc = result.structuredContent as {
      text: string;
      startLine: number;
      revision: string;
    };
    const offset = doc.text
      .split("\n")
      .findIndex((line) => line.includes(target.phrase));
    assert.ok(offset >= 0, `Missing selected passage in ${target.id}`);
    const line = doc.startLine + offset;
    const exact = await client.callTool({
      name: "read_doc",
      arguments: {
        id: target.id,
        startLine: line,
        lineCount: 1,
        revision: doc.revision,
      },
    });
    assert.ok(!exact.isError);
    const passage = exact.structuredContent as {
      text: string;
      excerptSha256: string;
      linkStatus: string;
    };
    assert.equal(passage.excerptSha256, sha256(passage.text));
    assert.equal(passage.linkStatus, "verified", target.id);
    const captured = await client.callTool(
      {
        name: "capture_evidence",
        arguments: {
          id: target.id,
          revision: doc.revision,
          startLine: line,
          endLine: line,
          sectionId: target.sectionId,
        },
      },
      undefined,
      { timeout: 60000 },
    );
    assert.ok(!captured.isError, JSON.stringify(captured));
    const meta = captured.structuredContent as Record<string, unknown>;
    assert.equal(meta.status, "captured", JSON.stringify(meta));
    const images = (
      captured.content as { type: string; data?: string; mimeType?: string }[]
    ).filter((item) => item.type === "image");
    assert.equal(images.length, 1);
    assert.equal(images[0]!.mimeType, "image/png");
    const png = Buffer.from(images[0]!.data!, "base64");
    assert.equal(sha256(png), meta.imageSha256);
    assert.ok(png.length <= 1_500_000);
    assert.equal(meta.excerpt, passage.text);
    assert.equal(meta.revision, doc.revision);
    const { excerpt: _excerpt, ...summary } = meta;
    evidence.push(summary);
  }
  const invalid = await client.callTool({
    name: "capture_evidence",
    arguments: {
      id: "help:help/account-recovery",
      revision: "0".repeat(64),
      startLine: 5,
      endLine: 5,
    },
  });
  assert.equal(invalid.isError, true);
  const leftovers = (await readdir(CACHE)).filter((name) =>
    name.startsWith("browser-profile-"),
  );
  assert.deepEqual(leftovers, [], "Temporary browser profiles must be deleted");
  const report = {
    at: new Date().toISOString(),
    pass: true,
    protocol:
      "Real MCP stdio; exact read_doc excerpt hash, verified section link, live installed-browser capture with temporary profile, inline PNG digest and profile cleanup checked.",
    captures: evidence,
    staleRevisionRejected: true,
    temporaryProfilesRemaining: 0,
  };
  await atomicJson(join(CACHE, "evidence-smoke.json"), report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  console.error(stderr);
  process.exitCode = 1;
} finally {
  await client.close();
}
