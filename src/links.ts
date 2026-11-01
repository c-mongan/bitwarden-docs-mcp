import { join } from "node:path";
import { lock } from "proper-lockfile";
import {
  CACHE,
  atomicJson,
  errorMessage,
  fetchText,
  loadCorpus,
  type FetchText,
  type LinkReport,
  type Page,
} from "./corpus.js";
import { sectionAnchors } from "./evidence-text.js";

const RECHECK_MS = 7 * 86_400_000;

// Refresh rendered-heading metadata without changing cached text or fetchedAt.
// Only pages whose body changed, or whose last check is older than seven days,
// are fetched unless `all` is set.
export async function refreshSectionLinks(
  cache = CACHE,
  fetcher: FetchText = fetchText,
  { all = false, now = Date.now } = {},
): Promise<LinkReport & { scope: string }> {
  const release = await lock(cache, {
    lockfilePath: join(cache, "refresh.lock"),
    stale: 10_000,
    update: 2_000,
    retries: 0,
  }).catch(() => {
    throw new Error(
      "Refresh lock unavailable; another process may be refreshing",
    );
  });
  try {
    const corpus = await loadCorpus(cache);
    const due = corpus.pages.filter(
      (page) =>
        all ||
        page.anchorsSha256 !== page.sha256 ||
        !page.anchorsCheckedAt ||
        now() - Date.parse(page.anchorsCheckedAt) > RECHECK_MS,
    );
    const results = new Map<
      string,
      { anchors: Record<string, string>; checkedAt: string; sha256: string }
    >();
    const failed: { url: string; error: string }[] = [];
    const pending = [...due];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        let page;
        while ((page = pending.shift()))
          try {
            results.set(page.id, {
              anchors: sectionAnchors(await fetcher(page.url)),
              checkedAt: new Date(now()).toISOString(),
              sha256: page.sha256,
            });
          } catch (error) {
            failed.push({ url: page.url, error: errorMessage(error) });
          }
      }),
    );
    const failedUrls = new Set(failed.map((item) => item.url));
    const pages = corpus.pages.map((page): Page => {
      const checked = results.get(page.id);
      if (checked && checked.sha256 === page.sha256)
        return {
          ...page,
          anchors: checked.anchors,
          anchorsCheckedAt: checked.checkedAt,
          anchorsSha256: checked.sha256,
        };
      // A failed check must not retain a verified-link claim.
      if (failedUrls.has(page.url)) {
        const {
          anchors: _a,
          anchorsCheckedAt: _c,
          anchorsSha256: _s,
          ...rest
        } = page;
        return rest;
      }
      return page;
    });
    const linkReport: LinkReport = {
      checkedAt: new Date(now()).toISOString(),
      checked: results.size,
      pagesWithVerifiedAnchors: pages.filter(
        (page) =>
          page.anchorsSha256 === page.sha256 &&
          Object.keys(page.anchors ?? {}).length,
      ).length,
      failed: failed.slice(0, 500),
      unavailable: pages.filter(
        (page) =>
          page.anchorsSha256 === page.sha256 &&
          !Object.keys(page.anchors ?? {}).length,
      ).length,
    };
    await atomicJson(join(cache, "corpus.json"), {
      ...corpus,
      pages,
      linkReport,
    });
    return {
      ...linkReport,
      scope:
        "Rendered heading anchors only. Cached document text and fetchedAt are unchanged. Pages without anchors keep page-level citations.",
    };
  } finally {
    await release();
  }
}
