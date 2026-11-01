import { load } from "cheerio";
import { marked } from "marked";
import { createHash } from "node:crypto";

export type AnchorPage = {
  url: string;
  sha256: string;
  anchors?: Record<string, string>;
  anchorsCheckedAt?: string;
  anchorsSha256?: string;
};

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function plainText(markdown: string, omitTableHead = false): string {
  const $ = load(marked.parse(markdown, { async: false }));
  $("script,style,img").remove();
  if (omitTableHead) $("thead").remove();
  $("p,div,pre,li,tr,th,td,h1,h2,h3,h4,h5,h6,br").append(" ");
  return $("body").text().replace(/\s+/gu, " ").trim();
}

const clean = (value: string) => value.replace(/\s+/gu, " ").trim();

// Bitwarden help pages render headings inside `<div id="slug" class="scrollspy">`
// wrappers; the heading element itself usually has no id except the H1.
export function sectionAnchors(html: string): Record<string, string> {
  const $ = load(html);
  const result: Record<string, string> = {};
  const add = (id: string | undefined, title: string) => {
    if (id && id.length <= 300 && /^[\w-]+$/u.test(id) && clean(title))
      result[id] = clean(title);
  };
  $("main h1,main h2,main h3,main h4,main h5,main h6").each((_, element) => {
    const heading = $(element);
    const own =
      heading.attr("id") ??
      heading.find("a[href^='#']").first().attr("href")?.slice(1);
    if (own) return add(own, heading.text());
    const wrapper = heading.parent("[id].scrollspy");
    if (wrapper.length && wrapper.children("h1,h2,h3,h4,h5,h6").length === 1)
      add(wrapper.attr("id"), heading.text());
  });
  return result;
}

export type Citation = {
  sectionUrl: string | null;
  linkStatus: "verified" | "unverified";
  anchorCheckedAt: string | null;
  excerptSha256: string;
};

// Each search snapshot owns this resolver. A changed page body invalidates its anchors.
export function createCitationResolver() {
  const normalizedTitles = new Map<string, string>();
  const indexes = new WeakMap<Record<string, string>, Map<string, string[]>>();
  const normalize = (title: string) => {
    let value = normalizedTitles.get(title);
    if (value === undefined) {
      value = plainText(title).toLowerCase();
      normalizedTitles.set(title, value);
    }
    return value;
  };
  return (
    page: AnchorPage,
    section: { title: string } | null | undefined,
    excerpt: string,
  ): Citation => {
    const current =
      !!page.anchors &&
      !!page.anchorsCheckedAt &&
      page.anchorsSha256 === page.sha256;
    let index = current ? indexes.get(page.anchors!) : undefined;
    if (current && !index) {
      index = new Map();
      for (const [id, title] of Object.entries(page.anchors!)) {
        const key = normalize(title);
        index.set(key, [...(index.get(key) ?? []), id]);
      }
      indexes.set(page.anchors!, index);
    }
    const anchors =
      index && section ? (index.get(normalize(section.title)) ?? []) : [];
    const chosen = anchors.length === 1 ? anchors[0] : undefined;
    const url = new URL(page.url);
    url.hash = chosen ?? "";
    return {
      sectionUrl: chosen ? url.href : null,
      linkStatus: chosen ? "verified" : "unverified",
      anchorCheckedAt: chosen ? (page.anchorsCheckedAt ?? null) : null,
      excerptSha256: sha256(excerpt),
    };
  };
}

export function sectionCitation(
  page: AnchorPage,
  section: { title: string } | null | undefined,
  excerpt: string,
): Citation {
  return createCitationResolver()(page, section, excerpt);
}

export function plainExcerpt(
  document: string,
  startLine: number,
  endLine: number,
): string {
  const lines = document.split("\n");
  const selected = lines.slice(startLine - 1, endLine).join("\n");
  let fence: { marker: string; length: number; line: string } | undefined;
  for (const line of lines.slice(0, startLine - 1)) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    if (!fence)
      fence = { marker: match[1]![0]!, length: match[1]!.length, line };
    else if (
      match[1]![0] === fence.marker &&
      match[1]!.length >= fence.length &&
      !match[2]!.trim()
    )
      fence = undefined;
  }
  if (fence) return plainText(`${fence.line}\n${selected}`);
  if (/^\s*\|/.test(lines[startLine - 1] ?? "")) {
    let first = startLine - 1;
    while (first > 0 && /^\s*\|/.test(lines[first - 1]!)) first--;
    if (first < startLine - 1 && /^[\s|:-]+$/.test(lines[first + 1] ?? ""))
      return plainText(
        `${lines[first]}\n${lines[first + 1]}\n${selected}`,
        true,
      );
  }
  return plainText(selected);
}
