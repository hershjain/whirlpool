import { prisma } from "./db.js";
import type { Item, EnrichmentRun } from "@prisma/client";
import { canonicalSourceHostname, normalizeHostname } from "./sourceProfile.js";
import { isMusicUrl, isPlaceUrl, youTubeVideoId } from "./linkExtract.js";

export interface ItemView {
  id: string;
  // "link" | "note" - the frontend styles notes differently, and inferring it
  // from a null rawUrl reads as a coincidence rather than the rule it is.
  type: string;
  title: string | null;
  rawUrl: string | null;
  // Best available display label: title, falling back to the URL, falling
  // back to a truncated snippet of the raw captured text (for notes).
  label: string;
  author: string | null;
  siteName: string | null;
  imageUrl: string | null;
  // Normalized ("www."-stripped) hostname, joined client-side against
  // GET /api/sources to look up that domain's card branding. Null for notes.
  sourceHostname: string | null;
  summary: string | null;
  // The item's own words, truncated - a tweet, a caption, or the opening of
  // an article when it has no summary to show instead.
  excerpt: string | null;
  // True only for genuine long-form writing. Readability pulls a caption plus
  // page chrome off an Instagram post and calls it full_text, so fidelity
  // alone can't separate a photo post from an article - length can. Drives
  // both how big the image is drawn and whether a summary beats the raw text.
  isLongForm: boolean;
  tags: string[];
  category: string | null;
  // A track on a streaming service. The card leads with the song name and puts
  // the artist under it, and carries no summary and no tags: asking a model to
  // describe a song it can only see the title of produced a Drake track filed
  // as a travel reference.
  isMusic: boolean;
  // A YouTube video. Drives the play glyph drawn over the card's thumbnail -
  // an affordance saying what the link is, not a control: clicking the card
  // still opens YouTube in a new tab like every other card.
  isVideo: boolean;
  // A Google Maps link. Like a song, a place is a name and one fact about it -
  // where it is - so the card leads with the name and puts the address under
  // it, and carries no summary and no tags for the same reason music doesn't.
  isPlace: boolean;
  contentFidelity: string;
  // True when the last fetch found the page gone. Surfaced on the card so a
  // dead save reads as dead rather than as an item that simply extracted badly.
  isBroken: boolean;
  // True when extraction came back with nothing worth showing - a client-side
  // app shell (reddit.com, bsky.app) that resolves fine but yields no title,
  // text or image. Distinct from isBroken: the link works, we just can't
  // preview it. The card says so instead of showing a bare hostname.
  hasPreview: boolean;
  createdAt: Date;
  canvasX: number | null;
  canvasY: number | null;
  // The folder this item was filed into by hand, if any. Distinct from tags
  // and category, which the model assigns.
  folderId: string | null;
  folderName: string | null;
}

const MAX_EXCERPT_LENGTH = 280;

// Measured against the real captures: Instagram posts land at 673-1869 chars
// (caption plus Instagram's own page furniture), while actual articles run
// 6800+. Anything between is ambiguous and reads acceptably either way.
const LONG_FORM_MIN_LENGTH = 2500;

function excerptFor(item: Item, label: string): string | null {
  const text = item.extractedText?.trim();
  if (!text) return null;

  // A note renders as its own words and never draws a title, so it always
  // carries its text here - in full, rather than through labelFor's 60-char
  // truncation.
  if (item.type === "note") {
    return text.length > MAX_EXCERPT_LENGTH ? `${text.slice(0, MAX_EXCERPT_LENGTH - 1)}\u2026` : text;
  }

  // Elsewhere a page can title itself with its only line of copy - printing
  // that twice on one card just looks broken.
  if (text.toLowerCase() === label.trim().toLowerCase()) return null;

  return text.length > MAX_EXCERPT_LENGTH ? `${text.slice(0, MAX_EXCERPT_LENGTH - 1)}\u2026` : text;
}

function isLongForm(item: Item): boolean {
  return item.contentFidelity === "full_text" && (item.extractedText?.length ?? 0) >= LONG_FORM_MIN_LENGTH;
}

function labelFor(item: Item): string {
  if (item.title) return item.title;
  // A titleless link means extraction found nothing (a JS app shell). The bare
  // hostname reads far better on the card than a 90-char share URL full of
  // tracking params.
  if (item.rawUrl) return normalizeHostname(item.rawUrl) ?? item.rawUrl;
  return item.rawText.length > 60 ? `${item.rawText.slice(0, 57)}...` : item.rawText;
}

// The latest enrichment run is passed in rather than fetched here. This used to
// issue one findFirst per item, which made every listing 1 + N queries with no
// bound on N - and searchItems was already eager-loading the run and then
// throwing it away by calling this.
function toItemView(
  item: Item & { folder?: { id: string; name: string } | null },
  run: EnrichmentRun | undefined,
): ItemView {
  const label = labelFor(item);
  const isMusic = item.rawUrl !== null && isMusicUrl(item.rawUrl);
  const isPlace = item.rawUrl !== null && isPlaceUrl(item.rawUrl);
  const isVideo = item.rawUrl !== null && youTubeVideoId(item.rawUrl) !== null;
  // A song and a map pin have the same problem: there is nothing in either for
  // a model to summarize, and one asked to try will invent. Both are derived
  // from the URL here rather than stored, so rows saved before any of this
  // existed pick it up on the next read - see the note on isMusic below.
  const isUnenriched = isMusic || isPlace;

  return {
    id: item.id,
    type: item.type,
    title: item.title,
    rawUrl: item.rawUrl,
    label,
    author: item.author,
    siteName: item.siteName,
    imageUrl: item.imageUrl,
    sourceHostname: item.rawUrl ? canonicalSourceHostname(item.rawUrl) : null,
    // Suppressed here rather than only at capture, so the rows enriched before
    // music was recognised stop showing their invented summary and tags
    // without having to be rewritten.
    summary: isUnenriched ? null : (run?.summary ?? null),
    // A video's own "text" is its description, which is where a channel keeps
    // its sponsor blurb, its socials and a wall of affiliate links. Captures
    // since the YouTube branch existed never store one - this drops the ones
    // saved before it, which backfill-content cannot clear because it only
    // ever fills a field in and never blanks it.
    excerpt: isVideo ? null : excerptFor(item, label),
    isLongForm: isLongForm(item),
    tags: isUnenriched || !run ? [] : (JSON.parse(run.tags) as string[]),
    // Dropped for the same reason as the tags, and so the rows enriched before
    // music was recognised behave like the ones captured since, which skip
    // enrichment and have no category at all.
    category: isUnenriched ? null : (run?.category ?? null),
    isMusic,
    isVideo,
    isPlace,
    contentFidelity: item.contentFidelity,
    isBroken: item.linkStatus === 404 || item.linkStatus === 410,
    hasPreview: Boolean(item.title || item.imageUrl || item.extractedText),
    createdAt: item.createdAt,
    canvasX: item.canvasX,
    canvasY: item.canvasY,
    folderId: item.folder?.id ?? null,
    folderName: item.folder?.name ?? null,
  };
}

export async function listRecentItems(phone: string, limit = 5): Promise<ItemView[]> {
  const items = await prisma.item.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { enrichmentRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return items.map((item) => toItemView(item, item.enrichmentRuns[0]));
}

// Words carrying no signal about *what* was saved - dropping them stops a
// query like "what have I saved about cooking" from only matching items that
// contain that entire sentence verbatim.
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "about", "from",
  "what", "which", "who", "when", "where", "why", "how", "did", "do", "does", "is", "are",
  "was", "were", "have", "has", "had", "any", "all", "some", "that", "this", "these", "those",
  "you", "your", "me", "my", "mine", "our", "their", "his", "her", "its",
  "save", "saved", "saving", "show", "tell", "find", "get", "give", "list", "stuff", "things",
  "thing", "something", "anything", "everything", "item", "items", "note", "notes", "link",
  "links", "recently", "recent", "lately", "back", "again", "please",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function haystackFor(item: Item, run: EnrichmentRun | undefined): string {
  return [item.title, item.rawText, item.extractedText, run?.summary, run?.category, run?.tags]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export async function searchItems(phone: string, query: string, limit = 5): Promise<ItemView[]> {
  const items = await prisma.item.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    include: { enrichmentRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const tokens = tokenize(query);

  // A query with no meaningful words left ("what have I saved lately?") is
  // really a request to browse, so return the most recent items rather than
  // nothing. A query that *does* have real terms but matches nothing returns
  // empty - better an honest "nothing found" than unrelated items.
  if (tokens.length === 0) {
    return items.slice(0, limit).map((item) => toItemView(item, item.enrichmentRuns[0]));
  }

  const scored = items
    .map((item) => {
      const haystack = haystackFor(item, item.enrichmentRuns[0]);
      const score = tokens.filter((token) => haystack.includes(token)).length;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((entry) => toItemView(entry.item, entry.item.enrichmentRuns[0]));
}

export async function listAllItems(phone: string): Promise<ItemView[]> {
  const items = await prisma.item.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    include: {
      folder: true,
      enrichmentRuns: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return items.map((item) => toItemView(item, item.enrichmentRuns[0]));
}

// Scoped to `phone` so a canvas request can never move another user's item,
// even before real multi-user auth exists.
export async function updateItemPosition(
  phone: string,
  itemId: string,
  x: number,
  y: number,
): Promise<boolean> {
  const result = await prisma.item.updateMany({
    where: { id: itemId, phone },
    data: { canvasX: x, canvasY: y },
  });
  return result.count > 0;
}

// Permanent, and the only destructive operation the canvas has. EnrichmentRun
// holds a required foreign key to Item with no cascade, so its rows go first -
// in one transaction, so a half-deleted item can never be left behind.
export async function deleteItem(phone: string, itemId: string): Promise<boolean> {
  const item = await prisma.item.findFirst({ where: { id: itemId, phone }, select: { id: true } });
  if (!item) return false;

  await prisma.$transaction([
    prisma.enrichmentRun.deleteMany({ where: { itemId } }),
    prisma.item.delete({ where: { id: itemId } }),
  ]);
  return true;
}

// --- Folders: user-made collections, distinct from the model's tags/category ---

export interface FolderView {
  id: string;
  name: string;
  itemCount: number;
  // Where the folder's square sits on the board. Null until the first time it
  // is opened, which places it clear of the cards already on the canvas.
  canvasX: number | null;
  canvasY: number | null;
}

export async function listFolders(phone: string): Promise<FolderView[]> {
  const folders = await prisma.folder.findMany({
    where: { phone },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { items: true } } },
  });
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    itemCount: folder._count.items,
    canvasX: folder.canvasX,
    canvasY: folder.canvasY,
  }));
}

// Files (or, with folderId null, unfiles) an item into a folder. Returns
// false when the item isn't the owner's, or the target folder isn't -
// either way nothing is written, so the caller can 404 without needing to
// tell the two cases apart.
export async function setItemFolder(phone: string, itemId: string, folderId: string | null): Promise<boolean> {
  if (folderId !== null) {
    const folder = await prisma.folder.findFirst({ where: { id: folderId, phone } });
    if (!folder) return false;
  }

  const result = await prisma.item.updateMany({
    where: { id: itemId, phone },
    data: { folderId },
  });
  return result.count > 0;
}

// Idempotent on name (Folder is unique on [phone, name]) - double-submitting
// "Research" from the tile menu returns the existing folder rather than
// throwing on the constraint.
export async function createFolder(phone: string, name: string): Promise<FolderView | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const folder = await prisma.folder.upsert({
    where: { phone_name: { phone, name: trimmed } },
    update: {},
    create: { phone, name: trimmed },
    include: { _count: { select: { items: true } } },
  });
  return {
    id: folder.id,
    name: folder.name,
    itemCount: folder._count.items,
    canvasX: folder.canvasX,
    canvasY: folder.canvasY,
  };
}

// Same shape and scoping as updateItemPosition - a folder's square is placed by
// hand on the board, so where it sits belongs to the owner like a card does.
export async function updateFolderPosition(
  phone: string,
  folderId: string,
  x: number,
  y: number,
): Promise<boolean> {
  const result = await prisma.folder.updateMany({
    where: { id: folderId, phone },
    data: { canvasX: x, canvasY: y },
  });
  return result.count > 0;
}

// The source-branding rows for the hostnames this person has actually saved
// from.
//
// The canvas used to fetch SourceProfile unscoped, which is defensible - the
// table is global branding data, not anyone's content - but the *set of
// hostnames in it* is the aggregate reading habits of everyone using the app,
// handed to every logged-in user. Scoping it costs one extra query and leaks
// nothing.
export async function listSourceProfilesForPhone(phone: string) {
  const rows = await prisma.item.findMany({
    where: { phone, rawUrl: { not: null } },
    select: { rawUrl: true },
    distinct: ["rawUrl"],
  });

  const hostnames = [
    ...new Set(
      rows
        .map((row) => (row.rawUrl ? canonicalSourceHostname(row.rawUrl) : null))
        .filter((host): host is string => host !== null),
    ),
  ];
  if (hostnames.length === 0) return [];

  return prisma.sourceProfile.findMany({ where: { hostname: { in: hostnames } } });
}
