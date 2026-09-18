// One-off script: generates summary + tags + category for items that have text
// but no EnrichmentRun. Enrichment runs once at capture time and is skipped
// when extraction fails, so everything saved while a site was blocking us
// (Instagram, TikTok, are.na) ended up untagged. Fixing the text afterwards
// via backfill:content didn't retroactively enrich it - this does.
//
// Covers both links and notes. A note's summary is generated but never
// rendered on the canvas - the tags and category it produces are the point,
// since they're what put a note in the filter bar. See handleSaveNote in
// commands.ts.
//
// Not run on startup - it costs one LLM call per item.
import { prisma } from "./db.js";
import { enrichLink, enrichNote, enrichmentInput } from "./anthropic.js";

async function main() {
  const items = await prisma.item.findMany({
    // Not filtered on extractedText: an image block with a real title can
    // still be tagged from it. enrichmentInput decides what is usable.
    where: { enrichmentRuns: { none: {} } },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Enriching ${items.length} item(s) with no tags...`);
  let enriched = 0;

  for (const item of items) {
    // A note is always its own full text; a link may have to fall back to its
    // title when the page gave us no body (an are.na image block).
    const isNote = item.type === "note";
    const input = isNote ? item.rawText.trim() : enrichmentInput(item.extractedText, item.title);
    const label = isNote ? `note: ${item.rawText.slice(0, 40)}` : (item.rawUrl ?? item.id).slice(0, 56);

    if (!input) {
      console.log(`  - ${label} (nothing to enrich from)`);
      continue;
    }

    try {
      const enrichment = isNote ? await enrichNote(input) : await enrichLink(input);
      if (!enrichment) {
        console.log(`  - ${label} (model returned nothing usable)`);
        continue;
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
      enriched++;
      console.log(`  ${label} -> ${enrichment.tags.join(", ")}`);
    } catch (error) {
      // One bad item must not strand the rest half-done.
      console.error(`  ! ${label} - ${String(error)}`);
    }
  }

  console.log(`Done - ${enriched} enriched.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
