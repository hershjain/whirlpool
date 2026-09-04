// Shared by linkExtract.ts (fetching the saved page) and sourceProfile.ts
// (fetching favicons/manifests) so both time out the same way instead of
// each hand-rolling their own AbortController.

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

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
