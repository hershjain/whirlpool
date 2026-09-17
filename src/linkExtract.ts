import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { fetchWithTimeout, BROWSER_PAGE_HEADERS, CRAWLER_PAGE_HEADERS, OSM_HEADERS } from "./httpFetch.js";
import { assertSafeUrl } from "./safeFetch.js";

// An oEmbed response is a short JSON document - a title, a byline, a thumbnail
// URL. The 2MB page default is the wrong shape for these.
const MAX_OEMBED_BYTES = 256 * 1024;

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
  // Status of the fetch that produced this result, whichever path ran. Null
  // when no request was made (a malformed URL) or it threw before responding.
  httpStatus: number | null;
}

const EMPTY_RESULT: ExtractResult = {
  title: null,
  extractedText: null,
  contentFidelity: "failed",
  author: null,
  siteName: null,
  imageUrl: null,
  httpStatus: null,
};

const MIN_FULL_TEXT_LENGTH = 200;

function isTwitterUrl(url: URL): boolean {
  return ["twitter.com", "x.com", "www.twitter.com", "www.x.com"].includes(url.hostname);
}

function isTikTokUrl(url: URL): boolean {
  return url.hostname === "tiktok.com" || url.hostname.endsWith(".tiktok.com");
}

function isInstagramUrl(url: URL): boolean {
  return url.hostname === "instagram.com" || url.hostname.endsWith(".instagram.com");
}

function isRedditUrl(url: URL): boolean {
  return url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com");
}

function isSpotifyUrl(url: URL): boolean {
  return url.hostname === "open.spotify.com";
}

// Every streaming service renders its player client-side, so what these have
// in common isn't a shape we can parse - it's that a music link is a song, and
// a song is a name and an artist rather than something to summarize or tag.
// Matched on hostname, which also lets the reader and the capture path ask the
// same question of a row that was saved long before this existed.
const MUSIC_HOSTNAMES = [
  "open.spotify.com",
  "music.apple.com",
  "music.youtube.com",
  "soundcloud.com",
  "bandcamp.com",
  "tidal.com",
  "listen.tidal.com",
  "music.amazon.com",
  "deezer.com",
];

export function isMusicUrl(rawUrl: string): boolean {
  try {
    const { hostname } = new URL(rawUrl);
    return MUSIC_HOSTNAMES.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function bareHostname(url: URL): string {
  const lower = url.hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

// --- YouTube ---------------------------------------------------------------

// music.youtube.com is deliberately excluded: it is in MUSIC_HOSTNAMES, and a
// song there is a song rather than a video. extractFromUrl checks music first
// for the same reason, but the card's `isVideo` is derived from this predicate
// on its own, so the exclusion has to live here too.
const YOUTUBE_HOSTNAMES = ["youtube.com", "youtu.be", "youtube-nocookie.com"];

// Eleven characters of the URL-safe alphabet - every YouTube id, and a cheap
// way to reject a path segment that merely sits where an id would.
const YOUTUBE_ID = /^[\w-]{11}$/;

function isYouTubeUrl(url: URL): boolean {
  const host = bareHostname(url);
  if (host === "music.youtube.com") return false;
  return YOUTUBE_HOSTNAMES.some((known) => host === known || host.endsWith(`.${known}`));
}

// The id sits somewhere different in each of YouTube's URL shapes:
//   youtube.com/watch?v=<id>   youtu.be/<id>        youtube.com/shorts/<id>
//   youtube.com/embed/<id>     youtube.com/live/<id>
export function youTubeVideoId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!isYouTubeUrl(url)) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const candidate =
    bareHostname(url) === "youtu.be"
      ? segments[0]
      : segments[0] === "watch"
        ? url.searchParams.get("v")
        : ["shorts", "embed", "live", "v"].includes(segments[0] ?? "")
          ? segments[1]
          : null;

  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

// mqdefault is the only thumbnail size that is both guaranteed to exist for
// every video and genuinely 16:9. hqdefault - which is what oEmbed hands back -
// is a 4:3 frame with black bars baked into the top and bottom, and those bars
// would survive into the card's hero band.
export function youTubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

// --- SoundCloud ------------------------------------------------------------

function isSoundCloudUrl(url: URL): boolean {
  const host = bareHostname(url);
  return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
}

// --- Google Maps -----------------------------------------------------------

// The pin's real coordinates, buried in the opaque `data=` blob: !3d is the
// latitude and !4d the longitude of the *place*. That is not the same point as
// the viewport centre in `@lat,lng,zoom`, which moves whenever the map was
// panned or zoomed before the link was shared.
const MAPS_PLACE_PIN = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/;
const MAPS_VIEWPORT = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;
const LAT_LNG_PAIR = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Zoom 15 is close enough to read the surrounding streets but wide enough that
// a slightly-off pin still lands in frame.
export const MAP_DEFAULT_ZOOM = 15;

export interface MapCoords {
  lat: number;
  lng: number;
}

export function isMapsShortLink(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = bareHostname(url);
    return host === "maps.app.goo.gl" || (host === "goo.gl" && url.pathname.startsWith("/maps"));
  } catch {
    return false;
  }
}

export function isPlaceUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const host = bareHostname(url);
    if (host === "maps.app.goo.gl") return true;
    if (host.startsWith("maps.google.")) return true;
    // google.com/maps/..., plus the country domains (google.co.uk, google.de).
    if (host === "goo.gl" || /^google\.[a-z]{2,}(\.[a-z]{2,})?$/.test(host)) {
      return url.pathname.startsWith("/maps");
    }
    return false;
  } catch {
    return false;
  }
}

function coordsIfValid(lat: number, lng: number): MapCoords | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Coordinates only, in descending order of trustworthiness. Returns null rather
// than guessing: a /maps/search/ link names a place without pinning it, and the
// caller still wants the name even when there is nothing to draw a map from.
export function parseGoogleMapsUrl(rawUrl: string): MapCoords | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const pin = url.href.match(MAPS_PLACE_PIN);
  if (pin) {
    const coords = coordsIfValid(Number(pin[1]), Number(pin[2]));
    if (coords) return coords;
  }

  const viewport = url.pathname.match(MAPS_VIEWPORT);
  if (viewport) {
    const coords = coordsIfValid(Number(viewport[1]), Number(viewport[2]));
    if (coords) return coords;
  }

  for (const key of ["q", "query", "ll", "center", "daddr", "destination"]) {
    const pair = url.searchParams.get(key)?.match(LAT_LNG_PAIR);
    if (!pair) continue;
    const coords = coordsIfValid(Number(pair[1]), Number(pair[2]));
    if (coords) return coords;
  }

  return null;
}

function decodePlaceSegment(segment: string): string | null {
  const spaced = segment.replace(/\+/g, " ");
  try {
    return cleanWhitespace(decodeURIComponent(spaced));
  } catch {
    // A stray "%" that isn't an escape sequence - keep the readable form rather
    // than throwing the name away entirely.
    return cleanWhitespace(spaced);
  }
}

export function googleMapsPlaceName(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const placeIndex = segments.indexOf("place");
    const named = placeIndex === -1 ? null : segments[placeIndex + 1];
    // "/maps/place/@37.77,-122.41,17z" pins a spot with no name attached to it.
    if (named && !named.startsWith("@")) return decodePlaceSegment(named);

    const query = url.searchParams.get("query") ?? url.searchParams.get("q");
    if (query && !LAT_LNG_PAIR.test(query)) return decodePlaceSegment(query);
    return null;
  } catch {
    return null;
  }
}

export function formatCoords({ lat, lng }: MapCoords): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// Served by GET /api/map, which composites the tiles behind our own origin - so
// this is same-origin, needs no CSP change, and carries no API key.
export function mapThumbnailUrl({ lat, lng }: MapCoords, zoom: number = MAP_DEFAULT_ZOOM): string {
  return `/api/map?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&z=${zoom}`;
}

// Instagram writes the caption into og:title behind the account name -
//   Kokka Fabrics for Creators on Instagram: "Pathway by Bookhou..."
// - and again into og:description behind a likes/comments/date preamble. Left
// alone, the card prints the same caption twice: once as its title and once as
// its body. Splitting og:title gives the account and the caption separately,
// which is also more reliable than the page text: on a reel, Readability
// picks up a *comment* rather than the caption.
const INSTAGRAM_TITLE = /^(.+?) on Instagram:\s*["\u201c]([\s\S]*?)["\u201d]?\s*$/;

function applyInstagramShape(result: ExtractResult): ExtractResult {
  const match = result.title?.match(INSTAGRAM_TITLE);
  if (!match) return result;

  const account = cleanWhitespace(match[1]);
  const caption = cleanWhitespace(match[2]);
  if (!account) return result;

  return {
    ...result,
    title: account,
    author: result.author ?? account,
    siteName: result.siteName ?? "Instagram",
    extractedText: caption ?? result.extractedText,
    // The caption is the whole of the post's text - never a full article.
    contentFidelity: caption ? "metadata_only" : result.contentFidelity,
  };
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

// oEmbed's html is a blockquote built for embedding on a web page, so the
// text it yields carries furniture a card doesn't want: a trailing
// "- Author (@handle) Date" byline (we store the author separately) and bare
// t.co / pic.twitter.com links that render as noise. Strip both so the card
// shows what the tweet actually says.
function cleanTweetText(raw: string): string | null {
  const withoutByline = raw.replace(/\s*[-\u2014\u2013]\s*[^\n]*\(@[A-Za-z0-9_]+\)\s+\w+ \d{1,2}, \d{4}\s*$/, "");
  const withoutLinks = withoutByline.replace(/https?:\/\/t\.co\/\S+/g, "").replace(/pic\.twitter\.com\/\S+/g, "");
  return cleanWhitespace(withoutLinks);
}

async function extractViaTwitterOEmbed(url: string): Promise<ExtractResult> {
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(oembedUrl, { maxBytes: MAX_OEMBED_BYTES });
    // oEmbed 404s for a tweet that has been deleted or made private - that is
    // the only signal we get that a saved tweet is gone.
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };
    const data = (await res.json()) as { html?: string; author_name?: string; author_url?: string };
    if (!data.html) return EMPTY_RESULT;
    const rawText = new JSDOM(data.html).window.document.body.textContent?.trim() ?? "";
    const text = cleanTweetText(rawText);
    if (!text) return EMPTY_RESULT;
    return {
      title: data.author_name ?? null,
      extractedText: text,
      contentFidelity: "metadata_only",
      author: handleFromAuthorUrl(data.author_url),
      siteName: "X",
      imageUrl: null, // oEmbed returns no image for a tweet
      httpStatus: res.status,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// TikTok's page HTML is rendered client-side and carries no Open Graph tags
// at all, so the usual ladder finds nothing. Its oEmbed endpoint is public and
// unauthenticated, and returns the one thing a card needs for a video: a
// thumbnail, plus the caption and the creator's name.
async function extractViaTikTokOEmbed(url: string): Promise<ExtractResult> {
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(oembedUrl, { maxBytes: MAX_OEMBED_BYTES });
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };
    const data = (await res.json()) as {
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
    };

    const caption = cleanWhitespace(data.title);
    const thumbnail = data.thumbnail_url ?? null;
    if (!caption && !thumbnail) return EMPTY_RESULT;

    return {
      title: caption,
      // The caption is the whole of a TikTok's text - showing it verbatim
      // beats summarizing a string of hashtags.
      extractedText: caption,
      contentFidelity: "metadata_only",
      author: cleanWhitespace(data.author_name),
      siteName: "TikTok",
      imageUrl: thumbnail,
      httpStatus: res.status,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// Reddit hands crawlers one of two pages. The richer one has an og:title of
// "From the <sub> community on Reddit: <real title>"; the stripped-down
// "minimal" one has no og: tags at all but a <title> of "<real title> : r/<sub>".
// Either way the furniture around the real title is preview-card chrome, not
// part of it - strip whichever wrapper is present (cf. applyInstagramShape).
const REDDIT_OG_TITLE_PREFIX = /^From the .+? community on Reddit:\s*/i;
const REDDIT_DOC_TITLE_SUFFIX = /\s*:\s*r\/[A-Za-z0-9_]+\s*$/i;

// author_url on the oEmbed payload is "https://www.reddit.com/user/<name>/" -
// turn it into the "u/<name>" a Reddit reader expects to see as a byline.
function redditUserFromAuthorUrl(authorUrl: string | undefined): string | null {
  if (!authorUrl) return null;
  try {
    const name = new URL(authorUrl).pathname.split("/").filter(Boolean).at(-1);
    return name ? `u/${name}` : null;
  } catch {
    return null;
  }
}

// "/r/<sub>/comments/..." -> "r/<sub>". The byline fallback when oEmbed won't
// give up the poster (deleted account, restricted post) - "r/MMALabs" still
// says more about where a link is from than a bare "Reddit".
function redditSubFromUrl(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[0] === "r" && parts[1] ? `r/${parts[1]}` : null;
  } catch {
    return null;
  }
}

// reddit.com serves a bare JavaScript app shell to a browser UA - 200, 8KB, not
// one og: tag - so the usual ladder stores "Reddit" as the title and nothing
// else. The pre-rendered copy it builds for social crawlers has the full set,
// including a hotlinkable share.redd.it hero. The poster's handle isn't in those
// tags, so a second call to the public oEmbed endpoint fills in the byline.
async function extractViaRedditOG(rawUrl: string): Promise<ExtractResult> {
  try {
    const res = await fetchWithTimeout(rawUrl, { headers: CRAWLER_PAGE_HEADERS });
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };
    const html = await res.text();
    const doc = new JSDOM(html, { url: res.url }).window.document;

    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
    const docTitle = doc.querySelector("title")?.textContent;
    const title = ogTitle
      ? cleanWhitespace(ogTitle.replace(REDDIT_OG_TITLE_PREFIX, ""))
      : cleanWhitespace(docTitle?.replace(REDDIT_DOC_TITLE_SUFFIX, ""));
    // og:description is boilerplate ("Explore this post and more from the
    // <sub> community"), and the minimal page's meta description is just vote
    // counts and the subreddit blurb - neither is the post, so the card gets a
    // title and (when present) an image only, never body text.
    const { imageUrl } = extractHeadMetadata(doc, res.url, null);
    if (!title && !imageUrl) return { ...EMPTY_RESULT, httpStatus: res.status };

    return {
      title,
      extractedText: null,
      contentFidelity: "metadata_only",
      author: (await fetchRedditByline(res.url)) ?? redditSubFromUrl(res.url),
      siteName: "Reddit",
      imageUrl,
      httpStatus: res.status,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// Best-effort: a missing byline must never sink the whole extraction, and the
// oEmbed endpoint 400s on a /r/<sub>/s/<id> share link, so it's given the
// redirect-resolved canonical URL rather than whatever the user pasted.
async function fetchRedditByline(canonicalUrl: string): Promise<string | null> {
  try {
    const oembedUrl = `https://www.reddit.com/oembed?url=${encodeURIComponent(canonicalUrl)}`;
    const res = await fetchWithTimeout(oembedUrl, {
      headers: CRAWLER_PAGE_HEADERS,
      maxBytes: MAX_OEMBED_BYTES,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { author_name?: string; author_url?: string };
    return redditUserFromAuthorUrl(data.author_url) ?? (data.author_name ? `u/${data.author_name}` : null);
  } catch {
    return null;
  }
}

// open.spotify.com is another client-rendered shell. Its oEmbed endpoint is
// public and returns the track/album/playlist name plus a hotlinkable cover -
// no artist field, so the card carries the title alone.
async function extractViaSpotifyOEmbed(url: string): Promise<ExtractResult> {
  try {
    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetchWithTimeout(oembedUrl, { maxBytes: MAX_OEMBED_BYTES });
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };
    const data = (await res.json()) as { title?: string; thumbnail_url?: string };

    const title = cleanWhitespace(data.title);
    const thumbnail = data.thumbnail_url ?? null;
    if (!title && !thumbnail) return { ...EMPTY_RESULT, httpStatus: res.status };

    return {
      title,
      extractedText: null,
      contentFidelity: "metadata_only",
      author: null,
      siteName: "Spotify",
      imageUrl: thumbnail,
      httpStatus: res.status,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// YouTube's watch page does carry og: tags, but the generic Readability path
// also scoops up the video description - which on most channels is a sponsor
// blurb, a row of socials and a wall of affiliate links - and prints it as the
// card's body. The oEmbed endpoint is public and keyless, and returns exactly
// the three things a video card wants: the title, the channel and a thumbnail.
async function extractViaYouTubeOEmbed(rawUrl: string): Promise<ExtractResult> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
    const res = await fetchWithTimeout(oembedUrl, { maxBytes: MAX_OEMBED_BYTES });
    // 401/404 here is how YouTube reports a video that is private, deleted or
    // age-gated - the same signal the Twitter branch reads off a dead tweet.
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };

    const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    const title = cleanWhitespace(data.title ?? null);
    if (!title) return { ...EMPTY_RESULT, httpStatus: res.status };

    const videoId = youTubeVideoId(rawUrl);
    return {
      title,
      // Null on purpose: a video has no article text, and the description is
      // exactly what made these cards unreadable before.
      extractedText: null,
      contentFidelity: "metadata_only",
      author: cleanWhitespace(data.author_name ?? null),
      siteName: "YouTube",
      imageUrl: videoId ? youTubeThumbnail(videoId) : (data.thumbnail_url ?? null),
      httpStatus: res.status,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// SoundCloud's oEmbed title is "Track name by Artist" while author_name carries
// the artist on its own, so the suffix is pure duplication - the card already
// prints the artist on its own line directly under the name.
function stripTrailingBy(title: string | null, artist: string | null): string | null {
  if (!title || !artist) return title;
  const suffix = ` by ${artist}`;
  if (!title.toLowerCase().endsWith(suffix.toLowerCase())) return title;
  return cleanWhitespace(title.slice(0, -suffix.length)) ?? title;
}

// SoundCloud reaches extractMusicMetadata like every other streaming service,
// and everything there works except the one field a music card exists to show:
// artistFromDescription explicitly refuses SoundCloud's og:description because
// they write prose in it, so the artist came back null every single time. The
// oEmbed endpoint is public, keyless, and hands over the artist directly.
async function extractViaSoundCloudOEmbed(rawUrl: string): Promise<ExtractResult> {
  try {
    const oembedUrl = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(rawUrl)}`;
    const res = await fetchWithTimeout(oembedUrl, { maxBytes: MAX_OEMBED_BYTES });
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };

    const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    const artist = cleanWhitespace(data.author_name ?? null);
    const title = stripTrailingBy(cleanWhitespace(data.title ?? null), artist);
    if (!title) return { ...EMPTY_RESULT, httpStatus: res.status };

    return {
      title,
      extractedText: null,
      contentFidelity: "metadata_only",
      author: artist,
      siteName: "SoundCloud",
      imageUrl: data.thumbnail_url ?? null,
      httpStatus: res.status,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// A maps.app.goo.gl link carries nothing at all - no coordinates, no place
// name, not even a country. Following the redirect is the only way to reach the
// real URL, and safeFetch re-validates every hop on the way.
async function resolveMapsShortLink(rawUrl: string): Promise<{ url: string; httpStatus: number | null }> {
  try {
    const res = await fetchWithTimeout(rawUrl, { headers: CRAWLER_PAGE_HEADERS });
    return { url: res.url, httpStatus: res.status };
  } catch {
    return { url: rawUrl, httpStatus: null };
  }
}

// Google serves a crawler nothing about the place itself: og:title comes back
// as the literal string "Google Maps" and og:description as the same "Find
// local businesses..." blurb every maps URL gets, at the cost of a 216KB page
// and a JSDOM parse. (Their og:image is a Static Maps URL carrying Google's own
// API key, which is not ours to spend.) So the address comes from OSM's
// reverse geocoder instead - keyless, a small JSON document, and it answers
// with the actual street the pin is on.
interface NominatimAddress {
  house_number?: string;
  road?: string;
  city?: string;
  town?: string;
  village?: string;
  suburb?: string;
  state?: string;
  country?: string;
}

// display_name is the full postal chain - "Tartine Bakery, 600, Guerrero
// Street, Mission District, San Francisco, California, 94110, United States" -
// which is far too long for a line under a card's title. Three parts is the
// most a 240px card can show and the most a person needs to place somewhere.
function shortAddress(address: NominatimAddress | undefined): string | null {
  if (!address) return null;
  // OSM writes a building spanning several numbers as "610;612"; an en dash
  // is how a person would read that back.
  const number = address.house_number?.replace(/\s*;\s*/g, "\u2013");
  const street = [number, address.road].filter(Boolean).join(" ");
  const locality = address.city ?? address.town ?? address.village ?? address.suburb;
  const region = address.state ?? address.country;
  return cleanWhitespace([street, locality, region].filter(Boolean).join(", "));
}

// Nominatim asks for no more than one request a second. Capture runs one link
// at a time in a background job, so this is comfortably inside that - but it is
// the reason this is never called anywhere that loops.
async function reverseGeocode(
  coords: MapCoords,
): Promise<{ name: string | null; address: string | null }> {
  try {
    const query = `format=jsonv2&lat=${coords.lat}&lon=${coords.lng}&zoom=18&addressdetails=1`;
    const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?${query}`, {
      headers: OSM_HEADERS,
      maxBytes: MAX_OEMBED_BYTES,
    });
    if (!res.ok) return { name: null, address: null };

    const data = (await res.json()) as { name?: string; address?: NominatimAddress };
    return { name: cleanWhitespace(data.name ?? null), address: shortAddress(data.address) };
  } catch {
    return { name: null, address: null };
  }
}

// A place is a name and where it is. There is no article to summarize here, so
// this never returns body text beyond the address - the same reasoning that
// keeps a song down to its name and its artist.
async function extractPlace(rawUrl: string): Promise<ExtractResult> {
  try {
    const short = isMapsShortLink(rawUrl) ? await resolveMapsShortLink(rawUrl) : null;
    const resolved = short?.url ?? rawUrl;
    const httpStatus = short?.httpStatus ?? null;

    const coords = parseGoogleMapsUrl(resolved);
    const nameFromUrl = googleMapsPlaceName(resolved);

    // Only worth a request when there is a pin to look it up by. The name in
    // the URL, when there is one, still doesn't carry the street.
    const geo = coords ? await reverseGeocode(coords) : null;

    const name = nameFromUrl ?? geo?.name ?? null;
    const address = geo?.address ?? null;
    if (!name && !address && !coords) return { ...EMPTY_RESULT, httpStatus };

    // Most place-like thing first. A dropped pin often has no name at all, and
    // its street reads far better as the card's title than a pair of decimals.
    const where = coords ? formatCoords(coords) : null;
    const title = name ?? address ?? where;
    return {
      title,
      // Never repeat the title underneath itself: when the address had to serve
      // as the name, the coordinates go below it instead.
      extractedText: title === address ? where : (address ?? where),
      contentFidelity: "metadata_only",
      author: null,
      siteName: "Google Maps",
      imageUrl: coords ? mapThumbnailUrl(coords) : null,
      httpStatus,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// Which segment of a music page's preview text is the artist, per service.
// Verified against each one's live crawler response:
//   Spotify       og:description "Drake \u00b7 For All The Dogs \u00b7 Song \u00b7 2023"
//   Apple Music   og:title       "CHIHIRO by Billie Eilish on Apple Music"
//   YouTube Music og:description "Rick Astley"
const APPLE_MUSIC_TITLE = /^(.*) by (.*) on Apple Music$/;

// Spotify puts the release type where an artist would be on anything that
// isn't credited to one - a playlist reads "Playlist \u00b7 120 songs". Printing
// "Playlist" under the name as though it were the artist is worse than
// printing nothing.
const NOT_AN_ARTIST = new Set(["song", "album", "playlist", "podcast", "episode", "artist", "single"]);

function artistFromDescription(description: string | null): string | null {
  const first = cleanWhitespace(description?.split("\u00b7")[0] ?? null);
  if (!first || NOT_AN_ARTIST.has(first.toLowerCase())) return null;
  // A description that runs on, or ends in a full stop, is a blurb rather than
  // a name - SoundCloud and Bandcamp write prose there.
  if (first.length > 80 || first.endsWith(".")) return null;
  return first;
}

function splitMusicMetadata(
  hostname: string,
  ogTitle: string | null,
  ogDescription: string | null,
): { title: string | null; artist: string | null } {
  // Cleaned before matching, not after: Apple wraps og:title across lines, and
  // a "." in the pattern won't cross a newline, so the raw string never
  // matched even though it reads as one line.
  const cleanTitle = cleanWhitespace(ogTitle);

  if (hostname === "music.apple.com") {
    const match = cleanTitle?.match(APPLE_MUSIC_TITLE);
    // Apple's description is "Song \u00b7 2024 \u00b7 Duration 5:03" - no artist in it at
    // all - so a title that doesn't match leaves the artist blank rather than
    // falling through to a segment that would read "Song".
    return match
      ? { title: cleanWhitespace(match[1]), artist: cleanWhitespace(match[2]) }
      : { title: cleanTitle, artist: null };
  }
  return { title: cleanTitle, artist: artistFromDescription(ogDescription) };
}

// A music link is a song: a name and whoever made it. This reads both off the
// preview the service builds for crawlers - the same Twitterbot trick the
// Reddit branch uses, since every one of these renders its player client-side
// and serves a browser nothing worth parsing. Never returns body text: there
// is no article here to summarize, and a card that tried would be inventing.
async function extractMusicMetadata(rawUrl: string, url: URL): Promise<ExtractResult> {
  // Spotify's oEmbed endpoint is public and returns the track name and a
  // hotlinkable cover, which is worth falling back to - it just has no artist.
  const fallback = (httpStatus: number | null): Promise<ExtractResult> | ExtractResult =>
    isSpotifyUrl(url) ? extractViaSpotifyOEmbed(rawUrl) : { ...EMPTY_RESULT, httpStatus };

  try {
    const res = await fetchWithTimeout(rawUrl, { headers: CRAWLER_PAGE_HEADERS });
    if (!res.ok) return fallback(res.status);

    const doc = new JSDOM(await res.text(), { url: rawUrl }).window.document;
    const meta = (property: string): string | null =>
      doc.querySelector(`meta[property="${property}"]`)?.getAttribute("content") ?? null;

    const { title, artist } = splitMusicMetadata(url.hostname, meta("og:title"), meta("og:description"));
    const imageUrl = absoluteUrl(
      meta("og:image") ?? doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content"),
      rawUrl,
    );
    if (!title && !imageUrl) return fallback(res.status);

    return {
      title,
      extractedText: null,
      contentFidelity: "metadata_only",
      author: artist,
      siteName: cleanWhitespace(meta("og:site_name")),
      imageUrl,
      httpStatus: res.status,
    };
  } catch {
    return fallback(null);
  }
}

// Reads whatever author/site metadata the page's <head> has, independent of
// which branch below ends up supplying the body text - a Readability success
// still needs its byline read from the *original* document, since Readability
// consumes a clone and doesn't expose the head at all.
// Readability's byline in particular tends to carry the page's own layout
// whitespace (a title/role on its own line, e.g. "Jane Doe\n    Engineering").
export function cleanWhitespace(value: string | null | undefined): string | null {
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

function extractOpenGraphFallback(
  doc: Document,
  readableTextLength: number,
): Pick<ExtractResult, "title" | "extractedText" | "contentFidelity"> {
  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const ogDescription = doc.querySelector('meta[property="og:description"]')?.getAttribute("content");

  // A client-rendered app shell (reddit.com, bsky.app, open.spotify.com to a
  // browser UA) has no og: tags and a <title> that's just the product name -
  // "Reddit", "Bluesky". Storing that leaves a card that looks like a real save
  // and says nothing. A genuine page with no og:title always carries some body
  // text; a shell measures zero. Below a small threshold, treat <title> as
  // noise and report the failure so it stays retryable.
  const looksLikeShell = !ogTitle && !ogDescription && readableTextLength < 50;
  const title = looksLikeShell ? null : (ogTitle ?? doc.querySelector("title")?.textContent ?? null);

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

  if (isTikTokUrl(url)) {
    return extractViaTikTokOEmbed(rawUrl);
  }

  if (isRedditUrl(url)) {
    return extractViaRedditOG(rawUrl);
  }

  // Ahead of the music branch, which SoundCloud would otherwise fall into and
  // come back from with no artist at all. That path is still the fallback.
  if (isSoundCloudUrl(url)) {
    const viaOEmbed = await extractViaSoundCloudOEmbed(rawUrl);
    return viaOEmbed.title ? viaOEmbed : extractMusicMetadata(rawUrl, url);
  }

  if (isMusicUrl(rawUrl)) {
    return extractMusicMetadata(rawUrl, url);
  }

  // Behind the music branch on purpose: a music.youtube.com link is a song
  // rather than a video, and isMusicUrl claims it first.
  if (isYouTubeUrl(url)) {
    return extractViaYouTubeOEmbed(rawUrl);
  }

  if (isPlaceUrl(rawUrl)) {
    return extractPlace(rawUrl);
  }

  try {
    const res = await fetchWithTimeout(rawUrl, { headers: BROWSER_PAGE_HEADERS });
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };

    // Only parse what claims to be markup. A PDF or a video answers 200 with a
    // body JSDOM will still dutifully try to read as HTML, which costs CPU on
    // the request thread and produces nothing. A missing Content-Type is
    // treated as HTML, which is what browsers do.
    const contentType = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType && !contentType.includes("html") && !contentType.includes("xml")) {
      return { ...EMPTY_RESULT, httpStatus: res.status };
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url: rawUrl });
    const doc = dom.window.document;

    // Readability.parse() destructively consumes the document it's given, so
    // hand it a clone and keep reading `doc` (title/author/site-name meta)
    // afterward regardless of which branch below wins.
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    const articleText = article?.textContent?.trim();
    const { author, siteName, imageUrl } = extractHeadMetadata(doc, rawUrl, article?.byline ?? null);

    const result: ExtractResult =
      articleText && articleText.length >= MIN_FULL_TEXT_LENGTH
        ? {
            title: article?.title ?? null,
            extractedText: articleText,
            contentFidelity: "full_text",
            author,
            siteName,
            imageUrl,
            httpStatus: res.status,
          }
        : {
            ...extractOpenGraphFallback(doc, articleText?.length ?? 0),
            author,
            siteName,
            imageUrl,
            httpStatus: res.status,
          };

    // Instagram sometimes clears the full-text threshold and sometimes doesn't,
    // so reshape after the branch rather than inside one of them.
    return isInstagramUrl(url) ? applyInstagramShape(result) : result;
  } catch {
    return EMPTY_RESULT;
  }
}

// Whether this URL is one the server is willing to fetch on someone's behalf.
//
// extractFromUrl already fails closed - a blocked URL throws inside it and
// comes back as EMPTY_RESULT - but "failed to extract" is the same outcome as a
// paywall, and it would still save the item. A URL pointing at the metadata
// endpoint or at localhost is not a save that half worked; it is one that
// should not happen, and the sender should be told rather than left with a card
// that never fills in.
export async function isFetchableUrl(rawUrl: string): Promise<boolean> {
  try {
    await assertSafeUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
