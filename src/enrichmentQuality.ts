// What counts as a usable enrichment, in one place.
//
// A model handed a required tool schema and nothing worth describing does not
// refuse - it fills the fields with a placeholder. A note reading "This is a
// note: I want to save some information about" produced `<UNKNOWN>` for the
// summary, the category, and every tag, and all three were stored and rendered.
//
// This is the same failure repo.ts already names for music and place links:
// "there is nothing in either for a model to summarize, and one asked to try
// will invent." The difference is that those are recognised from the URL before
// the call, and a thin note can only be recognised from what comes back.
//
// Deliberately free of config and SDK imports. repo.ts needs this predicate on
// the read path, and importing anthropic.ts there would construct an API client
// and demand an API key just to render a card - and it keeps the tests runnable
// with no environment at all.

// Values a model reaches for when it has nothing. Compared after trimming and
// lowercasing, so "N/A" and " none " are caught too.
const PLACEHOLDER_WORDS = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "undefined",
  "unknown",
  "unclear",
  "not applicable",
  "not specified",
  "no summary",
  "no tags",
  "no category",
]);

// `<UNKNOWN>`, `[unknown]`, `{{category}}` - a whole value wrapped in brackets
// is a slot the model never filled. Anchored at both ends on purpose: a tag
// like "c++<20" is a real tag, and "<script>" as someone's actual note text is
// their words, not a placeholder.
const WRAPPED = /^[<\[{(]+.*[>\]})]+$/s;

export function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (PLACEHOLDER_WORDS.has(trimmed.toLowerCase())) return true;
  if (!WRAPPED.test(trimmed)) return false;
  // Strip the brackets and judge what is inside: "<unknown>" is a placeholder,
  // but "(see the second half of the thread)" is a real, if odd, summary.
  const inner = trimmed.replace(/^[<\[{(]+/, "").replace(/[>\]})]+$/, "").trim();
  return inner.length <= 24;
}

export interface RawEnrichment {
  summary: string;
  tags: string[];
  category: string;
}

export interface SanitizedEnrichment {
  summary: string | null;
  tags: string[];
  category: string | null;
}

// Drops the placeholders and reports what survived. Field by field rather than
// all-or-nothing: a real summary with one junk tag is worth keeping, minus the
// tag.
export function sanitizeEnrichment(raw: RawEnrichment): SanitizedEnrichment {
  const summary = typeof raw.summary === "string" && !isPlaceholderValue(raw.summary)
    ? raw.summary.trim()
    : null;

  const category = typeof raw.category === "string" && !isPlaceholderValue(raw.category)
    ? raw.category.trim()
    : null;

  const tags = (Array.isArray(raw.tags) ? raw.tags : [])
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0 && !isPlaceholderValue(tag));

  return { summary, tags, category };
}

// Nothing left worth writing a row for. Checked as "no tags and no category"
// rather than "no summary": the summary of a note is generated but never shown
// (see enrichNote), so a run that kept only a summary earns nothing - while
// tags and category do real work in the filter bar and in chat search.
export function isUnusableEnrichment(e: SanitizedEnrichment): boolean {
  return e.tags.length === 0 && e.category === null;
}

// The same treatment for a row already in the database. Applied on the read
// path so rows written before any of this existed stop showing invented tags
// without having to be rewritten - and so the empty strings the write path
// stores for a dropped summary or category read back as absent rather than
// blank.
export function sanitizeStoredRun(run: {
  summary: string;
  tags: string;
  category: string;
}): SanitizedEnrichment {
  let tags: unknown;
  try {
    tags = JSON.parse(run.tags);
  } catch {
    // A row whose tags are not valid JSON cannot be rendered anyway.
    tags = [];
  }
  return sanitizeEnrichment({
    summary: run.summary,
    tags: Array.isArray(tags) ? (tags as string[]) : [],
    category: run.category,
  });
}

export function storedRunIsPlaceholder(run: {
  summary: string;
  tags: string;
  category: string;
}): boolean {
  return isUnusableEnrichment(sanitizeStoredRun(run));
}
