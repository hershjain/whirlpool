import { prisma } from "./db.js";
import { extractFromUrl } from "./linkExtract.js";
import { enrichLink, chatAnswer, generateDigest } from "./anthropic.js";
import { listRecentItems, searchItems, allItemsForDigest } from "./repo.js";

const URL_REGEX = /https?:\/\/\S+/i;

const HELP_TEXT = [
  "Whirlpool commands:",
  '- Send a link to save it',
  '- "list" - your 5 most recent saves',
  '- "search <term>" - search your saves',
  '- "digest" - a recap of what you\'ve saved',
  "- or just ask a question about what you've saved",
].join("\n");

export async function handleInboundMessage(
  phone: string,
  body: string,
  messageSid: string,
): Promise<string> {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();

  const urlMatch = trimmed.match(URL_REGEX);
  if (urlMatch) {
    return handleSaveLink(phone, urlMatch[0], trimmed, messageSid);
  }

  if (lower === "digest" || lower === "recap") {
    return handleDigest(phone);
  }

  if (lower === "list" || lower === "recent") {
    return handleList(phone);
  }

  if (lower.startsWith("search ")) {
    return handleSearch(phone, trimmed.slice("search ".length).trim());
  }

  if (lower === "help") {
    return HELP_TEXT;
  }

  return handleChat(phone, trimmed, messageSid);
}

async function handleSaveLink(
  phone: string,
  url: string,
  rawText: string,
  messageSid: string,
): Promise<string> {
  const extraction = await extractFromUrl(url);

  const item = await prisma.item.create({
    data: {
      phone,
      type: "link",
      rawUrl: url,
      title: extraction.title,
      rawText,
      extractedText: extraction.extractedText,
      contentFidelity: extraction.contentFidelity,
      messageSid,
    },
  });

  if (extraction.contentFidelity === "failed" || !extraction.extractedText) {
    return "Saved — but I couldn't pull any content from that link, so it's just stored as-is. You may want to open it directly later.";
  }

  const enrichment = await enrichLink(extraction.extractedText);
  await prisma.enrichmentRun.create({
    data: {
      itemId: item.id,
      model: enrichment.model,
      promptVersion: enrichment.promptVersion,
      summary: enrichment.summary,
      tags: JSON.stringify(enrichment.tags),
      category: enrichment.category,
      inputTokens: enrichment.inputTokens,
      outputTokens: enrichment.outputTokens,
    },
  });

  const fidelityNote = extraction.contentFidelity === "metadata_only" ? " (partial info only)" : "";
  return `Saved${fidelityNote}: ${extraction.title ?? url}\n${enrichment.summary}\nTags: ${enrichment.tags.join(", ")}`;
}

async function handleList(phone: string): Promise<string> {
  const items = await listRecentItems(phone, 5);
  if (items.length === 0) return "Nothing saved yet — text me a link to get started.";
  return items
    .map((item, i) => {
      const tags = item.tags.length ? ` (${item.tags.join(", ")})` : "";
      return `${i + 1}. ${item.title ?? item.rawUrl}${tags}`;
    })
    .join("\n");
}

async function handleSearch(phone: string, term: string): Promise<string> {
  if (!term) return 'Try "search <term>" — e.g. "search cooking"';
  const items = await searchItems(phone, term, 5);
  if (items.length === 0) return `Nothing found for "${term}".`;
  return items
    .map((item, i) => `${i + 1}. ${item.title ?? item.rawUrl} — ${item.summary ?? ""}`)
    .join("\n");
}

async function handleDigest(phone: string): Promise<string> {
  const items = await allItemsForDigest(phone);
  if (items.length === 0) return "Nothing saved yet — text me a link to get started.";
  const digest = await generateDigest(items);
  return digest.text;
}

async function handleChat(phone: string, question: string, messageSid: string): Promise<string> {
  const result = await chatAnswer(phone, question);
  await prisma.chatTurn.create({
    data: {
      phone,
      question,
      answer: result.answer,
      model: result.model,
      promptVersion: result.promptVersion,
      toolCalls: JSON.stringify(result.toolCalls),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      messageSid,
    },
  });
  return result.answer;
}
