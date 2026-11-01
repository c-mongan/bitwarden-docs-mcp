import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CACHE,
  STALE_MS,
  loadCorpus,
  refresh,
  status,
  type Corpus,
  type Source,
} from "./corpus.js";
import { refreshSectionLinks } from "./links.js";

export class CorpusManager {
  private pending?: Promise<Corpus>;
  private pendingSources: Source[] = [];
  private retryAfter = 0;
  private signature = "";
  private cached?: Corpus;
  private refreshError?: string;
  private linking?: Promise<unknown>;
  private linkError?: string;
  constructor(
    readonly cache = CACHE,
    private refreshFn = refresh,
    private now = Date.now,
    // Link checks contact bitwarden.com; injected refresh functions (tests) skip them by default.
    private linksFn:
      ((cache: string) => Promise<unknown>) | undefined = refreshFn === refresh
      ? (dir) => refreshSectionLinks(dir)
      : undefined,
  ) {}

  async load(): Promise<Corpus> {
    let signature = "missing";
    try {
      const file = await stat(join(this.cache, "corpus.json"));
      signature = `${file.ino}:${file.mtimeMs}:${file.size}`;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
    if (!this.cached || signature !== this.signature) {
      this.cached = await loadCorpus(this.cache);
      this.signature = signature;
    }
    return this.cached;
  }

  async ensure(): Promise<Corpus> {
    const corpus = await this.load();
    if (
      !this.pending &&
      this.now() >= this.retryAfter &&
      (!corpus.pages.length ||
        status(corpus).sources.some((source) => !source.complete))
    ) {
      // A failed source retries after 15 minutes, not on every tool call.
      // Successful sources are refreshed after 24 hours, on the next use.
      void this.run().catch(() => {});
    }
    return corpus;
  }

  async run(sources: Source[] = ["help", "sales"]): Promise<Corpus> {
    while (this.pending) {
      const covers = sources.every((source) =>
        this.pendingSources.includes(source),
      );
      const result = await this.pending;
      if (covers) return result;
    }
    // A link check holds the cache lock; let it finish before refreshing text.
    await this.linking?.catch(() => {});
    if (this.pending) return this.run(sources);
    this.pendingSources = sources;
    this.retryAfter = this.now() + 15 * 60_000;
    this.pending = this.refreshFn(sources, this.cache);
    try {
      const corpus = await this.pending;
      this.signature = ""; // Next read observes the atomic replacement.
      this.refreshError = undefined;
      this.retryAfter = status(corpus).sources.every(
        (source) => source.complete,
      )
        ? this.now() + STALE_MS
        : this.retryAfter;
      this.checkLinks();
      return corpus;
    } catch {
      this.refreshError =
        "Refresh failed. Cached content remains available; retry after checking the network and cache permissions.";
      throw new Error(this.refreshError);
    } finally {
      this.pending = undefined;
      this.pendingSources = [];
    }
  }

  private checkLinks() {
    if (!this.linksFn || this.linking) return;
    this.linking = this.linksFn(this.cache)
      .then(() => {
        this.linkError = undefined;
        this.signature = "";
      })
      .catch(() => {
        this.linkError =
          "Section link check failed. Citations fall back to page URLs.";
      })
      .finally(() => {
        this.linking = undefined;
      });
  }

  async forRead(waitMs = 8000): Promise<Corpus> {
    const corpus = await this.ensure();
    if (corpus.pages.length || !this.pending) return corpus;
    // First-use downloads are usually short. Wait once, within the client's
    // request timeout, instead of making a new user repeat a successful search.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.pending.catch(() => undefined),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), waitMs);
        }),
      ]);
      return result ?? (await this.load());
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  readiness(corpus: Corpus) {
    const hasPages = corpus.pages.length > 0;
    if (this.pending)
      return {
        state: hasPages ? "updating" : "preparing",
        usable: hasPages,
        message: hasPages
          ? "Updating documentation. Cached pages remain available."
          : "Downloading documentation for the first time.",
        nextAction: hasPages
          ? "Ask your question; check retrieval dates in the answer."
          : "Try your question again in a few seconds. No setup command is needed.",
      };
    if (!hasPages)
      return {
        state: "unavailable",
        usable: false,
        message: "Documentation is not available on this computer yet.",
        nextAction:
          "Check your internet connection, then ask Claude to refresh Bitwarden Docs. No password or API key is needed.",
      };
    if (!status(corpus).sources.every((source) => source.complete))
      return {
        state: "degraded",
        usable: true,
        message:
          "Some documentation is stale or could not be updated. Cached pages remain available.",
        nextAction:
          "Use cached pages with their retrieval dates. Refresh before relying on prices or recently changed features.",
      };
    return {
      state: "ready",
      usable: true,
      message: "Bitwarden Docs is ready.",
      nextAction:
        "Ask your question. Claude should read the sources and cite them.",
    };
  }

  state() {
    return {
      refreshing: !!this.pending,
      checkingLinks: !!this.linking,
      refreshError: this.refreshError ?? null,
      linkError: this.linkError ?? null,
      retryAfter: this.retryAfter
        ? new Date(this.retryAfter).toISOString()
        : null,
    };
  }
}
