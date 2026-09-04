import { JSDOM } from "jsdom";
import sharp from "sharp";
import type { SourceProfile } from "@prisma/client";
import { prisma } from "./db.js";
import { fetchWithTimeout, BROWSER_USER_AGENT } from "./httpFetch.js";

// Resolves the branding (name, color, cached logo) shown on a card's header
// bar, for any hostname on the internet. A user can save a link from any
// site, so a hardcoded table alone can never be complete - this layers a
// curated list of popular sites over an automatic ladder that extracts real
// branding from the page itself, with a hash-based color as the last resort
// so even a completely unrecognized site still gets a stable, distinct look.
//
// Resolution order for color:
//   1. curated map            (x.com, youtube.com, reddit.com, ...)
//   2. <meta name="theme-color">
//   3. web app manifest's theme_color
//   4. dominant color sampled from the site's own favicon
//   5. a color hashed from the hostname (stable, never fails)
//
// One row per hostname, cached in SourceProfile, so each domain is resolved
// once and every item from it reuses the same row.

const ICON_FETCH_TIMEOUT_MS = 5_000;
const MAX_ICON_BYTES = 256 * 1024;
const PROFILE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // re-resolve a healthy profile monthly
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000; // retry sooner if we came up empty

interface CuratedSource {
  name: string;
  color: string;
}

// Curation only ever overrides name + color - the logo is still fetched for
// real from the site itself (see fetchIcon), never hand-supplied here.
const CURATED_SOURCES: Record<string, CuratedSource> = {
  "x.com": { name: "X", color: "#000000" },
  "twitter.com": { name: "X", color: "#000000" },
  "youtube.com": { name: "YouTube", color: "#FF0000" },
  "reddit.com": { name: "Reddit", color: "#FF4500" },
  "github.com": { name: "GitHub", color: "#24292F" },
  "instagram.com": { name: "Instagram", color: "#E1306C" },
  "tiktok.com": { name: "TikTok", color: "#000000" },
  "linkedin.com": { name: "LinkedIn", color: "#0A66C2" },
  "substack.com": { name: "Substack", color: "#FF6719" },
  "medium.com": { name: "Medium", color: "#000000" },
  "nytimes.com": { name: "The New York Times", color: "#000000" },
  "arxiv.org": { name: "arXiv", color: "#B31B1B" },
  "open.spotify.com": { name: "Spotify", color: "#1DB954" },
  "news.ycombinator.com": { name: "Hacker News", color: "#FF6600" },
  "wikipedia.org": { name: "Wikipedia", color: "#000000" },
};

function stripWww(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

// Real sites are commonly reached through a subdomain the curated map
// doesn't spell out ("en.wikipedia.org", "old.reddit.com", "gist.github.com")
// - match the curated entry for the domain a hostname belongs to, not just
// an exact-string hostname. Stops short of matching the bare TLD.
function curatedFor(hostname: string): CuratedSource | undefined {
  const parts = hostname.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = CURATED_SOURCES[parts.slice(i).join(".")];
    if (candidate) return candidate;
  }
  return undefined;
}

export function normalizeHostname(rawUrl: string): string | null {
  try {
    return stripWww(new URL(rawUrl).hostname);
  } catch {
    return null;
  }
}

function isFresh(profile: SourceProfile): boolean {
  const age = Date.now() - profile.fetchedAt.getTime();
  return age < (profile.fetchFailed ? FAILED_RETRY_MS : PROFILE_TTL_MS);
}

export async function resolveSourceProfile(url: URL, dom: JSDOM | null): Promise<SourceProfile> {
  const hostname = stripWww(url.hostname);

  const cached = await prisma.sourceProfile.findUnique({ where: { hostname } });
  if (cached && isFresh(cached)) return cached;

  const built = await buildSourceProfile(hostname, dom);
  return prisma.sourceProfile.upsert({
    where: { hostname },
    create: { hostname, ...built },
    update: built,
  });
}

function isTwitterHost(hostname: string): boolean {
  return hostname === "twitter.com" || hostname === "x.com";
}

async function fetchPageDom(rawUrl: string): Promise<JSDOM | null> {
  try {
    const res = await fetchWithTimeout(rawUrl, { headers: { "User-Agent": BROWSER_USER_AGENT } });
    if (!res.ok) return null;
    const html = await res.text();
    return new JSDOM(html, { url: rawUrl });
  } catch {
    return null;
  }
}

// Entry point for capturing a link: checks the cache before doing any
// network work at all, so every item after the first from a given hostname
// costs nothing but a local read. Only a first-ever (or expired) hostname
// pays for a page fetch here - a second one alongside the fetch already done
// in linkExtract.ts, accepted as the price of keeping the two modules
// decoupled rather than threading a shared DOM between them.
export async function resolveSourceProfileForCapture(rawUrl: string): Promise<SourceProfile | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const hostname = stripWww(url.hostname);
  const cached = await prisma.sourceProfile.findUnique({ where: { hostname } });
  if (cached && isFresh(cached)) return cached;

  const dom = isTwitterHost(hostname) ? null : await fetchPageDom(rawUrl);
  return resolveSourceProfile(url, dom);
}

type BuiltProfile = Omit<SourceProfile, "hostname">;

async function buildSourceProfile(hostname: string, dom: JSDOM | null): Promise<BuiltProfile> {
  const curated = curatedFor(hostname);
  const signals = dom ? await gatherPageSignals(dom.window.document) : { iconCandidates: [], themeColor: null, manifestThemeColor: null };

  const icon = await fetchIcon(hostname, signals.iconCandidates);
  const iconColor = icon ? await dominantColor(icon.bytes) : null;

  const [color, colorSource]: [string, string] = curated
    ? [curated.color, "curated"]
    : signals.themeColor
      ? [signals.themeColor, "theme-color"]
      : signals.manifestThemeColor
        ? [signals.manifestThemeColor, "manifest"]
        : iconColor
          ? [iconColor, "icon"]
          : [hashToColor(hostname), "hash"];

  return {
    name: curated?.name ?? hostname,
    color,
    textColor: textColorFor(color),
    iconBase64: icon ? icon.bytes.toString("base64") : null,
    iconMime: icon?.mime ?? null,
    colorSource,
    fetchFailed: icon === null,
    fetchedAt: new Date(),
  };
}

// --- Reading the page's own metadata for icon candidates + theme colors ---

interface PageSignals {
  iconCandidates: string[];
  themeColor: string | null;
  manifestThemeColor: string | null;
}

function iconArea(sizesAttr: string | null | undefined): number {
  if (!sizesAttr || sizesAttr === "any") return 0;
  const match = sizesAttr.match(/(\d+)x(\d+)/i);
  return match ? Number(match[1]) * Number(match[2]) : 0;
}

// jsdom resolves the `.href` IDL property against the document's base URL
// (set when the DOM was constructed with `{ url: rawUrl }`), so this is
// already absolute - no manual URL-joining needed for in-page links.
function largestLinkHref(links: HTMLLinkElement[]): string | null {
  if (links.length === 0) return null;
  const largest = [...links].sort((a, b) => iconArea(b.getAttribute("sizes")) - iconArea(a.getAttribute("sizes")))[0];
  return largest.href || null;
}

interface ManifestIcon {
  src: string;
  sizes?: string;
}

async function readManifest(manifestUrl: string): Promise<{ themeColor: string | null; iconUrl: string | null }> {
  try {
    const res = await fetchWithTimeout(manifestUrl, { timeoutMs: ICON_FETCH_TIMEOUT_MS });
    if (!res.ok) return { themeColor: null, iconUrl: null };
    const manifest = (await res.json()) as { icons?: ManifestIcon[]; theme_color?: string };
    const icons = manifest.icons ?? [];
    const largest = icons.length ? [...icons].sort((a, b) => iconArea(b.sizes) - iconArea(a.sizes))[0] : null;
    return {
      themeColor: normalizeColor(manifest.theme_color ?? null),
      iconUrl: largest ? new URL(largest.src, manifestUrl).href : null,
    };
  } catch {
    return { themeColor: null, iconUrl: null };
  }
}

// Ordered to prefer PNG sources and reach the manifest and bare favicon.ico
// only as later resorts, since sharp can't decode .ico for the color ladder.
async function gatherPageSignals(doc: Document): Promise<PageSignals> {
  const iconCandidates: string[] = [];

  const appleTouchIcon = largestLinkHref([...doc.querySelectorAll('link[rel~="apple-touch-icon"]')] as HTMLLinkElement[]);
  if (appleTouchIcon) iconCandidates.push(appleTouchIcon);

  const pngIcons = ([...doc.querySelectorAll('link[rel~="icon"]')] as HTMLLinkElement[]).filter(
    (el) => el.getAttribute("type") === "image/png" || el.hasAttribute("sizes"),
  );
  const pngIcon = largestLinkHref(pngIcons);
  if (pngIcon) iconCandidates.push(pngIcon);

  const themeColor = normalizeColor(doc.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null);

  const manifestLink = doc.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
  let manifestThemeColor: string | null = null;
  if (manifestLink?.href) {
    const manifest = await readManifest(manifestLink.href);
    manifestThemeColor = manifest.themeColor;
    if (manifest.iconUrl) iconCandidates.push(manifest.iconUrl);
  }

  const anyIcon = largestLinkHref([...doc.querySelectorAll('link[rel~="icon"]')] as HTMLLinkElement[]);
  if (anyIcon) iconCandidates.push(anyIcon);

  return { iconCandidates, themeColor, manifestThemeColor };
}

// --- Fetching and caching the icon bytes ---

interface FetchedIcon {
  bytes: Buffer;
  mime: string;
}

function mimeFromUrl(iconUrl: string): string {
  const ext = iconUrl.split("?")[0].split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

async function downloadIcon(iconUrl: string): Promise<FetchedIcon | null> {
  try {
    const res = await fetchWithTimeout(iconUrl, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      timeoutMs: ICON_FETCH_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ICON_BYTES) return null;
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim();
    return { bytes: buffer, mime: contentType || mimeFromUrl(iconUrl) };
  } catch {
    return null;
  }
}

async function fetchIcon(hostname: string, candidates: string[]): Promise<FetchedIcon | null> {
  const attempts = [...candidates, `https://${hostname}/favicon.ico`];
  for (const candidateUrl of attempts) {
    const icon = await downloadIcon(candidateUrl);
    if (icon) return icon;
  }
  return null;
}

// --- Dominant-color sampling ---

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// Most favicons are small, mostly-transparent PNGs with one or two brand
// colors and a lot of white/gray padding. A naive average or an unweighted
// histogram both land on that padding instead of the actual mark, so this
// discards transparent/near-white/near-black pixels, buckets survivors by
// coarse color, and weights each bucket by how saturated it is - a small
// saturated logo mark outweighs a large gray or white field.
async function dominantColor(bytes: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(bytes)
      .resize(32, 32, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const buckets = new Map<string, { r: number; g: number; b: number; weight: number }>();

    for (let i = 0; i + 3 < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      if (a < 128) continue; // transparent padding
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max > 240 && min > 240) continue; // near-white
      if (max < 15) continue; // near-black

      const saturation = max === 0 ? 0 : (max - min) / max;
      const weight = 1 + saturation * 4;
      const key = `${r >> 4}-${g >> 4}-${b >> 4}`; // 4 bits/channel - merges near-identical shades
      const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, weight: 0 };
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      bucket.weight += weight;
      buckets.set(key, bucket);
    }

    if (buckets.size === 0) {
      // Everything was filtered out - a purely black/white/transparent logo
      // (X, Medium, the NYT "T"). That's real signal, not a failure: fall
      // back to which extreme the logo actually sits at.
      return monochromeFallback(data, info.channels);
    }

    const winner = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
    return rgbToHex(Math.round(winner.r / winner.weight), Math.round(winner.g / winner.weight), Math.round(winner.b / winner.weight));
  } catch {
    // sharp can't decode this format (.ico most commonly) - fall through to
    // the next rung of the color ladder rather than failing the whole card.
    return null;
  }
}

function monochromeFallback(data: Buffer, channels: number): string | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += channels) {
    if (data[i + 3] < 128) continue;
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count++;
  }
  if (count === 0) return null;
  return sum / count < 128 ? "#000000" : "#1A1A1A";
}

// --- Color helpers ---

const HEX_COLOR_REGEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// theme-color / manifest theme_color can be any CSS color syntax (named
// colors, rgb(), hsl()...). Hex covers the overwhelming majority of real
// sites; anything else just falls through to the next rung of the ladder
// rather than pulling in a full CSS color parser for the long tail.
function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_REGEX.test(trimmed)) return null;
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return trimmed.toUpperCase();
}

function textColorFor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((c) => parseInt(c, 16) / 255);
  const linearize = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

// A hostname that resolves nowhere else in the ladder still gets a stable,
// distinct color rather than gray - same input always hashes to the same hue.
function hashToColor(hostname: string): string {
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) {
    hash = (hash * 31 + hostname.charCodeAt(i)) >>> 0;
  }
  return hslToHex(hash % 360, 55, 35);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = light - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex(Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255));
}
