// One-off script: re-extracts every saved link so cards can show what they're
// actually about. Items captured before og:image extraction existed have no
// imageUrl at all, and anything saved while a site was blocking us (or before
// the TikTok oEmbed path existed) has a placeholder title and no text.
//
// Deliberately not run on startup, unlike the source-profile sweep: that one
// costs a single page fetch per *hostname* and fills a gap that recurs, while
// this refetches every *item* and is a one-time correction. New captures
// already populate these fields at save time.
import { prisma } from "./db.js";
import { extractFromUrl } from "./linkExtract.js";

// Only ever fill in or improve - a re-extraction that comes back empty must
// not wipe good data captured when the page still resolved. One of these
// tweets has since been deleted and now 404s.
function fieldsToUpdate(
  extraction: Awaited<ReturnType<typeof extractFromUrl>>,
): Record<string, string | number> {
  const updates: Record<string, string | number> = {};
  // Recorded even when everything else came back empty - a 404 is exactly the
  // case where there's nothing to store but plenty worth knowing.
  if (extraction.httpStatus !== null) updates.linkStatus = extraction.httpStatus;
  if (extraction.title) updates.title = extraction.title;
  if (extraction.author) updates.author = extraction.author;
  if (extraction.siteName) updates.siteName = extraction.siteName;
  if (extraction.imageUrl) updates.imageUrl = extraction.imageUrl;
  if (extraction.extractedText) {
    updates.extractedText = extraction.extractedText;
    // Fidelity describes the text we just stored, so it only moves when the
    // text does - never downgrade a good capture to "failed".
    updates.contentFidelity = extraction.contentFidelity;
  }
  return updates;
}

async function main() {
  const items = await prisma.item.findMany({
    where: { type: "link", rawUrl: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Re-extracting ${items.length} link(s)...`);
  let updated = 0;
  let unchanged = 0;

  for (const item of items) {
    if (!item.rawUrl) continue;

    let updates: Record<string, string | number>;
    try {
      updates = fieldsToUpdate(await extractFromUrl(item.rawUrl));
    } catch (error) {
      console.error(`  ! ${item.rawUrl.slice(0, 60)} - ${String(error)}`);
      unchanged++;
      continue;
    }

    if (Object.keys(updates).length === 0) {
      unchanged++;
      continue;
    }

    await prisma.item.update({ where: { id: item.id }, data: updates });
    updated++;
    const gained = updates.imageUrl && !item.imageUrl ? " +image" : "";
    console.log(`  ${item.rawUrl.slice(0, 58)}${gained}`);
  }

  console.log(`Done - ${updated} updated, ${unchanged} left as they were.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
