import { prisma } from "./db.js";
import { extractFromUrl } from "./linkExtract.js";
import { resolveSourceProfileForCapture } from "./sourceProfile.js";
import { enrichLink, enrichNote, classifyMessage, chatAnswer, generateDigest } from "./anthropic.js";
import { listRecentItems, searchItems, listAllItems } from "./repo.js";

const URL_REGEX = /https?:\/\/\S+/i;

const HELP_TEXT = [
  "Whirlpool commands:",
  "- Send anything (a link, a thought, an idea) to capture it — no reply, it's just saved",
  '- "list" - your 5 most recent saves',
  '- "search <term>" - search your saves',
  '- "digest" - a recap of what you\'ve saved',
  "- or ask a question about what you've saved, and I'll answer",
].join("\n");

// Returns null when the message was captured silently (the normal case);
// returns a string only when a reply is actually owed - a command's output,
// a chat answer, or (via a thrown error bubbling up to the caller) a failure.
export async function handleInboundMessage(
  phone: string,
  body: string,
  messageSid: string,
): Promise<string | null> {
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

  const classification = await classifyMessage(trimmed);
  if (classification === "question") {
    return handleChat(phone, trimmed, messageSid);
  }

  return handleSaveNote(phone, trimmed, messageSid);
}

async function handleSaveLink(
  phone: string,
  url: string,
  rawText: string,
  messageSid: string,
): Promise<null> {
  const extraction = await extractFromUrl(url);

  const item = await prisma.item.create({
    data: {
      phone,
      type: "link",
      rawUrl: url,
      title: extraction.title,
      author: extraction.author,
      siteName: extraction.siteName,
      rawText,
      extractedText: extraction.extractedText,
      contentFidelity: extraction.contentFidelity,
      messageSid,
    },
  });

  // Best-effort - a dead favicon or a slow host should never cost the user
  // their save. Runs after the item is already committed so a failure here
  // just leaves the card with a neutral header until the next capture from
  // this hostname retries it.
  resolveSourceProfileForCapture(url).catch((error) => {
    console.error(`Failed to resolve source profile for ${url}`, error);
  });

  if (extraction.contentFidelity === "failed" || !extraction.extractedText) {
    return null;
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

  return null;
}

async function handleSaveNote(phone: string, text: string, messageSid: string): Promise<null> {
  const item = await prisma.item.create({
    data: {
      phone,
      type: "note",
      rawUrl: null,
      title: null,
      rawText: text,
      extractedText: text,
      contentFidelity: "full_text",
      messageSid,
    },
  });

  const enrichment = await enrichNote(text);
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

  return null;
}

async function handleList(phone: string): Promise<string> {
  const items = await listRecentItems(phone, 5);
  if (items.length === 0) return "Nothing saved yet — text me anything to get started.";
  return items
    .map((item, i) => {
      const tags = item.tags.length ? ` (${item.tags.join(", ")})` : "";
      return `${i + 1}. ${item.label}${tags}`;
    })
    .join("\n");
}

async function handleSearch(phone: string, term: string): Promise<string> {
  if (!term) return 'Try "search <term>" — e.g. "search cooking"';
  const items = await searchItems(phone, term, 5);
  if (items.length === 0) return `Nothing found for "${term}".`;
  return items.map((item, i) => `${i + 1}. ${item.label} — ${item.summary ?? ""}`).join("\n");
}

async function handleDigest(phone: string): Promise<string> {
  const items = await listAllItems(phone);
  if (items.length === 0) return "Nothing saved yet — text me anything to get started.";
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
