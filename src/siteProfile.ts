import { prisma } from "./db.js";
import { fetchWithTimeout } from "./linkExtract.js";
import { parseHex, clampForLegibility, domainHashColor } from "./color.js";

// Favicons are small by nature; anything bigger is a mis-tagged asset we don't
// want inlined into SQLite as base64.
const MAX_FAVICON_BYTES = 100_000;

export function domainOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

async function fetchFaviconDataUri(candidateUrl: string | null, domain: string): Promise<string | null> {
  const candidates = [candidateUrl, `https://${domain}/favicon.ico`].filter(
    (u): u is string => Boolean(u),
  );

  for (const url of candidates) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) continue;

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_FAVICON_BYTES) continue;

      return `data:${contentType.split(";")[0]};base64,${buffer.toString("base64")}`;
    } catch {
      // Try the next candidate - a missing favicon is never fatal.
    }
  }
  return null;
}

/**
 * Resolve and cache the visual identity for a domain.
 *
 * Deliberately non-throwing: a capture must still succeed if the favicon 404s
 * or the site is slow. Only the save path itself is allowed to fail loudly.
 */
export async function ensureSiteProfile(
  pageUrl: string,
  hints: { faviconUrl?: string | null; themeColor?: string | null } = {},
): Promise<void> {
  const domain = domainOf(pageUrl);
  if (!domain) return;

  try {
    const existing = await prisma.siteProfile.findUnique({ where: { domain } });
    // Cache hit: we already have this domain's icon, so skip the network entirely.
    if (existing?.faviconDataUri) return;

    const faviconDataUri = await fetchFaviconDataUri(hints.faviconUrl ?? null, domain);

    const themeHex = parseHex(hints.themeColor);
    const accentColor = themeHex ? clampForLegibility(themeHex) : domainHashColor(domain);
    // "domain-hash" is a signal to the frontend that it's worth deriving a
    // better colour from the favicon image and writing it back.
    const colorSource = themeHex ? "theme-color" : "domain-hash";

    await prisma.siteProfile.upsert({
      where: { domain },
      create: { domain, faviconDataUri, accentColor, colorSource },
      update: { faviconDataUri, accentColor, colorSource, fetchedAt: new Date() },
    });
  } catch (error) {
    console.error("Failed to build site profile for", domain, error);
  }
}

export async function getSiteProfiles(domains: string[]) {
  if (domains.length === 0) return new Map<string, { faviconDataUri: string | null; accentColor: string | null; colorSource: string | null }>();
  const rows = await prisma.siteProfile.findMany({ where: { domain: { in: domains } } });
  return new Map(
    rows.map((row) => [
      row.domain,
      {
        faviconDataUri: row.faviconDataUri,
        accentColor: row.accentColor,
        colorSource: row.colorSource,
      },
    ]),
  );
}

// Called by the frontend once it has derived a colour from the cached favicon
// image, so the work happens once per domain rather than on every page load.
export async function updateSiteColor(domain: string, hex: string): Promise<boolean> {
  const parsed = parseHex(hex);
  if (!parsed) return false;
  const result = await prisma.siteProfile.updateMany({
    where: { domain },
    data: { accentColor: clampForLegibility(parsed), colorSource: "favicon" },
  });
  return result.count > 0;
}
