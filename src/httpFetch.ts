import { safeFetch, type SafeResponse } from "./safeFetch.js";

// Shared by linkExtract.ts (fetching the saved page) and sourceProfile.ts
// (fetching favicons/manifests) so both time out the same way instead of
// each hand-rolling their own AbortController.

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

// A browser-like User-Agent alone isn't enough. Node's fetch defaults to
// `Sec-Fetch-Mode: cors`, which some WAFs read as a scripted request and
// refuse - apnews.com answers 403 to that and 200 the moment the request
// looks like a browser navigating to a page. These are the headers Chrome
// sends for a top-level navigation.
export const BROWSER_PAGE_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-Dest": "document",
  "Upgrade-Insecure-Requests": "1",
};

// The same trick for subresources - what Chrome sends when the page it just
// loaded pulls in an image.
export const BROWSER_IMAGE_HEADERS: Record<string, string> = {
  ...BROWSER_PAGE_HEADERS,
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Dest": "image",
};

// OpenStreetMap's tile policy and Nominatim's usage policy both require a
// User-Agent that identifies the application rather than impersonating a
// browser, and both refuse bulk use. Kept here beside the other header sets so
// the tile compositor and the reverse geocoder announce themselves identically.
//
// The contact URL is read straight off the environment rather than through
// config.ts: linkExtract imports this module, and config throws on a missing
// DATABASE_URL, which would make the pure URL-parsing tests need a database.
export const OSM_HEADERS: Record<string, string> = {
  "User-Agent": `Whirlpool/0.1 (+${process.env.PUBLIC_BASE_URL ?? "https://whirlpool.fly.dev"})`,
  Accept: "application/json",
};


// A handful of sites render everything client-side and serve a bare app shell
// to a browser UA - reddit.com answers 200 with 8KB of JavaScript and not one
// og: tag. The same URL fetched as a social crawler gets the pre-rendered
// version, tags and all, because that's the copy they build for link previews.
//
// Only for hosts proven to need it, never as the default: a crawler UA is not
// uniformly better. Reddit itself answers 403 to bingbot, and the Sec-Fetch
// headers above are what keep apnews.com returning 200.
export const CRAWLER_PAGE_HEADERS: Record<string, string> = {
  "User-Agent": "Twitterbot/1.0",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const DEFAULT_TIMEOUT_MS = 10_000;

// Page HTML goes straight into JSDOM and Readability, which are synchronous and
// memory-hungry, on the one thread that also serves every request. 2MB is
// comfortably more than any article and far less than what it takes to run a
// 512MB machine out of heap. Callers fetching something smaller - a favicon, an
// oEmbed document - pass their own.
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export interface FetchWithTimeoutOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

// Every outbound fetch in the app goes through here, which is why the SSRF
// guard lives behind it rather than at the call sites: linkExtract and
// sourceProfile both fetch hosts chosen by whoever sent the text, and a check
// that has to be remembered at eight call sites is a check that gets missed at
// the ninth.
//
// Returns a SafeResponse rather than a Response. Same member names, so callers
// are unchanged, but the body is read and capped before they see it and `url`
// is the final hop - each one validated.
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<SafeResponse> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES } = options;
  return safeFetch(url, { headers, timeoutMs, maxBytes });
}
