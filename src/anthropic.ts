import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { searchItems, listRecentItems, type ItemView } from "./repo.js";

const MODEL = "claude-haiku-4-5";
const MAX_CHAT_ITERATIONS = 4;

const client = new Anthropic({ apiKey: config.anthropicApiKey });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Prompt {
  content: string;
  version: string;
}

function loadPrompt(name: string): Prompt {
  const raw = fs.readFileSync(path.join(__dirname, "../prompts", `${name}.md`), "utf-8");
  const version = raw.match(/version:\s*([\w.]+)/)?.[1] ?? "unknown";
  return { content: raw, version };
}

const enrichLinkPrompt = loadPrompt("enrich-link");
const enrichNotePrompt = loadPrompt("enrich-note");
const classifyPrompt = loadPrompt("classify");
const chatSystemPrompt = loadPrompt("chat-system");
const digestPrompt = loadPrompt("digest");

function formatItemForModel(item: ItemView) {
  return {
    title: item.label,
    url: item.rawUrl,
    summary: item.summary,
    tags: item.tags,
    category: item.category,
    content_fidelity: item.contentFidelity,
    days_since_saved: Math.floor((Date.now() - item.createdAt.getTime()) / 86_400_000),
  };
}

// --- Enrichment (summary + tags + category), shared by links and notes ---

export interface EnrichmentResult {
  summary: string;
  tags: string[];
  category: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
}

async function runEnrichment(text: string, prompt: Prompt): Promise<EnrichmentResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: prompt.content,
    messages: [{ role: "user", content: text.slice(0, 12_000) }],
    tools: [
      {
        name: "record_enrichment",
        description: "Record the summary, tags, and category for this saved item.",
        input_schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            category: { type: "string" },
          },
          required: ["summary", "tags", "category"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: "tool", name: "record_enrichment" },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Claude did not return the expected record_enrichment tool call");
  }
  const input = toolUse.input as { summary: string; tags: string[]; category: string };

  return {
    summary: input.summary,
    tags: input.tags,
    category: input.category,
    model: MODEL,
    promptVersion: prompt.version,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

export function enrichLink(extractedText: string): Promise<EnrichmentResult> {
  return runEnrichment(extractedText, enrichLinkPrompt);
}

export function enrichNote(text: string): Promise<EnrichmentResult> {
  return runEnrichment(text, enrichNotePrompt);
}

// --- Classify a freeform message as a capture or a question ---

export async function classifyMessage(text: string): Promise<"capture" | "question"> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 128,
    system: classifyPrompt.content,
    messages: [{ role: "user", content: text }],
    tools: [
      {
        name: "classify",
        description: "Classify this message as a capture or a question.",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["capture", "question"] },
          },
          required: ["type"],
          additionalProperties: false,
        },
        strict: true,
      },
    ],
    tool_choice: { type: "tool", name: "classify" },
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Claude did not return the expected classify tool call");
  }
  const input = toolUse.input as { type: "capture" | "question" };
  return input.type;
}

// --- Chat / Q&A over saved items (tool-use retrieval loop) ---

export interface ChatResult {
  answer: string;
  model: string;
  promptVersion: string;
  toolCalls: { query: string; resultCount: number }[];
  inputTokens: number;
  outputTokens: number;
}

const SEARCH_TOOL: Anthropic.Tool = {
  name: "search_items",
  description:
    "Search the user's saved items by keyword. Use this when the question is about a specific topic.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keyword or phrase to search for" },
      limit: { type: "integer", description: "Max results to return" },
    },
    required: ["query"],
  },
};

const LIST_TOOL: Anthropic.Tool = {
  name: "list_recent_items",
  description:
    "List the user's most recently saved items, newest first. Use this for broad questions " +
    "like 'what have I saved lately' where there is no specific topic to search for.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max items to return (default 10)" },
    },
  },
};

export async function chatAnswer(phone: string, question: string): Promise<ChatResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const toolCalls: { query: string; resultCount: number }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let iteration = 0; iteration < MAX_CHAT_ITERATIONS; iteration++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: chatSystemPrompt.content,
      messages,
      tools: [SEARCH_TOOL, LIST_TOOL],
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason !== "tool_use") {
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      return {
        answer: textBlock?.text ?? "",
        model: MODEL,
        promptVersion: chatSystemPrompt.version,
        toolCalls,
        inputTokens,
        outputTokens,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = block.input as { query?: string; limit?: number };

      const results =
        block.name === "list_recent_items"
          ? await listRecentItems(phone, input.limit ?? 10)
          : await searchItems(phone, input.query ?? "", input.limit ?? 5);

      toolCalls.push({
        query: block.name === "list_recent_items" ? "(recent items)" : (input.query ?? ""),
        resultCount: results.length,
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(results.map(formatItemForModel)),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    answer: "Sorry, I had trouble pulling that together — try rephrasing the question?",
    model: MODEL,
    promptVersion: chatSystemPrompt.version,
    toolCalls,
    inputTokens,
    outputTokens,
  };
}

// --- On-demand digest ---

export interface DigestResult {
  text: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
}

export async function generateDigest(items: ItemView[]): Promise<DigestResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: digestPrompt.content,
    messages: [{ role: "user", content: JSON.stringify(items.map(formatItemForModel)) }],
  });
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  return {
    text: textBlock?.text ?? "",
    model: MODEL,
    promptVersion: digestPrompt.version,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
