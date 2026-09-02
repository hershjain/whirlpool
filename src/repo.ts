import { prisma } from "./db.js";
import type { Item, EnrichmentRun } from "@prisma/client";

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

function matchesQuery(item: Item, run: EnrichmentRun | undefined, query: string): boolean {
  const haystack = [item.title, item.rawText, item.extractedText, run?.summary, run?.category, run?.tags]
    .filter((v): v is string => Boolean(v))
    .join(" ")
    .toLowerCase();
  return haystack.includes(query.toLowerCase());
}

export async function searchItems(phone: string, query: string, limit = 5): Promise<ItemView[]> {
  const items = await prisma.item.findMany({
    where: { phone },
    orderBy: { createdAt: "desc" },
    include: { enrichmentRuns: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const matched = items.filter((item) => matchesQuery(item, item.enrichmentRuns[0], query));
  return Promise.all(matched.slice(0, limit).map((item) => toItemView(item)));
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
