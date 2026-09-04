import { prisma } from "./db.js";
import type { Item, EnrichmentRun } from "@prisma/client";
import { normalizeHostname } from "./sourceProfile.js";

export interface ItemView {
  id: string;
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
  tags: string[];
  category: string | null;
  contentFidelity: string;
  createdAt: Date;
  canvasX: number | null;
  canvasY: number | null;
}

function labelFor(item: Item): string {
  if (item.title) return item.title;
  if (item.rawUrl) return item.rawUrl;
  return item.rawText.length > 60 ? `${item.rawText.slice(0, 57)}...` : item.rawText;
}

async function toItemView(item: Item): Promise<ItemView> {
  const run = await prisma.enrichmentRun.findFirst({
    where: { itemId: item.id },
    orderBy: { createdAt: "desc" },
  });
  return {
    id: item.id,
    title: item.title,
    rawUrl: item.rawUrl,
    label: labelFor(item),
    author: item.author,
    siteName: item.siteName,
    imageUrl: item.imageUrl,
    sourceHostname: item.rawUrl ? normalizeHostname(item.rawUrl) : null,
    summary: run?.summary ?? null,
    tags: run ? (JSON.parse(run.tags) as string[]) : [],
    category: run?.category ?? null,
    contentFidelity: item.contentFidelity,
    createdAt: item.createdAt,
    canvasX: item.canvasX,
    canvasY: item.canvasY,
  };
}

export async function listRecentItems(phone: string, limit = 5): Promise<ItemView[]> {
  const items = await prisma.item.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return Promise.all(items.map(toItemView));
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
    return Promise.all(items.slice(0, limit).map(toItemView));
  }

  const scored = items
    .map((item) => {
      const haystack = haystackFor(item, item.enrichmentRuns[0]);
      const score = tokens.filter((token) => haystack.includes(token)).length;
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return Promise.all(scored.slice(0, limit).map((entry) => toItemView(entry.item)));
}

export async function listAllItems(phone: string): Promise<ItemView[]> {
  const items = await prisma.item.findMany({ where: { phone }, orderBy: { createdAt: "desc" } });
  return Promise.all(items.map(toItemView));
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
