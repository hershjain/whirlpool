import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { fetchWithTimeout, BROWSER_PAGE_HEADERS, CRAWLER_PAGE_HEADERS } from "./httpFetch.js";

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
    const res = await fetchWithTimeout(oembedUrl);
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
    const res = await fetchWithTimeout(oembedUrl);
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
    const res = await fetchWithTimeout(oembedUrl, { headers: CRAWLER_PAGE_HEADERS });
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
    const res = await fetchWithTimeout(oembedUrl);
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

  if (isSpotifyUrl(url)) {
    return extractViaSpotifyOEmbed(rawUrl);
  }

  try {
    const res = await fetchWithTimeout(rawUrl, { headers: BROWSER_PAGE_HEADERS });
    if (!res.ok) return { ...EMPTY_RESULT, httpStatus: res.status };
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
