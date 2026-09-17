import { JSDOM } from "jsdom";
import sharp from "sharp";
import type { Sharp } from "sharp";
import decodeIco from "decode-ico";
import type { SourceProfile } from "@prisma/client";
import { prisma } from "./db.js";
import { fetchWithTimeout, BROWSER_PAGE_HEADERS, BROWSER_IMAGE_HEADERS } from "./httpFetch.js";
import { log, reportError } from "./logger.js";
import { cleanWhitespace, isPlaceUrl } from "./linkExtract.js";

// Resolves the branding (name, color, cached logo) shown on a card's header
// bar, for any hostname on the internet. A user can save a link from any
// site, so a hardcoded table alone can never be complete - this layers a
// curated list of popular sites over an automatic ladder that extracts real
// branding from the page itself, with a hash-based color as the last resort
// so even a completely unrecognized site still gets a stable, distinct look.
//
// Resolution order for color:
//   1. curated map            (x.com, youtube.com, reddit.com, ...)
//   2. <meta name="theme-color">        - unless near-white/near-black
//   3. web app manifest's theme_color   - unless near-white/near-black
//   4. dominant color sampled from the site's own favicon
//   5. a color hashed from the hostname (stable, never fails)
//
// One row per hostname, cached in SourceProfile, so each domain is resolved
// once and every item from it reuses the same row.

const ICON_FETCH_TIMEOUT_MS = 5_000;
const MAX_ICON_BYTES = 256 * 1024;
// A web app manifest is a short JSON document; anything larger is not one.
const MAX_MANIFEST_BYTES = 256 * 1024;
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
  "soundcloud.com": { name: "SoundCloud", color: "#FF5500" },
  // Reached only through canonicalSourceHostname below - a maps link is served
  // from google.com, which must not brand every other Google link as Maps.
  "maps.google.com": { name: "Google Maps", color: "#34A853" },
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

// Google Maps is served from google.com/maps, and SourceProfile is keyed by
// hostname alone - so branding a map card off its bare hostname would hand
// every Google link the same row and print "Google" on the header. A maps URL
// gets a synthetic hostname instead.
//
// Every place that keys branding calls this, not stripWww/normalizeHostname
// directly: the row the capture writes, the sweep that fills gaps, the list the
// canvas fetches and the hostname it joins on all have to agree, or the card
// looks up a profile that was stored under a different name.
const MAPS_SOURCE_HOSTNAME = "maps.google.com";

function canonicalHostnameFromUrl(url: URL): string {
  return isPlaceUrl(url.toString()) ? MAPS_SOURCE_HOSTNAME : stripWww(url.hostname);
}

export function canonicalSourceHostname(rawUrl: string): string | null {
  try {
    return canonicalHostnameFromUrl(new URL(rawUrl));
  } catch {
    return null;
  }
}

function isFresh(profile: SourceProfile): boolean {
  const age = Date.now() - profile.fetchedAt.getTime();
  return age < (profile.fetchFailed ? FAILED_RETRY_MS : PROFILE_TTL_MS);
}

export async function resolveSourceProfile(url: URL, dom: JSDOM | null): Promise<SourceProfile> {
  const hostname = canonicalHostnameFromUrl(url);

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
    const res = await fetchWithTimeout(rawUrl, { headers: BROWSER_PAGE_HEADERS });
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

  const hostname = canonicalHostnameFromUrl(url);
  const cached = await prisma.sourceProfile.findUnique({ where: { hostname } });
  if (cached && isFresh(cached)) return cached;

  const dom = isTwitterHost(hostname) ? null : await fetchPageDom(rawUrl);
  return resolveSourceProfile(url, dom);
}

// Fills in every hostname that has no usable profile yet. Shared by the CLI
// backfill and the server's startup sweep so both close gaps identically -
// items saved before this feature existed, and any capture whose resolution
// failed at the time. Serial on purpose: it's a handful of hostnames, and
// there's no reason to hit several sites at once on boot.
export async function resolveMissingSourceProfiles(): Promise<number> {
  const items = await prisma.item.findMany({
    where: { rawUrl: { not: null } },
    select: { rawUrl: true },
  });

  // Keyed by *normalized* hostname, matching how profiles are stored - so
  // "www.x.com" and "x.com" resolve once between them, not twice.
  const urlByHostname = new Map<string, string>();
  for (const { rawUrl } of items) {
    if (!rawUrl) continue;
    const hostname = canonicalSourceHostname(rawUrl);
    if (hostname && !urlByHostname.has(hostname)) urlByHostname.set(hostname, rawUrl);
  }

  let resolved = 0;
  for (const [hostname, rawUrl] of urlByHostname) {
    const cached = await prisma.sourceProfile.findUnique({ where: { hostname } });
    if (cached && isFresh(cached)) continue;

    try {
      const profile = await resolveSourceProfileForCapture(rawUrl);
      if (profile) {
        resolved++;
        log.debug(
          {
            hostname: profile.hostname,
            name: profile.name,
            color: profile.color,
            via: profile.colorSource,
          },
          "Resolved source profile",
        );
      }
    } catch (error) {
      // One dead host must not stop the sweep for the rest.
      reportError(error, { scope: "sourceProfile.sweep", hostname });
    }
  }
  return resolved;
}

type BuiltProfile = Omit<SourceProfile, "hostname">;

async function buildSourceProfile(hostname: string, dom: JSDOM | null): Promise<BuiltProfile> {
  const curated = curatedFor(hostname);
  const signals = dom ? await gatherPageSignals(dom.window.document) : NO_SIGNALS;

  const icon = await fetchIcon(hostname, signals.iconCandidates);
  const pixels = icon ? await iconPixels(icon.bytes) : null;
  const iconColor = pixels ? dominantColor(pixels) : null;

  const themeColor = brandColor(signals.themeColor);
  const manifestColor = brandColor(signals.manifestThemeColor);

  const [color, colorSource]: [string, string] = curated
    ? [curated.color, "curated"]
    : themeColor
      ? [themeColor, "theme-color"]
      : manifestColor
        ? [manifestColor, "manifest"]
        : iconColor
          ? [iconColor, "icon"]
          : [hashToColor(hostname), "hash"];

  // Only moves the color when the logo would otherwise be invisible on it.
  const barColor = pixels ? shiftBarAwayFromLogo(color, pixels) : color;

  return {
    // og:site_name reads far better in the header bar than a bare hostname
    // ("AP News", not "apnews.com") for everything the curated map misses.
    name: curated?.name ?? signals.ogSiteName ?? hostname,
    color: barColor,
    textColor: textColorFor(barColor),
    iconBase64: icon ? icon.bytes.toString("base64") : null,
    iconMime: icon?.mime ?? null,
    colorSource,
    // A hash color means the ladder found nothing real, which is just as
    // much a failure as a missing icon - mark it so the 24h retry window
    // applies instead of freezing the guess in place for a month.
    fetchFailed: icon === null || colorSource === "hash",
    fetchedAt: new Date(),
  };
}

// theme-color and a manifest's theme_color describe *browser chrome*, not a
// brand: sites set them to their page background, which is usually white -
// are.na sends "#FFF", Instagram "#ffffff". Taken at face value that paints a
// white bar on an already-white card, so a near-neutral value is skipped in
// favour of the color sampled from the logo. Only these two rungs are
// filtered: a curated "#000000" and a monochrome logo sample are deliberate.
function isNearNeutral(hexColor: string): boolean {
  const hex = hexColor.replace("#", "");
  const [r, g, b] = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)].map((c) => parseInt(c, 16));
  return (r > 235 && g > 235 && b > 235) || (r < 20 && g < 20 && b < 20);
}

function brandColor(value: string | null): string | null {
  return value && !isNearNeutral(value) ? value : null;
}

// --- Reading the page's own metadata for icon candidates + theme colors ---

interface PageSignals {
  iconCandidates: string[];
  themeColor: string | null;
  manifestThemeColor: string | null;
  ogSiteName: string | null;
}

const NO_SIGNALS: PageSignals = {
  iconCandidates: [],
  themeColor: null,
  manifestThemeColor: null,
  ogSiteName: null,
};

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
    const res = await fetchWithTimeout(manifestUrl, {
      timeoutMs: ICON_FETCH_TIMEOUT_MS,
      maxBytes: MAX_MANIFEST_BYTES,
    });
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

  // A page often ships several theme-colors scoped by media query. Taking
  // the first match blindly picks the dark-mode value on any site that lists
  // it first, so prefer the unscoped tag - that's the light-mode default.
  const themeColorMeta =
    doc.querySelector('meta[name="theme-color"]:not([media])') ??
    doc.querySelector('meta[name="theme-color"]');
  const themeColor = normalizeColor(themeColorMeta?.getAttribute("content") ?? null);

  const manifestLink = doc.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
  let manifestThemeColor: string | null = null;
  if (manifestLink?.href) {
    const manifest = await readManifest(manifestLink.href);
    manifestThemeColor = manifest.themeColor;
    if (manifest.iconUrl) iconCandidates.push(manifest.iconUrl);
  }

  const anyIcon = largestLinkHref([...doc.querySelectorAll('link[rel~="icon"]')] as HTMLLinkElement[]);
  if (anyIcon) iconCandidates.push(anyIcon);

  const ogSiteName = cleanWhitespace(doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content"));

  return { iconCandidates, themeColor, manifestThemeColor, ogSiteName };
}

// --- Fetching and caching the icon bytes ---

interface FetchedIcon {
  bytes: Buffer;
  mime: string;
}

const ICO_MAGIC = "00000100";

// A favicon URL's extension lies and its Content-Type is often missing or a
// generic octet-stream, so identify the bytes themselves. Without this a soft
// 404 gets stored as a logo and served back as a broken image - linkedin.com's
// /favicon.ico really does return 20KB of HTML, comfortably under the size cap.
function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  const magic = bytes.subarray(0, 4).toString("hex");
  if (magic === "89504e47") return "image/png";
  if (magic.startsWith("ffd8ff")) return "image/jpeg";
  if (magic === ICO_MAGIC) return "image/x-icon";
  if (bytes.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  // SVG is text, so it has no magic number - require an actual <svg tag
  // rather than trusting a leading "<", which every HTML error page has too.
  const head = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

async function downloadIcon(iconUrl: string): Promise<FetchedIcon | null> {
  try {
    const res = await fetchWithTimeout(iconUrl, {
      headers: BROWSER_IMAGE_HEADERS,
      timeoutMs: ICON_FETCH_TIMEOUT_MS,
      // Enforced during the read, so an oversized icon is abandoned mid-stream.
      // The check below used to be the only one, and it ran on a buffer that was
      // already fully in memory - which is the part that costs.
      maxBytes: MAX_ICON_BYTES,
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) return null;

    // Sniffed type wins over the declared one: it is both more reliable and
    // more accurate for the browser we later serve these bytes to. The
    // declared type is still honoured for formats we don't sniff (avif, bmp).
    const sniffed = sniffImageMime(buffer);
    if (sniffed) return { bytes: buffer, mime: sniffed };

    const declared = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (declared?.startsWith("image/")) return { bytes: buffer, mime: declared };

    return null; // not an image - don't cache HTML as a logo
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

// sharp has no .ico decoder, and a meaningful minority of sites still ship
// only one (bloomberg.com, craigslist.org). decode-ico turns the container
// into either an embedded PNG file or raw RGBA, both of which sharp accepts,
// so those sites get their real color instead of falling through to a hash.
function decodeIconToSharp(bytes: Buffer): Sharp {
  if (bytes.subarray(0, 4).toString("hex") !== ICO_MAGIC) return sharp(bytes);

  const frames = decodeIco(bytes);
  if (frames.length === 0) throw new Error("ico contained no frames");
  const largest = [...frames].sort((a, b) => b.width * b.height - a.width * a.height)[0];

  // A png frame's `data` is the encoded file; a bmp frame's is raw RGBA.
  return largest.type === "png"
    ? sharp(Buffer.from(largest.data))
    : sharp(Buffer.from(largest.data), {
        raw: { width: largest.width, height: largest.height, channels: 4 },
      });
}

// Most favicons are small, mostly-transparent PNGs with one or two brand
// colors and a lot of white/gray padding. A naive average or an unweighted
// histogram both land on that padding instead of the actual mark, so this
// discards transparent/near-white/near-black pixels, buckets survivors by
// coarse color, and weights each bucket by how saturated it is - a small
// saturated logo mark outweighs a large gray or white field.
interface IconPixels {
  data: Buffer;
  channels: number;
}

// Decoded once per profile: the color sampling below and the logo-visibility
// check both read these pixels, and decoding twice would be pure waste.
async function iconPixels(bytes: Buffer): Promise<IconPixels | null> {
  try {
    const { data, info } = await decodeIconToSharp(bytes)
      .resize(32, 32, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, channels: info.channels };
  } catch {
    // Undecodable or malformed image bytes - callers fall through to the next
    // rung of the color ladder rather than failing the whole card.
    return null;
  }
}

function dominantColor(px: IconPixels): string | null {
  {
    const { data } = px;
    const buckets = new Map<string, { r: number; g: number; b: number; weight: number }>();

    for (let i = 0; i + 3 < data.length; i += px.channels) {
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
      return monochromeFallback(px);
    }

    const winner = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
    return rgbToHex(Math.round(winner.r / winner.weight), Math.round(winner.g / winner.weight), Math.round(winner.b / winner.weight));
  }
}

function monochromeFallback(px: IconPixels): string | null {
  const { data, channels } = px;
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

function hexToRgb(hexColor: string): [number, number, number] {
  const hex = hexColor.replace("#", "");
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

// WCAG contrast between two relative luminances.
function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function textColorFor(hexColor: string): string {
  return relativeLuminance(...hexToRgb(hexColor)) > 0.5 ? "#000000" : "#ffffff";
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness * 100];

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue =
    max === rn ? (gn - bn) / delta + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / delta + 2 : (rn - gn) / delta + 4;
  return [hue * 60, saturation * 100, lightness * 100];
}

// --- Keeping the logo legible against its own bar ---

// A logo reads if some meaningful share of its pixels stand out from the bar.
// Averaging the whole logo would hide the common case of a bright mark sitting
// on a dark field - X's icon averages near-black yet its white mark is plainly
// visible on a black bar.
const LOGO_CONTRAST_MIN_RATIO = 2.5;
const LOGO_VISIBLE_MIN_SHARE = 0.15;

function logoVisibility(px: IconPixels, barHex: string): number {
  const barLuminance = relativeLuminance(...hexToRgb(barHex));
  let opaque = 0;
  let distinct = 0;

  for (let i = 0; i + 3 < px.data.length; i += px.channels) {
    if (px.data[i + 3] < 128) continue;
    opaque++;
    const luminance = relativeLuminance(px.data[i], px.data[i + 1], px.data[i + 2]);
    if (contrastRatio(luminance, barLuminance) >= LOGO_CONTRAST_MIN_RATIO) distinct++;
  }

  return opaque === 0 ? 1 : distinct / opaque;
}

// When the bar color was sampled from the logo, the two are the same color by
// construction and the mark disappears into the header (pinterest.com is the
// clean example - a red "P" on a red bar). Nudge the bar's lightness away from
// the logo until the mark reads again, trying both directions and keeping
// whichever needed the smaller move, so the brand hue survives.
function shiftBarAwayFromLogo(barHex: string, px: IconPixels): string {
  if (logoVisibility(px, barHex) >= LOGO_VISIBLE_MIN_SHARE) return barHex;

  const [hue, saturation, lightness] = rgbToHsl(...hexToRgb(barHex));
  for (let delta = 4; delta <= 56; delta += 4) {
    // Darker first, so a tie goes to the deeper shade - a darkened brand color
    // reads as itself far longer than a lightened one washes out to pastel.
    for (const candidateLightness of [lightness - delta, lightness + delta]) {
      if (candidateLightness < 8 || candidateLightness > 92) continue;
      const candidate = hslToHex(hue, saturation, candidateLightness);
      if (logoVisibility(px, candidate) >= LOGO_VISIBLE_MIN_SHARE) return candidate;
    }
  }

  return barHex; // nothing helped - keep the brand color over a washed-out one
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
