import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export type ContentFidelity = "full_text" | "metadata_only" | "failed";

export interface ExtractResult {
  title: string | null;
  extractedText: string | null;
  contentFidelity: ContentFidelity;
}

const FETCH_TIMEOUT_MS = 10_000;
const MIN_FULL_TEXT_LENGTH = 200;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function fetchWithTimeout(url: string, headers: Record<string, string> = {}): Promise<Response> {
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
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(oembedUrl);
    if (!res.ok) return { title: null, extractedText: null, contentFidelity: "failed" };
    const data = (await res.json()) as { html?: string; author_name?: string };
    if (!data.html) return { title: null, extractedText: null, contentFidelity: "failed" };
    const text = new JSDOM(data.html).window.document.body.textContent?.trim() ?? "";
    if (!text) return { title: null, extractedText: null, contentFidelity: "failed" };
    return {
      title: data.author_name ? `Tweet from ${data.author_name}` : null,
      extractedText: text,
      contentFidelity: "metadata_only",
    };
  } catch {
    return { title: null, extractedText: null, contentFidelity: "failed" };
  }
}

function extractOpenGraphFallback(dom: JSDOM): ExtractResult {
  const doc = dom.window.document;
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
    return { title: null, extractedText: null, contentFidelity: "failed" };
  }

  if (isTwitterUrl(url)) {
    return extractViaTwitterOEmbed(rawUrl);
  }

  try {
    const res = await fetchWithTimeout(rawUrl, { "User-Agent": BROWSER_USER_AGENT });
    if (!res.ok) return { title: null, extractedText: null, contentFidelity: "failed" };
    const html = await res.text();
    const dom = new JSDOM(html, { url: rawUrl });

    const article = new Readability(dom.window.document.cloneNode(true) as Document).parse();
    const articleText = article?.textContent?.trim();

    if (articleText && articleText.length >= MIN_FULL_TEXT_LENGTH) {
      return {
        title: article?.title ?? null,
        extractedText: articleText,
        contentFidelity: "full_text",
      };
    }

    return extractOpenGraphFallback(dom);
  } catch {
    return { title: null, extractedText: null, contentFidelity: "failed" };
  }
}
