import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allowedUrl,
  parseHelpFeed,
  sitemapHelpUrls,
  HELP_FEED,
  SITEMAP,
  SALES_PATHS,
  validateMarkdown,
  discover,
} from "../src/sources.js";
import {
  atomicJson,
  cacheDirectory,
  fetchText,
  loadCorpus,
  refresh,
  status,
} from "../src/corpus.js";
import { CorpusManager } from "../src/runtime.js";

const body =
  "# About SSO\n\nSSO separates authentication from decryption.\n\n| Plan | SSO |\n| --- | --- |\n| Enterprise | Yes |\n";
const url = (slug: string) => `https://bitwarden.com/help/${slug}/`;
const feed = (slugs = ["about-sso"], content = body) =>
  slugs.map((slug) => `---\nURL: ${url(slug)}\n---\n${content}\n`).join("\n");
const sitemap = (slugs = ["about-sso"]) =>
  `<urlset>${slugs.map((slug) => `<url><loc>${url(slug)}</loc></url>`).join("")}</urlset>`;
const fixture = async (value: string) =>
  value === HELP_FEED ? feed() : value === SITEMAP ? sitemap() : body;

test("only selected official HTTPS URLs are fetched; credentials, paths, queries and hosts are rejected", () => {
  for (const value of [
    HELP_FEED,
    SITEMAP,
    url("about-sso"),
    "https://bitwarden.com/help/about-sso.md",
    "https://bitwarden.com/pricing/business.md",
  ])
    assert.equal(allowedUrl(value).hostname, "bitwarden.com");
  for (const value of [
    "http://bitwarden.com/help/about-sso/",
    "https://bitwarden.com.evil.test/help/about-sso/",
    "https://localhost/help/a",
    "https://user:secret@bitwarden.com/help/a",
    "https://bitwarden.com:444/help/a",
    "https://bitwarden.com/help/../../private",
    "https://bitwarden.com/blog/a",
    "https://vault.bitwarden.com/help/a",
    "https://bitwarden.com/help/a?token=secret",
    "https://bitwarden.com/help/%2e%2e/private",
    "https://bitwarden.com/help/a.pdf",
  ])
    assert.throws(() => allowedUrl(value));
});

test("feed preserves tables and boundaries; duplicates, malformed boundaries and foreign URLs fail closed", () => {
  const parsed = parseHelpFeed(
    feed(["about-sso", "scim"]).replaceAll("\n", "\r\n"),
  );
  assert.equal(parsed.length, 2);
  assert.match(parsed[0]!.text, /\| Enterprise \| Yes \|/);
  assert.equal(parsed[0]!.fetchedFrom, HELP_FEED);
  assert.throws(
    () => parseHelpFeed(feed(["about-sso", "about-sso"])),
    /duplicate/,
  );
  assert.throws(
    () => parseHelpFeed(feed().replace("bitwarden.com", "evil.test")),
    /allowed/,
  );
  assert.throws(() => parseHelpFeed("<html>oops</html>"), /boundaries/);
  assert.throws(
    () =>
      parseHelpFeed(
        feed() + "\n---\nURL: https://bitwarden.com/help/scim/\nBROKEN\n",
      ),
    /Malformed/,
  );
  assert.throws(
    () => validateMarkdown("# 404\n" + "No page. ".repeat(20)),
    /Invalid/,
  );
});

test("sitemap selects English help articles and excludes indexes, feeds and other sites", () => {
  assert.deepEqual(
    sitemapHelpUrls(
      sitemap().replace(
        "</urlset>",
        "<url><loc>https://bitwarden.com/help/releasenotes/feed.xml</loc></url><url><loc>https://bitwarden.com/de-de/help/a/</loc></url><url><loc>https://evil.test/help/a/</loc></url></urlset>",
      ),
    ),
    [url("about-sso")],
  );
  assert.throws(() => sitemapHelpUrls("<html>error</html>"));
});

test("discovery validates feed-only pages, fills sitemap-only pages and reports placeholders", async () => {
  const fetched: string[] = [];
  const result = await discover("help", async (value) => {
    fetched.push(value);
    if (value === HELP_FEED)
      return (
        feed(["about-sso", "extra"]) +
        feed(["placeholder"], "# Placeholder page\n" + body)
      );
    if (value === SITEMAP) return sitemap(["about-sso", "missing"]);
    return body;
  });
  assert.equal(result.documents.length, 3);
  assert.deepEqual(result.validatedExtras, [url("extra")]);
  assert.equal(result.excluded[0]?.url, url("placeholder"));
  assert.ok(fetched.includes("https://bitwarden.com/help/missing.md"));
  assert.ok(fetched.includes("https://bitwarden.com/help/extra.md"));
  assert.ok(!fetched.some((value) => value.endsWith("placeholder.md")));
});

test("sales references must remain linked from the publisher index; failures are visible", async () => {
  const result = await discover("sales", async (value) => {
    if (value.endsWith("llms.txt"))
      return SALES_PATHS.slice(1)
        .map((path) => `[page](https://bitwarden.com${path}.md)`)
        .join("\n");
    if (value.endsWith("/pricing.md")) throw new Error("offline");
    return body;
  });
  assert.equal(result.errors.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.documents.length, SALES_PATHS.length - 1);
});

test("refresh keeps last-good content for failed fetches, body truncation and discovery loss", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-refresh-"));
  try {
    const slugs = Array.from({ length: 12 }, (_, i) => `page-${i}`);
    const good = await refresh(["help"], cache, async (value) =>
      value === HELP_FEED ? feed(slugs, body.repeat(10)) : sitemap(slugs),
    );
    assert.equal(status(good).sources[0]!.complete, true);
    const shrunk = await refresh(["help"], cache, fixture);
    assert.equal(shrunk.pages.length, 12);
    assert.match(shrunk.reports[0]!.discoveryErrors[0]!, /shrank/);
    const retry = await refresh(["help"], cache, fixture);
    assert.equal(retry.pages.length, 12);
    const truncated = await refresh(["help"], cache, async (value) =>
      value === HELP_FEED ? feed(slugs) : sitemap(slugs),
    );
    assert.equal(truncated.pages[0]!.sha256, good.pages[0]!.sha256);
    assert.match(truncated.reports[0]!.failed[0]!.error, /shrank/);
    const offline = await refresh(["help"], cache, async () => {
      throw new Error("offline");
    });
    assert.equal(offline.pages.length, 12);
    assert.equal(status(offline).sources[0]!.complete, false);
    await writeFile(join(cache, "corpus.json"), "bad json");
    await assert.rejects(loadCorpus(cache), /Cannot read/);
  } finally {
    await rm(cache, { recursive: true });
  }
});

test("partial refresh retains failed pages, while complete discovery can remove disappeared pages", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-partial-"));
  try {
    await refresh(["help"], cache, async (value) =>
      value === HELP_FEED
        ? feed(["about-sso", "extra"])
        : sitemap(["about-sso", "extra"]),
    );
    const partial = await refresh(["help"], cache, async (value) => {
      if (value === HELP_FEED) return feed(["about-sso", "extra"], "# Invalid");
      return sitemap(["about-sso", "extra"]);
    });
    assert.equal(partial.pages.length, 2);
    assert.equal(partial.reports[0]!.failed.length, 2);
    const complete = await refresh(["help"], cache, fixture);
    assert.equal(complete.pages.length, 1);
  } finally {
    await rm(cache, { recursive: true });
  }
});

test("HTTP fetch retries transient failures, rejects redirects and limits oversized responses", async (t) => {
  let calls = 0;
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
      : new Response(body),
  );
  assert.equal(await fetchText(url("about-sso")), body);
  assert.equal(calls, 2);
  mocked.mock.mockImplementation(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/" },
      }),
  );
  await assert.rejects(fetchText(url("about-sso")), /allowed/);
  mocked.mock.mockImplementation(
    async () => new Response("a".repeat(8_000_001)),
  );
  await assert.rejects(fetchText(url("about-sso")), /8 MB/);
});

test("cache paths remain outside the extension and respect Windows application data", () => {
  assert.equal(
    cacheDirectory("darwin", "/Users/test", {}),
    "/Users/test/Library/Application Support/BitwardenDocsMCP",
  );
  assert.equal(
    cacheDirectory("win32", "C:\\Users\\test", { LOCALAPPDATA: "D:\\Local" }),
    "D:\\Local\\BitwardenDocsMCP",
  );
  assert.equal(
    cacheDirectory("linux", "/home/test", {}),
    "/home/test/.cache/bitwarden-docs-mcp",
  );
});

test("first use is nonblocking, coalesces downloads, preserves cached reads and backs off after failure", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-runtime-"));
  let calls = 0;
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let clock = Date.now();
  const manager = new CorpusManager(
    cache,
    async (sources, directory) => {
      calls++;
      await gate;
      return refresh(
        sources?.filter((source) => source === "help"),
        directory,
        fixture,
      );
    },
    () => clock,
  );
  try {
    assert.equal((await manager.ensure()).pages.length, 0);
    assert.equal(manager.state().refreshing, true);
    await manager.ensure();
    assert.equal(calls, 1);
    finish();
    await manager.run(["help"]);
    assert.equal((await manager.ensure()).pages.length, 1);
    assert.equal(calls, 1);
    clock += 16 * 60_000;
    await manager.ensure();
    assert.equal(calls, 2);
    await manager.run(["help"]);
    const offline = new CorpusManager(cache, async () => {
      throw new Error("network secret detail");
    });
    assert.equal((await offline.ensure()).pages.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(offline.state().refreshing, false);
    assert.doesNotMatch(offline.state().refreshError!, /secret/);
  } finally {
    await rm(cache, { recursive: true });
  }
});

test("freshness detects stale pages and automatic refresh leaves the old cache readable", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-stale-"));
  try {
    const old = await refresh(["help"], cache, fixture);
    old.pages[0]!.fetchedAt = "2000-01-01T00:00:00.000Z";
    await atomicJson(join(cache, "corpus.json"), old);
    let complete!: (value: typeof old) => void;
    const manager = new CorpusManager(
      cache,
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const result = await manager.ensure();
    assert.equal(result.pages[0]!.text, old.pages[0]!.text);
    assert.equal(status(result).sources[0]!.stale, 1);
    assert.equal(manager.state().refreshing, true);
    assert.equal(
      JSON.parse(await readFile(join(cache, "corpus.json"), "utf8")).pages
        .length,
      1,
    );
    complete(old);
    await manager.run();
  } finally {
    await rm(cache, { recursive: true });
  }
});

test("a missing sitemap cannot introduce unvalidated feed-only pages", async () => {
  await assert.rejects(
    discover("help", async (value) => {
      if (value === HELP_FEED) return feed(["about-sso", "unvalidated"]);
      throw new Error("offline");
    }),
    /Sitemap discovery failed/,
  );
});

test("404 feed-only pages are excluded only when both public representations are absent", async () => {
  const result = await discover("help", async (value) => {
    if (value === HELP_FEED)
      return feed(["about-sso", "unpublished", "temporary"]);
    if (value === SITEMAP) return sitemap();
    if (value.includes("unpublished")) throw new Error("HTTP 404");
    throw new Error("HTTP 503");
  });
  assert.equal(result.excluded[0]?.url, url("unpublished"));
  assert.equal(result.failed[0]?.url, url("temporary"));
  assert.ok(!result.urls.includes(url("unpublished")));
});

test("different-source refresh requests queue without overlapping writers", async () => {
  let active = 0;
  let maxActive = 0;
  const calls: string[][] = [];
  const result = { schemaVersion: 1 as const, pages: [], reports: [] };
  const manager = new CorpusManager("unused", async (sources) => {
    calls.push(sources!);
    active++;
    maxActive = Math.max(active, maxActive);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return result;
  });
  await Promise.all([
    manager.run(["help"]),
    manager.run(["sales"]),
    manager.run(["sales"]),
  ]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [["help"], ["sales"]]);
});

test("first question waits for a short initial download without polling", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-first-question-"));
  const manager = new CorpusManager(cache, async (_, directory) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return refresh(["help"], directory, fixture);
  });
  try {
    const corpus = await manager.forRead(200);
    assert.equal(corpus.pages.length, 1);
    assert.equal(manager.readiness(corpus).usable, true);
  } finally {
    await rm(cache, { recursive: true });
  }
});

test("slow initial download returns a bounded preparing state and then becomes usable", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-slow-first-"));
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const manager = new CorpusManager(cache, async (_, directory) => {
    await gate;
    return refresh(["help"], directory, fixture);
  });
  try {
    const empty = await manager.forRead(5);
    assert.equal(empty.pages.length, 0);
    assert.equal(manager.readiness(empty).state, "preparing");
    finish();
    await manager.run(["help"]);
    assert.equal((await manager.forRead(5)).pages.length, 1);
  } finally {
    finish();
    await rm(cache, { recursive: true });
  }
});

test("failed first download reports unavailable rather than endless preparation", async () => {
  const cache = await mkdtemp(join(tmpdir(), "bitwarden-unavailable-"));
  const manager = new CorpusManager(cache, async () => {
    throw new Error("offline");
  });
  try {
    const corpus = await manager.forRead(200);
    assert.equal(manager.readiness(corpus).state, "unavailable");
    assert.equal(manager.readiness(corpus).usable, false);
    assert.match(manager.readiness(corpus).nextAction, /internet connection/);
  } finally {
    await rm(cache, { recursive: true });
  }
});
