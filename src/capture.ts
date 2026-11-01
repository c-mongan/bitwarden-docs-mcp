import {
  chromium,
  type BrowserContext,
  type Page as BrowserPage,
} from "playwright-core";
import {
  mkdtemp,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { CACHE, allowedUrl, type SearchIndex } from "./corpus.js";
import { plainExcerpt, sectionCitation, sha256 } from "./evidence-text.js";
import { privateDirectory } from "./local-files.js";

export type CaptureInput = {
  id: string;
  revision: string;
  startLine: number;
  endLine: number;
  sectionId?: string;
};
export type CaptureStatus =
  | "captured"
  | "source_changed"
  | "ambiguous"
  | "too_large"
  | "unavailable"
  | "busy";
export type CaptureResult = {
  metadata: Record<string, unknown> & { status: CaptureStatus };
  image?: Buffer;
};

let active = false;
const MAX_IMAGE_BYTES = 1_500_000;
export const VIEWPORT = { width: 1200, height: 900 };
export const BROWSER_CHANNELS = ["chrome", "msedge"] as const;
const PROFILE_PREFIX = "browser-profile-";

export function captureUrl(value: string): URL {
  const url = allowedUrl(value);
  const path = url.pathname.replace(/\/$/, "");
  if (
    path === "/help/llms-full.txt" ||
    path === "/llms.txt" ||
    path === "/sitemap.xml"
  )
    throw new Error(
      "Evidence capture is limited to official documentation pages.",
    );
  return url;
}

// Only GET/HEAD over HTTPS to bitwarden.com; navigations must stay on allowlisted pages.
export function allowRequest(
  method: string,
  value: string,
  navigation: boolean,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    !["GET", "HEAD"].includes(method) ||
    url.protocol !== "https:" ||
    url.hostname !== "bitwarden.com" ||
    url.port ||
    url.username ||
    url.password
  )
    return false;
  if (!navigation) return true;
  try {
    captureUrl(url.href);
    return true;
  } catch {
    return false;
  }
}

export type LaunchOptions = Parameters<
  typeof chromium.launchPersistentContext
>[1];
export type Launcher = (
  userDataDir: string,
  options: LaunchOptions,
) => Promise<BrowserContext>;

// Fresh, private, temporary profile only. Never a user's existing browser profile.
export function launchOptions(channel: string): LaunchOptions {
  return {
    channel,
    headless: true,
    chromiumSandbox: true,
    timeout: 10_000,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: "en-US",
    serviceWorkers: "block",
    acceptDownloads: false,
    javaScriptEnabled: true,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    permissions: [],
    args: [
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
    ],
  };
}

export async function openIsolatedBrowser(
  cache: string,
  launch: Launcher = (dir, options) =>
    chromium.launchPersistentContext(dir, options),
) {
  await privateDirectory(cache);
  await removeStaleProfiles(cache);
  const profile = await mkdtemp(join(cache, PROFILE_PREFIX));
  const errors: string[] = [];
  for (const channel of BROWSER_CHANNELS) {
    try {
      const context = await launch(profile, launchOptions(channel));
      return { context, profile, channel };
    } catch (error) {
      errors.push(
        `${channel}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
  }
  await rm(profile, { recursive: true, force: true });
  throw new Error(
    `No installed Google Chrome or Microsoft Edge could be started for evidence capture. ${errors.join("; ")}`,
  );
}

// Profiles left by a crashed process are removed after ten minutes.
export async function removeStaleProfiles(cache: string, now = Date.now()) {
  for (const name of await readdir(cache).catch(() => [] as string[])) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const info = await stat(join(cache, name)).catch(() => undefined);
    if (info?.isDirectory() && now - info.mtimeMs > 600_000)
      await rm(join(cache, name), { recursive: true, force: true });
  }
}

export function selectEvidence(index: SearchIndex, input: CaptureInput) {
  if (input.endLine < input.startLine || input.endLine - input.startLine >= 40)
    throw new Error("Choose between 1 and 40 source lines.");
  const read = index.read(
    input.id,
    input.startLine,
    input.endLine - input.startLine + 1,
    input.sectionId,
    input.revision,
  );
  const document = index.corpus.pages.find((page) => page.id === input.id)!;
  const section =
    read.section ??
    read.sections.findLast(
      (section) =>
        section.startLine <= input.startLine &&
        section.endLine >= input.endLine,
    );
  const source = {
    ...read,
    ...sectionCitation(document, section, read.text),
    section: section ?? null,
  };
  if (source.endLine !== input.endLine)
    throw new Error(
      "Requested passage exceeds its section or reply limit. Use the exact range returned by read_doc.",
    );
  const text = plainExcerpt(document.text, input.startLine, input.endLine);
  if (text.length < 20 || text.length > 2400)
    throw new Error(
      "Choose a passage of 20–2400 visible characters. Include the complete statement and its qualifications.",
    );
  captureUrl(source.url);
  return { source, text };
}

// A static DOM operation: page text is data, never code or selectors supplied by a source.
export async function capturePage(
  page: BrowserPage,
  text: string,
  sectionUrl: string | null,
): Promise<{
  status: CaptureStatus;
  reason?: string;
  image?: Buffer;
  original?: Buffer;
  clip?: { x: number; y: number; width: number; height: number };
  anchor?: string;
}> {
  await page.addStyleTag({ content: "* {scroll-behavior:auto!important}" });
  await page.evaluate(() =>
    Promise.race([
      document.fonts.ready,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]),
  );
  const anchor = sectionUrl
    ? decodeURIComponent(new URL(sectionUrl).hash.slice(1))
    : "";
  const match = await page.evaluate(
    ({ expected, anchor }) => {
      const main = document.querySelector("main");
      if (!main)
        return {
          status: "unavailable" as const,
          reason: "Page has no main document.",
        };
      const heading = anchor ? document.getElementById(anchor) : null;
      if (anchor && !heading)
        return {
          status: "source_changed" as const,
          reason: "The previously verified heading anchor is missing.",
        };
      const headingLevel =
        heading && /^H[1-6]$/.test(heading.tagName)
          ? Number(heading.tagName[1])
          : 0;
      const boundary = headingLevel
        ? Array.from(main.querySelectorAll("h1,h2,h3,h4,h5,h6")).find(
            (n) =>
              heading!.compareDocumentPosition(n) &
                Node.DOCUMENT_POSITION_FOLLOWING &&
              Number(n.tagName[1]) <= headingLevel,
          )
        : null;
      const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
      const mapping: { node: Text; offset: number }[] = [];
      let normalized = "";
      let previousBlock: Element | null = null;
      for (
        let current = walker.nextNode();
        current;
        current = walker.nextNode()
      ) {
        const node = current as Text,
          parent = node.parentElement;
        if (
          !parent ||
          parent.closest('script,style,nav,button,[aria-hidden="true"]')
        )
          continue;
        if (
          heading &&
          !(
            heading.contains(parent) ||
            heading.compareDocumentPosition(parent) &
              Node.DOCUMENT_POSITION_FOLLOWING
          )
        )
          continue;
        if (
          boundary &&
          (boundary.contains(parent) ||
            boundary.compareDocumentPosition(parent) &
              Node.DOCUMENT_POSITION_FOLLOWING)
        )
          continue;
        const style = getComputedStyle(parent);
        if (
          style.visibility === "hidden" ||
          !parent.getClientRects().length ||
          !parent.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          })
        )
          continue;
        const block = parent.closest(
          "p,pre,li,tr,h1,h2,h3,h4,h5,h6,td,th,blockquote,div",
        );
        if (
          previousBlock &&
          block !== previousBlock &&
          normalized &&
          !normalized.endsWith(" ")
        ) {
          normalized += " ";
          mapping.push({ node, offset: 0 });
        }
        previousBlock = block;
        for (let offset = 0; offset < node.data.length; offset++) {
          const char = node.data[offset]!;
          if (/\s/u.test(char)) {
            if (normalized && !normalized.endsWith(" ")) {
              normalized += " ";
              mapping.push({ node, offset });
            }
          } else {
            normalized += char;
            mapping.push({ node, offset });
          }
        }
      }
      const first = normalized.indexOf(expected);
      if (first < 0)
        return {
          status: "source_changed" as const,
          reason:
            "The cached passage does not match visible text in the live section.",
        };
      if (normalized.indexOf(expected, first + 1) >= 0)
        return {
          status: "ambiguous" as const,
          reason:
            "The passage occurs more than once. Select a narrower section or a more specific passage.",
        };
      const start = mapping[first]!,
        end = mapping[first + expected.length - 1]!;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      const firstBlock =
        start.node.parentElement!.closest(
          "p,pre,li,tr,blockquote,h1,h2,h3,h4,h5,h6",
        ) ?? start.node.parentElement!;
      const lastBlock =
        end.node.parentElement!.closest(
          "p,pre,li,tr,blockquote,h1,h2,h3,h4,h5,h6",
        ) ?? end.node.parentElement!;
      firstBlock.scrollIntoView({ block: "center", behavior: "instant" });
      lastBlock.scrollIntoView({ block: "nearest", behavior: "instant" });
      firstBlock.scrollIntoView({ block: "nearest", behavior: "instant" });
      const nodes = [
        ...new Set(
          mapping
            .slice(first, first + expected.length)
            .map((item) => item.node),
        ),
      ];
      const segments = nodes
        .map((node) => {
          const part = document.createRange();
          part.setStart(node, node === start.node ? start.offset : 0);
          part.setEnd(
            node,
            node === end.node ? end.offset + 1 : node.data.length,
          );
          return part;
        })
        .filter((part) => !part.collapsed);
      function visibilityProblem(): string | null {
        const rects = segments
          .flatMap((part) => Array.from(part.getClientRects()))
          .filter((box) => box.width > 0.5 && box.height > 0.5);
        if (!rects.length)
          return "The selected source has no visible painted text area.";
        let left = 0,
          right = innerWidth;
        let ancestor =
          range.commonAncestorContainer instanceof Element
            ? range.commonAncestorContainer
            : range.commonAncestorContainer.parentElement;
        while (ancestor) {
          const css = getComputedStyle(ancestor),
            box = ancestor.getBoundingClientRect();
          if (["auto", "scroll", "hidden", "clip"].includes(css.overflowX)) {
            left = Math.max(left, box.left + ancestor.clientLeft);
            right = Math.min(
              right,
              box.left + ancestor.clientLeft + ancestor.clientWidth,
            );
          }
          if (
            ancestor !== document.body &&
            ancestor !== document.documentElement &&
            ["auto", "scroll", "hidden", "clip"].includes(css.overflowY)
          ) {
            const top = box.top + ancestor.clientTop,
              bottom = top + ancestor.clientHeight;
            if (rects.some((r) => r.top < top - 1 || r.bottom > bottom + 1))
              return "The selected source is vertically clipped by its container.";
          }
          ancestor = ancestor.parentElement;
        }
        if (rects.some((box) => box.left < left - 1 || box.right > right + 1))
          return "The selected source is horizontally clipped by its container.";
        // Hit-test only; this temporary rule does not change pixels and is removed before capture.
        const pointerStyle = document.createElement("style");
        pointerStyle.textContent = "* {pointer-events:auto!important}";
        document.head.append(pointerStyle);
        try {
          for (const part of segments) {
            const owner = part.startContainer.parentElement;
            if (
              part.startContainer.nodeType !== Node.TEXT_NODE ||
              !part.startContainer.isConnected ||
              !owner?.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            )
              return "The selected source is no longer visibly rendered.";
            const node = part.startContainer as Text;
            for (let offset = part.startOffset; offset < part.endOffset;) {
              const character = String.fromCodePoint(
                node.data.codePointAt(offset)!,
              );
              const next = Math.min(part.endOffset, offset + character.length);
              if (!/\s/u.test(character)) {
                const glyph = document.createRange();
                glyph.setStart(node, offset);
                glyph.setEnd(node, next);
                for (const box of Array.from(glyph.getClientRects())) {
                  if (box.width < 0.5 || box.height < 0.5) continue;
                  const y = box.top + box.height / 2;
                  if (y < 0 || y >= innerHeight)
                    return "The selected source is clipped by the capture viewport.";
                  const x = box.left + box.width / 2;
                  const top = document.elementsFromPoint(x, y).find((el) =>
                    el.checkVisibility({
                      checkOpacity: true,
                      checkVisibilityCSS: true,
                    }),
                  );
                  if (!top || !(owner.contains(top) || top.contains(owner)))
                    return "The selected source is covered by another page element.";
                }
              }
              offset = next;
            }
          }
        } finally {
          pointerStyle.remove();
        }
        return null;
      }
      const problem = visibilityProblem();
      if (problem)
        return {
          status: problem.includes("clipped")
            ? ("too_large" as const)
            : ("unavailable" as const),
          reason: problem,
        };
      const boxes = [
        range.getBoundingClientRect(),
        firstBlock.getBoundingClientRect(),
        lastBlock.getBoundingClientRect(),
      ];
      const headings = Array.from(main.querySelectorAll("h1,h2,h3,h4,h5,h6"));
      const nearby =
        heading ??
        headings
          .filter(
            (n) =>
              n.contains(firstBlock) ||
              n.compareDocumentPosition(firstBlock) &
                Node.DOCUMENT_POSITION_FOLLOWING,
          )
          .at(-1);
      const table = firstBlock.closest("table");
      if (table?.querySelector("thead"))
        boxes.push(table.querySelector("thead")!.getBoundingClientRect());
      if (nearby) {
        const box = nearby.getBoundingClientRect();
        const top = Math.min(...boxes.map((b) => b.top));
        if (box.bottom <= top && top - box.bottom < 180) boxes.push(box);
      }
      const x = Math.max(0, Math.min(...boxes.map((b) => b.left)) - 16),
        top = Math.min(...boxes.map((b) => b.top)) - 16;
      const width = Math.min(
        document.documentElement.scrollWidth - x,
        Math.max(...boxes.map((b) => b.right)) - x + 16,
      );
      const height = Math.max(...boxes.map((b) => b.bottom)) - top + 8;
      if (width > 1200 || height > 850 || height < 1 || width < 1)
        return {
          status: "too_large" as const,
          reason:
            "The complete passage and context do not fit a bounded capture. Select fewer lines.",
        };
      // Preserve the exact range for the later visual annotation. No source text is changed.
      (
        window as unknown as { __docsEvidenceRange: Range }
      ).__docsEvidenceRange = range;
      (window as unknown as { __docsEvidenceText: string }).__docsEvidenceText =
        range.toString();
      (
        window as unknown as { __docsEvidenceSegments: Range[] }
      ).__docsEvidenceSegments = segments;
      (
        window as unknown as { __docsEvidenceVisible: () => string | null }
      ).__docsEvidenceVisible = visibilityProblem;
      const actualAnchor =
        nearby?.id ||
        nearby?.querySelector('a[href^="#"]')?.getAttribute("href")?.slice(1);
      return {
        status: "captured" as const,
        clip: { x: x + scrollX, y: Math.max(0, top + scrollY), width, height },
        anchor: actualAnchor,
      };
    },
    { expected: text, anchor },
  );
  if (match.status !== "captured") return match;
  await page.addStyleTag({ content: "html {scroll-behavior:auto!important}" });
  const original = await page.screenshot({
    fullPage: true,
    clip: match.clip,
    animations: "disabled",
    scale: "css",
    timeout: 5000,
  });
  await page.addStyleTag({
    content: "::highlight(docs-mcp-evidence){background:#ffe28a;color:#111}",
  });
  await page.evaluate(() => {
    const custom = window as unknown as { __docsEvidenceSegments: Range[] };
    const browser = window as unknown as {
      Highlight: new (...ranges: Range[]) => unknown;
    };
    (CSS as unknown as { highlights: Map<string, unknown> }).highlights.set(
      "docs-mcp-evidence",
      new browser.Highlight(...custom.__docsEvidenceSegments),
    );
  });
  const image = await page.screenshot({
    fullPage: true,
    clip: match.clip,
    animations: "disabled",
    scale: "css",
    timeout: 5000,
  });
  const stable = await page.evaluate(() => {
    const state = window as unknown as {
      __docsEvidenceRange: Range;
      __docsEvidenceText: string;
    };
    return (
      !state.__docsEvidenceRange.collapsed &&
      state.__docsEvidenceRange.toString() === state.__docsEvidenceText
    );
  });
  if (!stable)
    return {
      status: "source_changed",
      reason: "The passage changed while the screenshot was being captured.",
    };
  const obscured = await page.evaluate(() =>
    (
      window as unknown as { __docsEvidenceVisible: () => string | null }
    ).__docsEvidenceVisible(),
  );
  if (obscured) return { status: "unavailable", reason: obscured };
  if (image.length > MAX_IMAGE_BYTES || original.length > MAX_IMAGE_BYTES)
    return {
      status: "too_large",
      reason:
        "Screenshot exceeds the 1.5 MB image limit. Select a smaller passage.",
    };
  return { ...match, image, original };
}

export async function captureEvidence(
  index: SearchIndex,
  input: CaptureInput,
  cache = CACHE,
  launch?: Launcher,
): Promise<CaptureResult> {
  const { source, text } = selectEvidence(index, input);
  const base = {
    documentId: source.id,
    url: source.url,
    sectionUrl: source.sectionUrl,
    linkStatus: source.linkStatus,
    sectionId: input.sectionId ?? source.section?.id ?? null,
    revision: source.revision,
    sourceSha256: source.sha256,
    excerptSha256: source.excerptSha256,
    excerpt: source.text,
    startLine: source.startLine,
    endLine: source.endLine,
    version: source.version,
    source: source.source,
    fetchedAt: source.fetchedAt,
    stale: source.stale,
  };
  if (active)
    return {
      metadata: {
        ...base,
        status: "busy",
        reason:
          "One evidence capture is already running. Retry after it finishes.",
      },
    };
  active = true;
  let browser: Awaited<ReturnType<typeof openIsolatedBrowser>> | undefined;
  const deadline = setTimeout(() => {
    void browser?.context.close().catch(() => {});
  }, 45_000);
  try {
    browser = await openIsolatedBrowser(cache, launch);
    const { context } = browser;
    await context.route("**/*", (route) =>
      allowRequest(
        route.request().method(),
        route.request().url(),
        route.request().isNavigationRequest(),
      )
        ? route.continue()
        : route.abort(),
    );
    await context.routeWebSocket(/.*/, (socket) => socket.close());
    const first = context.pages()[0] ?? (await context.newPage());
    for (const extra of context.pages())
      if (extra !== first) await extra.close();
    // Popups opened by the page are closed; only the first tab is captured.
    context.on("page", (page) => {
      if (page !== first) void page.close().catch(() => {});
    });
    const page = first;
    page.setDefaultTimeout(5000);
    await page.goto(source.url, { waitUntil: "load", timeout: 18_000 });
    const final = captureUrl(page.url());
    if (
      final.pathname.replace(/\/$/, "") !==
      new URL(source.url).pathname.replace(/\/$/, "")
    )
      return {
        metadata: {
          ...base,
          status: "source_changed",
          reason:
            "The document redirected to a different page. Refresh the source before capture.",
        },
      };
    await page.locator("main").first().waitFor({ timeout: 5000 });
    const capture = await capturePage(page, text, source.sectionUrl);
    if (capture.status !== "captured")
      return {
        metadata: { ...base, status: capture.status, reason: capture.reason },
      };
    const capturedAt = new Date().toISOString();
    const png = capture.image!;
    const key = sha256(
      JSON.stringify({
        id: source.id,
        revision: source.revision,
        start: input.startLine,
        end: input.endLine,
        capturedAt,
      }),
    );
    const dir = join(cache, "evidence");
    await privateDirectory(dir);
    const artifactPath = join(dir, `${key}.png`);
    const originalPath = join(dir, `${key}.original.png`);
    await writeFile(artifactPath, png, { mode: 0o600, flag: "wx" });
    await writeFile(originalPath, capture.original!, {
      mode: 0o600,
      flag: "wx",
    });
    // Keep at most 40 image files (about 20 captures).
    const old = await Promise.all(
      (await readdir(dir))
        .filter((name) => /^[a-f0-9]{64}(\.original)?\.png$/.test(name))
        .map(async (name) => {
          const info = await stat(join(dir, name)).catch(() => null);
          return info ? { name, at: info.mtimeMs } : null;
        }),
    );
    for (const file of old
      .filter((file) => file !== null)
      .sort((a, b) => b.at - a.at)
      .slice(40))
      await unlink(join(dir, file.name)).catch(() => {});
    const sectionUrl = new URL(source.url);
    sectionUrl.hash = capture.anchor ?? "";
    return {
      metadata: {
        ...base,
        status: "captured",
        sectionUrl: capture.anchor ? sectionUrl.href : source.sectionUrl,
        liveMatch: "exact_normalized_visible_text",
        matchedTextSha256: sha256(text),
        capturedAt,
        liveUrl: page.url(),
        browser: browser.channel,
        isolation:
          "Headless installed browser with a new temporary profile (deleted after capture), service workers blocked and only bitwarden.com GET/HEAD requests allowed.",
        highlightAdded: true,
        viewport: VIEWPORT,
        clip: capture.clip,
        imageSha256: sha256(png),
        mimeType: "image/png",
        bytes: png.length,
        artifactPath,
        originalPath,
      },
      image: png,
    };
  } catch (error) {
    return {
      metadata: {
        ...base,
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message.split("\n")[0]!
            : String(error),
        fallback:
          "Use the exact cached excerpt and source link. No screenshot is presented as proof.",
      },
    };
  } finally {
    clearTimeout(deadline);
    try {
      await browser?.context.close().catch(() => {});
    } finally {
      if (browser) await rm(browser.profile, { recursive: true, force: true });
      active = false;
    }
  }
}
