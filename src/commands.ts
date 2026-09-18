import { prisma } from "./db.js";
import { extractFromUrl, isMusicUrl, isPlaceUrl, isFetchableUrl } from "./linkExtract.js";
import { resolveSourceProfileForCapture } from "./sourceProfile.js";
import {
  enrichLink,
  enrichNote,
  enrichmentInput,
  noteIsWorthEnriching,
  classifyMessage,
  chatAnswer,
  generateDigest,
} from "./anthropic.js";
import { listRecentItems, searchItems, listAllItems } from "./repo.js";
import { setOptedOut } from "./users.js";
import { allowModelRequest } from "./rateLimit.js";
import { config } from "./config.js";
import { log, safePhone, reportError } from "./logger.js";

const URL_REGEX = /https?:\/\/\S+/i;

// Every branch that reaches a model checks the daily ceiling and returns this.
// One string so the reply does not depend on which branch happened to hit it.
const OVER_LIMIT = "You’ve hit today’s limit. Try again tomorrow.";

const HELP_TEXT = [
  "Whirlpool commands:",
  "- Send anything (a link, a thought, an idea) to capture it — no reply, it's just saved",
  '- "list" - your 5 most recent saves',
  '- "search <term>" - search your saves',
  '- "digest" - a recap of what you\'ve saved',
  "- or ask a question about what you've saved, and I'll answer",
].join("\n");

// The standard carrier opt-out/opt-in words. Recognised on their own only:
// "stop" alone is an instruction, while "stop doing that" is a thought worth
// saving, and treating the second as the first would silently mute someone.
const STOP_KEYWORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_KEYWORDS = new Set(["start", "unstop", "yes"]);

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

  // Carrier keywords come first, ahead of everything including the URL match.
  // Twilio acts on these itself - STOP blocks our sends at their end whatever
  // we do - but if we do not claim them here they fall through to the
  // classifier and get filed as saved thoughts, so someone's board ends up
  // with a note reading "STOP". Mirroring the opt-out locally also stops us
  // queueing a login code that the carrier will refuse to deliver.
  if (STOP_KEYWORDS.has(lower)) {
    await setOptedOut(phone, true);
    return null; // Twilio sends its own confirmation; a second one is spam
  }

  if (START_KEYWORDS.has(lower)) {
    await setOptedOut(phone, false);
    return "You're opted back in. Text me anything to save it.";
  }

  if (lower === "help" || lower === "info") {
    return HELP_TEXT;
  }

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
): Promise<string | null> {
  // Refused before anything is written. The server will not fetch a private or
  // loopback address on someone else's behalf, and a link it will not fetch is
  // not a link worth storing a dead card for.
  if (!(await isFetchableUrl(url))) {
    log.warn({ phone: safePhone(phone), url }, "Refused to fetch a blocked URL");
    return "I can't save that link — it doesn't point anywhere I'm able to fetch.";
  }

  if (!(await allowModelRequest(phone, config.maxDailyModelRequestsPerPhone))) {
    return OVER_LIMIT;
  }

  const extraction = await extractFromUrl(url);

  const item = await prisma.item.create({
    data: {
      phone,
      type: "link",
      rawUrl: url,
      title: extraction.title,
      author: extraction.author,
      siteName: extraction.siteName,
      imageUrl: extraction.imageUrl,
      rawText,
      extractedText: extraction.extractedText,
      contentFidelity: extraction.contentFidelity,
      linkStatus: extraction.httpStatus,
      messageSid,
    },
  });

  // Awaited, so the profile is in place before the item can be rendered -
  // fire-and-forget left a race where the card drew with a neutral header and
  // kept it until a manual reload. Capture is silent and already runs in the
  // background, so nobody is waiting on the extra few seconds. Still
  // best-effort: the item is committed above, so a dead favicon or a slow
  // host costs branding, never the save itself.
  try {
    await resolveSourceProfileForCapture(url);
  } catch (error) {
    reportError(error, { scope: "sourceProfile.capture", url });
  }

  // A song is its name and its artist, both of which the extraction already
  // has. There is nothing for a model to summarize, and asking it to try gave
  // a Drake track the tags "virginia-beach, travel, coastal" - so music skips
  // enrichment entirely rather than paying for a wrong answer.
  //
  // A map pin is the same shape of problem - a name and an address, with
  // nothing a model could add that the extraction doesn't already have - so
  // places skip it on the same grounds.
  if (isMusicUrl(url) || isPlaceUrl(url)) {
    return null;
  }

  // A save with no body text can still be worth tagging when it has a real
  // title - an are.na image block, say. See enrichmentInput.
  const enrichmentText = enrichmentInput(extraction.extractedText, extraction.title);
  if (!enrichmentText) {
    return null;
  }

  const enrichment = await enrichLink(enrichmentText);
  // Null means the model returned placeholders rather than content. Same end
  // state as the screen above declining to call at all: no run, no tags.
  if (!enrichment) {
    return null;
  }

  await prisma.enrichmentRun.create({
    data: {
      itemId: item.id,
      model: enrichment.model,
      promptVersion: enrichment.promptVersion,
      summary: enrichment.summary ?? "",
      tags: JSON.stringify(enrichment.tags),
      category: enrichment.category ?? "",
      inputTokens: enrichment.inputTokens,
      outputTokens: enrichment.outputTokens,
    },
  });

  return null;
}

async function handleSaveNote(phone: string, text: string, messageSid: string): Promise<string | null> {
  if (!(await allowModelRequest(phone, config.maxDailyModelRequestsPerPhone))) {
    return OVER_LIMIT;
  }

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

  // The summary this produces is never rendered - notes show raw text. Tags
  // and category are the point: they put notes in the canvas filter bar.
  if (!noteIsWorthEnriching(text)) {
    return null;
  }

  const enrichment = await enrichNote(text);
  if (!enrichment) {
    return null;
  }

  await prisma.enrichmentRun.create({
    data: {
      itemId: item.id,
      model: enrichment.model,
      promptVersion: enrichment.promptVersion,
      summary: enrichment.summary ?? "",
      tags: JSON.stringify(enrichment.tags),
      category: enrichment.category ?? "",
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

// The digest used to serialize every item the user had ever saved into one
// prompt. Cost grew linearly with the library, and a long enough one eventually
// overflows the context window - which reaches the user as "Something went
// wrong" on the one command whose whole job is to look back. A recap is a recap;
// it does not need everything.
const DIGEST_ITEM_LIMIT = 60;

async function handleDigest(phone: string): Promise<string> {
  if (!(await allowModelRequest(phone, config.maxDailyModelRequestsPerPhone))) return OVER_LIMIT;

  const items = await listAllItems(phone);
  if (items.length === 0) return "Nothing saved yet — text me anything to get started.";
  const digest = await generateDigest(items.slice(0, DIGEST_ITEM_LIMIT));
  return digest.text;
}

async function handleChat(phone: string, question: string, messageSid: string): Promise<string> {
  if (!(await allowModelRequest(phone, config.maxDailyModelRequestsPerPhone))) return OVER_LIMIT;

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
