import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export type ContentFidelity = "full_text" | "metadata_only" | "failed";

export interface ExtractResult {
  title: string | null;
  extractedText: string | null;
  contentFidelity: ContentFidelity;
  // Visual hints for the card. These are candidates only - fetching and
  // caching the favicon itself happens in siteProfile.ts, which keys off the
  // domain rather than the individual page.
  imageUrl: string | null;
  faviconUrl: string | null;
  themeColor: string | null;
}

const FETCH_TIMEOUT_MS = 10_000;
const MIN_FULL_TEXT_LENGTH = 200;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const NO_VISUALS = { imageUrl: null, faviconUrl: null, themeColor: null };

export async function fetchWithTimeout(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isTwitterUrl(url: URL): boolean {
  return ["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(url.hostname);
}

async function extractViaTwitterOEmbed(url: string): Promise<ExtractResult> {
  // This path never fetches the page HTML, so there's no DOM to read a favicon
  // or theme-color from - siteProfile falls back to /favicon.ico for the domain.
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(oembedUrl);
    if (!res.ok) return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
    const data = (await res.json()) as { html?: string; author_name?: string };
    if (!data.html) return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
    const text = new JSDOM(data.html).window.document.body.textContent?.trim() ?? "";
    if (!text) return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
    return {
      title: data.author_name ? `Tweet from ${data.author_name}` : null,
      extractedText: text,
      contentFidelity: "metadata_only",
      ...NO_VISUALS,
    };
  } catch {
    return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
  }
}

export interface CardVisuals {
  imageUrl: string | null;
  faviconUrl: string | null;
  themeColor: string | null;
}

function absoluteUrl(href: string | null | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// Runs on every path, not just the metadata fallback - a page whose article
// text parsed fine still has an image and a brand colour worth keeping.
function parseCardVisuals(dom: JSDOM, baseUrl: string): CardVisuals {
  const doc = dom.window.document;

  const ogImage =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content");

  // apple-touch-icon first: it's typically a 180px PNG, which makes for a far
  // better colour sample than a 16px .ico.
  const iconHref =
    doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") ??
    doc.querySelector('link[rel="apple-touch-icon-precomposed"]')?.getAttribute("href") ??
    doc.querySelector('link[rel="icon"]')?.getAttribute("href") ??
    doc.querySelector('link[rel="shortcut icon"]')?.getAttribute("href");

  return {
    imageUrl: absoluteUrl(ogImage, baseUrl),
    faviconUrl: absoluteUrl(iconHref, baseUrl),
    themeColor: doc.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
  };
}

function extractOpenGraphFallback(dom: JSDOM, visuals: CardVisuals): ExtractResult {
  const doc = dom.window.document;
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");
  const title = ogTitle ?? doc.querySelector("title")?.textContent ?? null;

  if (!ogDescription && !title) {
    return { title: null, extractedText: null, contentFidelity: "failed", ...visuals };
  }

  return {
    title,
    extractedText: ogDescription ?? null,
    contentFidelity: ogDescription ? "metadata_only" : "failed",
    ...visuals,
  };
}

export async function extractFromUrl(rawUrl: string): Promise<ExtractResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
  }

  if (isTwitterUrl(url)) {
    return extractViaTwitterOEmbed(rawUrl);
  }

  try {
    const res = await fetchWithTimeout(rawUrl, { "User-Agent": BROWSER_USER_AGENT });
    if (!res.ok) return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
    const html = await res.text();
    const dom = new JSDOM(html, { url: rawUrl });
    const visuals = parseCardVisuals(dom, rawUrl);

    const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
    const articleText = article?.textContent?.trim();

    if (articleText && articleText.length >= MIN_FULL_TEXT_LENGTH) {
      return {
        title: article?.title ?? null,
        extractedText: articleText,
        contentFidelity: "full_text",
        ...visuals,
      };
    }

    return extractOpenGraphFallback(dom, visuals);
  } catch {
    return { title: null, extractedText: null, contentFidelity: "failed", ...NO_VISUALS };
  }
}
