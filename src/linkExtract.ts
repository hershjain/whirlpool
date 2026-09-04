import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { fetchWithTimeout, BROWSER_USER_AGENT } from "./httpFetch.js";

export type ContentFidelity = "full_text" | "metadata_only" | "failed";

export interface ExtractResult {
  title: string | null;
  extractedText: string | null;
  contentFidelity: ContentFidelity;
  // Byline / handle, e.g. "@paulg" or "Jane Smith" - shown on the card
  // beneath the title.
  author: string | null;
  // og:site_name, e.g. "The New York Times" - falls back to the source
  // profile's name, then the bare hostname, when null.
  siteName: string | null;
  // og:image, kept as a URL rather than bytes - hero images run 100KB-2MB
  // and don't belong in SQLite the way a favicon does.
  imageUrl: string | null;
}

const EMPTY_RESULT: ExtractResult = {
  title: null,
  extractedText: null,
  contentFidelity: "failed",
  author: null,
  siteName: null,
  imageUrl: null,
};

const MIN_FULL_TEXT_LENGTH = 200;

function isTwitterUrl(url: URL): boolean {
  return ["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(url.hostname);
}

// The oEmbed payload doesn't include the handle directly, but author_url is
// always "https://twitter.com/<handle>" - so pull it from there.
function handleFromAuthorUrl(authorUrl: string | undefined): string | null {
  if (!authorUrl) return null;
  try {
    const handle = new URL(authorUrl).pathname.split("/").filter(Boolean).at(-1);
    return handle ? `@${handle}` : null;
  } catch {
    return null;
  }
}

async function extractViaTwitterOEmbed(url: string): Promise<ExtractResult> {
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(oembedUrl);
    if (!res.ok) return EMPTY_RESULT;
    const data = (await res.json()) as { html?: string; author_name?: string; author_url?: string };
    if (!data.html) return EMPTY_RESULT;
    const text = new JSDOM(data.html).window.document.body.textContent?.trim() ?? "";
    if (!text) return EMPTY_RESULT;
    return {
      title: data.author_name ?? null,
      extractedText: text,
      contentFidelity: "metadata_only",
      author: handleFromAuthorUrl(data.author_url),
      siteName: "X",
      imageUrl: null, // oEmbed returns no image for a tweet
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// Reads whatever author/site metadata the page's <head> has, independent of
// which branch below ends up supplying the body text - a Readability success
// still needs its byline read from the *original* document, since Readability
// consumes a clone and doesn't expose the head at all.
// Readability's byline in particular tends to carry the page's own layout
// whitespace (a title/role on its own line, e.g. "Jane Doe\n    Engineering").
function cleanWhitespace(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned || null;
}

// og:image content is a bare string, and JSDOM only resolves relative URLs for
// real href/src attributes - so a "/og/cover.png" needs resolving by hand.
function absoluteUrl(href: string | null | undefined, baseUrl: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function extractHeadMetadata(doc: Document, baseUrl: string, readabilityByline: string | null) {
  const author = cleanWhitespace(
    readabilityByline ||
      doc.querySelector('meta[name="author"]')?.getAttribute("content") ||
      doc.querySelector('meta[property="article:author"]')?.getAttribute("content"),
  );
  const siteName = cleanWhitespace(doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content"));
  const imageUrl = absoluteUrl(
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ??
      doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content"),
    baseUrl,
  );
  return { author, siteName, imageUrl };
}

function extractOpenGraphFallback(doc: Document): Pick<ExtractResult, "title" | "extractedText" | "contentFidelity"> {
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");
  const title = ogTitle ?? doc.querySelector("title")?.textContent ?? null;

  if (!ogDescription && !title) {
    return { title: null, extractedText: null, contentFidelity: "failed" };
  }

  return {
    title,
    extractedText: ogDescription ?? null,
    contentFidelity: ogDescription ? "metadata_only" : "failed",
  };
}

export async function extractFromUrl(rawUrl: string): Promise<ExtractResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return EMPTY_RESULT;
  }

  if (isTwitterUrl(url)) {
    return extractViaTwitterOEmbed(rawUrl);
  }

  try {
    const res = await fetchWithTimeout(rawUrl, { headers: { "User-Agent": BROWSER_USER_AGENT } });
    if (!res.ok) return EMPTY_RESULT;
    const html = await res.text();
    const dom = new JSDOM(html, { url: rawUrl });
    const doc = dom.window.document;

    // Readability.parse() destructively consumes the document it's given, so
    // hand it a clone and keep reading `doc` (title/author/site-name meta)
    // afterward regardless of which branch below wins.
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    const articleText = article?.textContent?.trim();
    const { author, siteName, imageUrl } = extractHeadMetadata(doc, rawUrl, article?.byline ?? null);

    if (articleText && articleText.length >= MIN_FULL_TEXT_LENGTH) {
      return {
        title: article?.title ?? null,
        extractedText: articleText,
        contentFidelity: "full_text",
        author,
        siteName,
        imageUrl,
      };
    }

    return { ...extractOpenGraphFallback(doc), author, siteName, imageUrl };
  } catch {
    return EMPTY_RESULT;
  }
}
