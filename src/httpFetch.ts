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

export interface FetchWithTimeoutOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
