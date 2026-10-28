import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  symlink,
  stat,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  privateDirectory,
  readBoundedFile,
  MAX_CACHE_BYTES,
} from "../src/local-files.js";
import { atomicJson, event, loadCorpus, refresh } from "../src/corpus.js";
import { HELP_FEED, parseHelpFeed, validateMarkdown } from "../src/sources.js";

test(
  "cache directories and files use private POSIX modes",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bitwarden-permissions-"));
    try {
      const cache = join(root, "cache");
      await atomicJson(join(cache, "corpus.json"), {
        schemaVersion: 1,
        pages: [],
        reports: [],
      });
      assert.equal((await stat(cache)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(join(cache, "corpus.json"))).mode & 0o777,
        0o600,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  },
);

test(
  "linked cache directories, corpus files and logs cannot redirect file access",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bitwarden-links-"));
    try {
      const cache = join(root, "cache");
      const target = join(root, "private-target");
      await privateDirectory(cache);
      await mkdir(target);
      const alias = join(root, "alias");
      await symlink(target, alias, "dir");
      await assert.rejects(privateDirectory(alias), /symbolic link/);
      await assert.rejects(refresh(["help"], alias), /symbolic link/);
      const secret = join(target, "private.txt");
      await writeFile(secret, "PRIVATE-SENTINEL-DO-NOT-RETURN");
      await symlink(secret, join(cache, "corpus.json"));
      await assert.rejects(
        loadCorpus(cache),
        (error) =>
          error instanceof Error &&
          /Cannot read/.test(error.message) &&
          !error.message.includes("PRIVATE-SENTINEL"),
      );
      await symlink(secret, join(cache, "events.jsonl"));
      await event(cache, { operation: "test", durationMs: 1, ok: true });
      assert.equal(
        await readFile(secret, "utf8"),
        "PRIVATE-SENTINEL-DO-NOT-RETURN",
      );
      await assert.rejects(readBoundedFile(secret, 10), /size limit/);
    } finally {
      await rm(root, { recursive: true });
    }
  },
);

test("oversized cache writes preserve the old file and reads enforce their byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitwarden-size-"));
  try {
    const file = join(root, "corpus.json");
    await atomicJson(file, { marker: "last-good" });
    await assert.rejects(
      atomicJson(file, { text: "x".repeat(MAX_CACHE_BYTES) }),
      /size limit/,
    );
    assert.equal(JSON.parse(await readFile(file, "utf8")).marker, "last-good");
    await assert.rejects(readBoundedFile(file, 5), /size limit/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("cached provenance cannot introduce arbitrary hosts or credential-bearing URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bitwarden-provenance-"));
  try {
    const fixture = {
      schemaVersion: 1,
      reports: [],
      pages: [
        {
          id: "help:a",
          source: "help",
          title: "Guide",
          url: "https://user:DO-NOT-RETURN@evil.test/",
          fetchedFrom: HELP_FEED,
          version: "live",
          fetchedAt: new Date().toISOString(),
          sha256: "fixture",
          text: "# Guide\nPublic text.",
        },
      ],
    };
    await atomicJson(join(root, "corpus.json"), fixture);
    await assert.rejects(
      loadCorpus(root),
      (error) =>
        error instanceof Error && !error.message.includes("DO-NOT-RETURN"),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("publisher input has document, heading, line and count limits", () => {
  assert.throws(
    () => validateMarkdown("# Large\n" + "x".repeat(512_000)),
    /Invalid/,
  );
  assert.throws(
    () => validateMarkdown("# Guide\n" + "\n".repeat(20_001)),
    /Invalid/,
  );
  assert.throws(
    () => validateMarkdown("# Guide\n" + "## Heading\n".repeat(1501)),
    /Invalid/,
  );
  assert.throws(
    () => validateMarkdown("# Guide\n" + "Text ".repeat(30) + "\u0000"),
    /Invalid/,
  );
  const feed = Array.from(
    { length: 2001 },
    (_, i) =>
      `---\nURL: https://bitwarden.com/help/page-${i}/\n---\n# Page ${i}\nBody.\n`,
  ).join("\n");
  assert.throws(() => parseHelpFeed(feed), /document-count limit/);
});

test("diagnostic events discard exception detail", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-private-log-"));
  try {
    await event(cache, {
      operation: "read_doc",
      durationMs: 1,
      ok: false,
      detail: "SECRET-QUERY-AND-TEXT",
    });
    const log = await readFile(join(cache, "events.jsonl"), "utf8");
    assert.doesNotMatch(log, /SECRET|detail/);
  } finally {
    await rm(cache, { recursive: true });
  }
});
