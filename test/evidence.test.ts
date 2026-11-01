import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicJson,
  loadCorpus,
  refresh,
  SearchIndex,
  type Corpus,
  type Page,
} from "../src/corpus.js";
import {
  plainExcerpt,
  sectionAnchors,
  sectionCitation,
  sha256,
} from "../src/evidence-text.js";
import { refreshSectionLinks } from "../src/links.js";
import {
  allowRequest,
  captureEvidence,
  captureUrl,
  launchOptions,
  openIsolatedBrowser,
  removeStaleProfiles,
  selectEvidence,
  type Launcher,
} from "../src/capture.js";

// Shape of rendered bitwarden.com help markup observed on 2026-11-01.
const html = `<html><body><nav><h2 id="nav">Navigation</h2></nav><main>
<h1 id="about-account-recovery">About Account Recovery</h1>
<div id="who-can-recover-accounts" class="scrollspy group"><a href="#who-can-recover-accounts" title="#who-can-recover-accounts"><span class="bwi bwi-hashtag"></span></a><h2>Who can recover accounts</h2></div>
<div id="how-it-works" class="scrollspy"><a href="#how-it-works"></a><h2>How it <em>works</em></h2></div>
<div class="scrollspy"><h2>No anchor</h2></div>
<h3><a href="#linked-heading">Linked heading</a></h3>
<h3 id="bad id">Rejected</h3>
</main></body></html>`;

const text =
  "# About Account Recovery\n\nIntro line that is long enough to cite.\n\n## Who can recover accounts\n\nOnly an owner can recover another owner's account.\n\n## How it works\n\nWhen a member enrolls in account recovery, their key is encrypted.\n\n| Role | Can recover |\n| --- | --- |\n| Owner | Any account in the organization |";

function page(overrides: Partial<Page> = {}): Page {
  return {
    id: "help:help/account-recovery",
    source: "help",
    title: "About Account Recovery",
    url: "https://bitwarden.com/help/account-recovery/",
    fetchedFrom: "https://bitwarden.com/help/account-recovery.md",
    version: "live",
    fetchedAt: new Date().toISOString(),
    sha256: sha256(text),
    text,
    ...overrides,
  };
}

function corpus(pages: Page[]): Corpus {
  return {
    schemaVersion: 1,
    pages,
    reports: (["help", "sales"] as const).map((source) => ({
      source,
      version: "live",
      discovered: 1,
      refreshed: 1,
      failed: [],
      discoveryErrors: [],
      excluded: [],
      validatedExtras: [],
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    })),
  };
}

test("sectionAnchors reads Bitwarden scrollspy wrappers and heading ids inside main only", () => {
  assert.deepEqual(sectionAnchors(html), {
    "about-account-recovery": "About Account Recovery",
    "who-can-recover-accounts": "Who can recover accounts",
    "how-it-works": "How it works",
    "linked-heading": "Linked heading",
  });
});

test("citations are verified only for unique anchors checked against the same page body", () => {
  const anchors = sectionAnchors(html);
  const checked = page({
    anchors,
    anchorsCheckedAt: "2026-11-01T00:00:00.000Z",
    anchorsSha256: sha256(text),
  });
  const verified = sectionCitation(checked, { title: "How it works" }, "x");
  assert.equal(
    verified.sectionUrl,
    "https://bitwarden.com/help/account-recovery/#how-it-works",
  );
  assert.equal(verified.linkStatus, "verified");
  assert.equal(verified.excerptSha256, sha256("x"));
  const changed = sectionCitation(
    { ...checked, sha256: sha256("changed body") },
    { title: "How it works" },
    "x",
  );
  assert.equal(changed.linkStatus, "unverified");
  assert.equal(changed.sectionUrl, null);
  const duplicate = sectionCitation(
    { ...checked, anchors: { a: "Next steps", b: "Next steps" } },
    { title: "Next steps" },
    "x",
  );
  assert.equal(duplicate.linkStatus, "unverified");
  assert.equal(
    sectionCitation(page(), { title: "How it works" }, "x").linkStatus,
    "unverified",
  );
});

test("plainExcerpt keeps table headers out of row text and strips Markdown", () => {
  const lines = text.split("\n");
  const row = lines.findIndex((line) => line.startsWith("| Owner")) + 1;
  assert.equal(
    plainExcerpt(text, row, row),
    "Owner Any account in the organization",
  );
  assert.equal(
    plainExcerpt("# T\n\n**Bold** [link](https://x.y)", 3, 3),
    "Bold link",
  );
});

test("search and read expose exact excerpt hashes and verified section links", () => {
  const checked = page({
    anchors: sectionAnchors(html),
    anchorsCheckedAt: new Date().toISOString(),
    anchorsSha256: sha256(text),
  });
  const index = new SearchIndex(corpus([checked]));
  const hit = index.search("who can recover owner account")[0]!;
  assert.equal(hit.excerptSha256, sha256(hit.excerpt));
  assert.equal(
    hit.sectionUrl,
    "https://bitwarden.com/help/account-recovery/#who-can-recover-accounts",
  );
  const read = index.read(checked.id, 7, 1);
  assert.equal(read.excerptSha256, sha256(read.text));
  assert.equal(read.linkStatus, "verified");
  assert.equal(read.section, null);
  assert.equal("anchors" in read, false);
});

test("link refresh is incremental, keeps text unchanged and drops claims after a failed check", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-links-"));
  try {
    const original = page();
    await atomicJson(join(cache, "corpus.json"), corpus([original]));
    const fetched: string[] = [];
    const ok = async (url: string) => {
      fetched.push(url);
      return html;
    };
    const first = await refreshSectionLinks(cache, ok);
    assert.equal(first.checked, 1);
    assert.equal(first.pagesWithVerifiedAnchors, 1);
    let stored = (await loadCorpus(cache)).pages[0]!;
    assert.equal(stored.text, original.text);
    assert.equal(stored.fetchedAt, original.fetchedAt);
    assert.equal(stored.anchorsSha256, original.sha256);
    assert.equal((await refreshSectionLinks(cache, ok)).checked, 0);
    assert.equal(fetched.length, 1);
    const failed = await refreshSectionLinks(
      cache,
      async () => {
        throw new Error("HTTP 503");
      },
      { all: true },
    );
    assert.equal(failed.failed.length, 1);
    stored = (await loadCorpus(cache)).pages[0]!;
    assert.equal(stored.anchors, undefined);
    assert.equal(stored.anchorsCheckedAt, undefined);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("text refresh preserves anchors for an unchanged body and drops them when it changes", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-anchor-refresh-"));
  const body = (extra: string) =>
    `# Fixture\n\n## How it works\n\nReliable documentation for the fixture.${extra} `.repeat(
      2,
    );
  let current = body("");
  const fetcher = async (url: string) => {
    if (url.endsWith("llms-full.txt"))
      return `---\nURL: https://bitwarden.com/help/fixture/\n---\n${current}`;
    if (url.endsWith("sitemap.xml"))
      return "<urlset><url><loc>https://bitwarden.com/help/fixture/</loc></url></urlset>";
    if (url === "https://bitwarden.com/help/fixture/")
      return '<main><div id="how-it-works" class="scrollspy"><h2>How it works</h2></div></main>';
    throw new Error("Unexpected URL");
  };
  try {
    await refresh(["help"], cache, fetcher);
    await refreshSectionLinks(cache, fetcher);
    await refresh(["help"], cache, fetcher);
    let stored = (await loadCorpus(cache)).pages[0]!;
    assert.deepEqual(stored.anchors, { "how-it-works": "How it works" });
    current = body(" Updated.");
    await refresh(["help"], cache, fetcher);
    stored = (await loadCorpus(cache)).pages[0]!;
    assert.equal(stored.anchors, undefined);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("capture network policy allows only bitwarden.com GET/HEAD and documentation navigations", () => {
  assert.equal(
    allowRequest("GET", "https://bitwarden.com/_nuxt/app.js", false),
    true,
  );
  assert.equal(
    allowRequest("GET", "https://bitwarden.com/help/about-sso/", true),
    true,
  );
  for (const [method, url, navigation] of [
    ["POST", "https://bitwarden.com/help/about-sso/", true],
    ["GET", "http://bitwarden.com/help/about-sso/", true],
    ["GET", "https://vault.bitwarden.com/", false],
    ["GET", "https://www.googletagmanager.com/gtm.js", false],
    ["GET", "https://bitwarden.com:8443/help/about-sso/", false],
    ["GET", "https://bitwarden.com/blog/anything/", true],
    ["GET", "https://bitwarden.com/help/llms-full.txt", true],
    ["GET", "not a url", false],
  ] as const)
    assert.equal(allowRequest(method, url, navigation), false, url);
  assert.throws(() => captureUrl("https://bitwarden.com/sitemap.xml"));
});

test("browser launch uses a fresh headless profile with service workers blocked", async () => {
  const options = launchOptions("chrome");
  assert.equal(options?.headless, true);
  assert.equal(options?.serviceWorkers, "block");
  assert.equal(options?.acceptDownloads, false);
  assert.equal(options?.chromiumSandbox, true);
  assert.ok(!options?.args?.some((arg) => arg.includes("user-data-dir")));
  const cache = await mkdtemp(join(tmpdir(), "docs-browser-"));
  try {
    const calls: { dir: string; channel?: string }[] = [];
    const launcher: Launcher = async (dir, launch) => {
      calls.push({ dir, channel: launch?.channel });
      if (launch?.channel === "chrome") throw new Error("not installed");
      return {} as never;
    };
    const opened = await openIsolatedBrowser(cache, launcher);
    assert.equal(opened.channel, "msedge");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.dir, calls[1]!.dir);
    assert.ok(calls[0]!.dir.startsWith(join(cache, "browser-profile-")));
    assert.equal((await stat(opened.profile)).isDirectory(), true);
    await rm(opened.profile, { recursive: true });
    await assert.rejects(
      openIsolatedBrowser(cache, async () => {
        throw new Error("missing");
      }),
      /No installed Google Chrome or Microsoft Edge/,
    );
    assert.deepEqual(
      (await readdir(cache)).filter((name) => name.startsWith("browser-")),
      [],
    );
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("stale browser profiles from crashed captures are removed", async () => {
  const cache = await mkdtemp(join(tmpdir(), "docs-profiles-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cache, "browser-profile-old"));
    await mkdir(join(cache, "browser-profile-new"));
    await mkdir(join(cache, "evidence"));
    const fresh = (await stat(join(cache, "browser-profile-new"))).mtimeMs;
    await removeStaleProfiles(cache, fresh + 60_000);
    assert.equal((await readdir(cache)).includes("browser-profile-new"), true);
    await removeStaleProfiles(cache, fresh + 700_000);
    assert.deepEqual((await readdir(cache)).sort(), ["evidence"]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test("capture validates line bounds and revision, and reports unavailable without a browser", async () => {
  const index = new SearchIndex(corpus([page()]));
  const base = { id: page().id, revision: index.revision };
  assert.throws(
    () => selectEvidence(index, { ...base, startLine: 1, endLine: 41 }),
    /between 1 and 40/,
  );
  assert.throws(
    () => selectEvidence(index, { ...base, startLine: 3, endLine: 2 }),
    /between 1 and 40/,
  );
  assert.throws(
    () =>
      selectEvidence(index, {
        ...base,
        revision: "0".repeat(64),
        startLine: 3,
        endLine: 3,
      }),
    /changed during pagination/,
  );
  assert.throws(
    () => selectEvidence(index, { ...base, startLine: 2, endLine: 2 }),
    /20–2400 visible characters/,
  );
  const cache = await mkdtemp(join(tmpdir(), "docs-capture-"));
  try {
    const result = await captureEvidence(
      index,
      { ...base, startLine: 7, endLine: 7 },
      cache,
      async () => {
        throw new Error("no browser");
      },
    );
    assert.equal(result.metadata.status, "unavailable");
    assert.match(String(result.metadata.reason), /No installed Google Chrome/);
    assert.equal(result.image, undefined);
    assert.equal(
      result.metadata.excerptSha256,
      sha256(result.metadata.excerpt as string),
    );
    assert.deepEqual(
      (await readdir(cache)).filter((name) => name.startsWith("browser-")),
      [],
    );
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});
