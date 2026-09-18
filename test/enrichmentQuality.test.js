// A model given a required tool schema and nothing worth describing does not
// decline - it fills the fields. A note reading "This is a note: I want to save
// some information about" came back with `<UNKNOWN>` as its summary, its
// category, and its only tag, and all three were stored and rendered on the
// board.
//
// The fix has to hold at both ends: junk must not be written at capture, and
// the rows written before the guard existed must stop being rendered. Both use
// the predicate exercised here, so this file is where a future loosening of it
// gets caught.
//
// No environment is needed - enrichmentQuality deliberately imports neither
// config nor the SDK, which is the whole reason it is its own module.
import test from "node:test";
import assert from "node:assert/strict";

import {
  isPlaceholderValue,
  sanitizeEnrichment,
  isUnusableEnrichment,
  sanitizeStoredRun,
} from "../dist/enrichmentQuality.js";

test("the value that caused this is a placeholder", () => {
  assert.equal(isPlaceholderValue("<UNKNOWN>"), true);
});

test("bare placeholder words are caught whatever their case or padding", () => {
  for (const value of ["unknown", "UNKNOWN", " N/A ", "none", "null", "", "   ", "-"]) {
    assert.equal(isPlaceholderValue(value), true, `expected "${value}" to be a placeholder`);
  }
});

test("bracket-wrapped slots are caught in any bracket style", () => {
  for (const value of ["<unknown>", "[unknown]", "{{category}}", "(none)"]) {
    assert.equal(isPlaceholderValue(value), true, `expected "${value}" to be a placeholder`);
  }
});

test("real tags are not placeholders", () => {
  for (const value of ["basketball", "highlight", "tournament", "toronto", "c++<20", "a-b"]) {
    assert.equal(isPlaceholderValue(value), false, `expected "${value}" to be kept`);
  }
});

// The bracket rule judges what is inside rather than the brackets themselves,
// so that a parenthetical someone actually wrote survives.
test("a long bracketed phrase is real content, not a slot", () => {
  assert.equal(isPlaceholderValue("(see the second half of the thread for context)"), false);
});

test("sanitize drops placeholders field by field", () => {
  const clean = sanitizeEnrichment({
    summary: "<UNKNOWN>",
    tags: ["basketball", "<UNKNOWN>", "  ", "toronto"],
    category: "video",
  });

  assert.equal(clean.summary, null);
  assert.deepEqual(clean.tags, ["basketball", "toronto"]);
  assert.equal(clean.category, "video");
});

// A good summary with one junk tag keeps the summary. All-or-nothing here would
// throw away work that is perfectly usable.
test("a single bad tag does not condemn the rest of the run", () => {
  const clean = sanitizeEnrichment({
    summary: "A highlight reel from the Muqabla Tournament.",
    tags: ["basketball", "N/A"],
    category: "video",
  });

  assert.equal(isUnusableEnrichment(clean), false);
  assert.deepEqual(clean.tags, ["basketball"]);
});

test("the run that started this is unusable end to end", () => {
  const clean = sanitizeEnrichment({
    summary: "<UNKNOWN>",
    tags: ["<UNKNOWN>"],
    category: "<UNKNOWN>",
  });

  assert.equal(isUnusableEnrichment(clean), true);
});

// Tags earn a row; a summary alone does not, because a note's summary is
// generated and then never rendered.
test("a surviving summary alone is still unusable", () => {
  const clean = sanitizeEnrichment({ summary: "A real sentence.", tags: [], category: "" });
  assert.equal(isUnusableEnrichment(clean), true);
});

test("the stored row on the board reads back as unusable", () => {
  const clean = sanitizeStoredRun({
    summary: "<UNKNOWN>",
    tags: '["<UNKNOWN>"]',
    category: "<UNKNOWN>",
  });

  assert.deepEqual(clean.tags, []);
  assert.equal(clean.category, null);
  assert.equal(isUnusableEnrichment(clean), true);
});

test("a good stored row is untouched", () => {
  const clean = sanitizeStoredRun({
    summary: "A highlight reel.",
    tags: '["basketball","highlight","tournament","toronto"]',
    category: "video",
  });

  assert.deepEqual(clean.tags, ["basketball", "highlight", "tournament", "toronto"]);
  assert.equal(clean.category, "video");
  assert.equal(isUnusableEnrichment(clean), false);
});

// The write path stores "" for a dropped summary, since the column is not
// nullable. That has to read back as absent rather than as a blank summary.
test("empty strings from the write path read back as null", () => {
  const clean = sanitizeStoredRun({ summary: "", tags: '["basketball"]', category: "idea" });
  assert.equal(clean.summary, null);
  assert.deepEqual(clean.tags, ["basketball"]);
});

test("malformed tag JSON does not throw", () => {
  const clean = sanitizeStoredRun({ summary: "x", tags: "not json", category: "idea" });
  assert.deepEqual(clean.tags, []);
});
