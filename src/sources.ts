import { load } from "cheerio";
import { z } from "zod";

export const sourceSchema = z.enum(["help", "sales"]);
export type Source = z.infer<typeof sourceSchema>;
export type FetchText = (url: string) => Promise<string>;
export const HELP_FEED = "https://bitwarden.com/help/llms-full.txt";
export const SITEMAP = "https://bitwarden.com/sitemap.xml";
// Deliberate scope: links from the official root llms.txt, not a whole-site crawl.
export const SALES_PATHS = [
  "/products/personal",
  "/products/business",
  "/products/authenticator",
  "/passwordless-passkeys",
  "/products/secrets-manager",
  "/developers",
  "/integrations",
  "/self-hosted-password-manager-on-premises",
  "/pricing",
  "/pricing/business",
  "/compliance",
  "/open-source",
  "/products",
  "/bitwarden-alternatives",
  "/msp",
  "/products/send",
  "/case-studies",
] as const;

export function allowedUrl(value: string): URL {
  const url = new URL(value);
  const path = url.pathname.replace(/\/$/, "").replace(/\.md$/, "");
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname !== "bitwarden.com" ||
    !(
      url.href === HELP_FEED ||
      url.href === SITEMAP ||
      url.href === "https://bitwarden.com/llms.txt" ||
      /^\/help\/(?:courses\/)?[a-z0-9-]+$/.test(path) ||
      (SALES_PATHS as readonly string[]).includes(path)
    )
  ) {
    throw new Error("Not an allowed official documentation URL");
  }
  return url;
}

export function canonicalUrl(value: string): string {
  const url = allowedUrl(value);
  url.pathname = url.pathname.replace(/\.md$/, "").replace(/\/$/, "") + "/";
  return url.href;
}

export function validateMarkdown(text: string): string {
  const title = text.match(/^# (.+)$/m)?.[1]?.trim();
  if (
    !title ||
    Buffer.byteLength(text) > 512_000 ||
    text.split("\n").length > 20_000 ||
    (text.match(/^#{1,6} /gm)?.length ?? 0) > 1500 ||
    text.includes("\u0000") ||
    text.trim().length < 80 ||
    /^\s*<(?:!doctype|html)[\s>]/i.test(text) ||
    /^#\s*(?:404|page not found|access denied|not found)\b/im.test(text)
  ) {
    throw new Error("Invalid or empty Markdown document");
  }
  return title;
}

export type Document = { url: string; text: string; fetchedFrom: string };
export type Exclusion = { url: string; reason: string };
export function parseHelpFeed(raw: string): Document[] {
  const text = raw.replace(/\r\n/g, "\n");
  const pattern = /^---\nURL: (https:\/\/[^\s]+)\n---\n/gm;
  const markers = [...text.matchAll(pattern)];
  if (!markers.length || text.slice(0, markers[0]!.index).trim())
    throw new Error("Help feed has no valid document boundaries");
  if (markers.length > 2000)
    throw new Error("Help feed exceeds the safe document-count limit");
  const seen = new Set<string>();
  return markers.map((marker, i) => {
    const url = canonicalUrl(marker[1]!);
    if (
      !/^https:\/\/bitwarden\.com\/help\/(?:courses\/)?[a-z0-9-]+\/$/.test(url)
    )
      throw new Error("Help feed contains a non-help document");
    if (seen.has(url))
      throw new Error("Help feed contains duplicate canonical URLs");
    seen.add(url);
    const body = text
      .slice(marker.index! + marker[0].length, markers[i + 1]?.index)
      .trim();
    if (/^URL: https:\/\//m.test(body))
      throw new Error("Malformed feed boundary");
    return { url, text: body, fetchedFrom: HELP_FEED };
  });
}

export function sitemapHelpUrls(xml: string): string[] {
  const $ = load(xml, { xmlMode: true });
  if (!$("urlset").length) throw new Error("Invalid help sitemap");
  const urls = $("loc")
    .map((_, node) => $(node).text().trim())
    .get()
    .filter((url) =>
      /^https:\/\/bitwarden\.com\/help\/(?:courses\/)?[a-z0-9-]+\/$/.test(url),
    )
    .map(canonicalUrl);
  if (!urls.length) throw new Error("Sitemap contains no help articles");
  return [...new Set(urls)];
}

export async function discover(source: Source, fetcher: FetchText) {
  const errors: string[] = [];
  const failed: { url: string; error: string }[] = [];
  const excluded: Exclusion[] = [];
  const validatedExtras: string[] = [];
  const documents: Document[] = [];
  let candidates: Document[];
  let sitemap: Set<string> | undefined;
  if (source === "help") {
    candidates = parseHelpFeed(await fetcher(HELP_FEED));
    try {
      sitemap = new Set(sitemapHelpUrls(await fetcher(SITEMAP)));
      const present = new Set(candidates.map((page) => page.url));
      for (const url of sitemap) {
        if (!present.has(url))
          candidates.push({
            url,
            text: "",
            fetchedFrom: url.replace(/\/$/, ".md"),
          });
      }
    } catch {
      throw new Error(
        "Sitemap discovery failed; previous help cache retained because feed-only pages cannot be validated",
      );
    }
  } else {
    excluded.push({
      url: "https://bitwarden.com/enterprise-password-manager/",
      reason:
        "Retired page: both HTML and Markdown returned HTTP 404 during validation on 2026-10-27; use the business product and pricing references",
    });
    const index = await fetcher("https://bitwarden.com/llms.txt");
    const linked = new Set(
      [...index.matchAll(/\]\((https:\/\/bitwarden\.com\/[^)\s]+)\)/g)].map(
        (match) =>
          match[1]!.replace(/#.*/, "").replace(/\.md$/, "").replace(/\/$/, ""),
      ),
    );
    candidates = SALES_PATHS.map((path) => {
      const url = `https://bitwarden.com${path}/`;
      if (!linked.has(url.replace(/\/$/, "")))
        errors.push(`Sales reference absent from official index: ${url}`);
      return { url, text: "", fetchedFrom: `https://bitwarden.com${path}.md` };
    });
  }
  for (const candidate of candidates) {
    if (
      candidate.url.endsWith("/placeholder/") ||
      /^# placeholder(?: page)?\s*$/im.test(candidate.text)
    ) {
      excluded.push({
        url: candidate.url,
        reason: "Publisher placeholder, not product documentation",
      });
      continue;
    }
    const extra = source === "help" && sitemap && !sitemap.has(candidate.url);
    try {
      if (!candidate.text || extra) {
        candidate.fetchedFrom = candidate.url.replace(/\/$/, ".md");
        candidate.text = (await fetcher(candidate.fetchedFrom)).trim();
      }
      validateMarkdown(candidate.text);
      if (extra) validatedExtras.push(candidate.url);
      documents.push(candidate);
    } catch (error) {
      if (extra && error instanceof Error && error.message === "HTTP 404") {
        // An unpublished/retired feed-only article must not become sales evidence.
        try {
          await fetcher(candidate.url);
        } catch (htmlError) {
          if (htmlError instanceof Error && htmlError.message === "HTTP 404") {
            excluded.push({
              url: candidate.url,
              reason:
                "Feed-only article: both public Markdown and HTML return HTTP 404",
            });
            continue;
          }
        }
      }
      failed.push({
        url: candidate.url,
        error: "Document fetch or Markdown validation failed",
      });
    }
  }
  return {
    documents,
    urls: candidates
      .filter((page) => !excluded.some((item) => item.url === page.url))
      .map((page) => page.url),
    version: "live",
    errors,
    failed,
    excluded,
    validatedExtras,
  };
}
