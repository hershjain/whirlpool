import { prisma } from "./db.js";
import type { Item, EnrichmentRun } from "@prisma/client";
import { domainOf, getSiteProfiles } from "./siteProfile.js";

// Notes aren't tied to a site, so their bar colour is a constant rather than
// something resolved and cached per domain.
export const NOTE_ACCENT_COLOR = "#F7E7A6";

export interface ItemView {
  id: string;
  title: string | null;
  rawUrl: string | null;
  // Best available display label: title, falling back to the URL, falling
  // back to a truncated snippet of the raw captured text (for notes).
  label: string;
  summary: string | null;
  tags: string[];
  category: string | null;
  contentFidelity: string;
  createdAt: Date;
  canvasX: number | null;
  canvasY: number | null;
  imageUrl: string | null;
  // Resolved from the per-domain SiteProfile cache (or constant, for notes).
  domain: string | null;
  faviconDataUri: string | null;
  accentColor: string | null;
  // "theme-color" | "favicon" | "domain-hash" | null. When this is
  // "domain-hash" and a favicon exists, the frontend derives a better colour
  // from the icon and writes it back.
  colorSource: string | null;
}

type SiteProfileView = {
  faviconDataUri: string | null;
  accentColor: string | null;
  colorSource: string | null;
};

function labelFor(item: Item): string {
  if (item.title) return item.title;
  if (item.rawUrl) return item.rawUrl;
  return item.rawText.length > 60 ? `${item.rawText.slice(0, 57)}...` : item.rawText;
}

async function toItemView(item: Item, profile?: SiteProfileView): Promise<ItemView> {
  const run = await prisma.enrichmentRun.findFirst({
    where: { itemId: item.id },
    orderBy: { createdAt: "desc" },
  });
  const isNote = item.type === "note";
  return {
    id: item.id,
    title: item.title,
    rawUrl: item.rawUrl,
    label: labelFor(item),
    summary: run?.summary ?? null,
    tags: run ? (JSON.parse(run.tags) as string[]) : [],
    category: run?.category ?? null,
    contentFidelity: item.contentFidelity,
    createdAt: item.createdAt,
    canvasX: item.canvasX,
    canvasY: item.canvasY,
    imageUrl: item.imageUrl,
    domain: item.rawUrl ? domainOf(item.rawUrl) : null,
    faviconDataUri: isNote ? null : (profile?.faviconDataUri ?? null),
    accentColor: isNote ? NOTE_ACCENT_COLOR : (profile?.accentColor ?? null),
    colorSource: isNote ? "note" : (profile?.colorSource ?? null),
  };
}

// Resolves every item's site profile in one query rather than one per item.
async function toItemViews(items: Item[]): Promise<ItemView[]> {
  const domains = [...new Set(items.map((i) => (i.rawUrl ? domainOf(i.rawUrl) : null)).filter((d): d is string => Boolean(d)))];
  const profiles = await getSiteProfiles(domains);
  return Promise.all(
    items.map((item) => {
      const domain = item.rawUrl ? domainOf(item.rawUrl) : null;
      return toItemView(item, domain ? profiles.get(domain) : undefined);
    }),
  );
}

export async function listRecentItems(phone: string, limit = 5): Promise<ItemView[]> {
  const items = await prisma.item.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return toItemViews(items);
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
    return toItemViews(items.slice(0, limit));
  }

  const scored = items
    .map((item) => {
      const haystack = haystackFor(item, item.enrichmentRuns[0]);
      const score = tokens.filter((token) => haystack.includes(token)).length;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return toItemViews(scored.slice(0, limit).map((entry) => entry.item));
}

export async function listAllItems(phone: string): Promise<ItemView[]> {
  const items = await prisma.item.findMany({ where: { phone }, orderBy: { createdAt: "desc" } });
  return toItemViews(items);
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
