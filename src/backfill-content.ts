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
//
// The flip side: this can't *clear* a stale value. A row saved as
// title="Reddit" before the Reddit branch existed gets corrected here because
// re-extraction now returns a real title; but a JS-shell site with no branch
// yet (bsky.app) would keep its old "Bluesky" title, since the fresh
// extraction's title is null and null is never written.
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
  }
  // Move fidelity forward on any non-failed re-extraction, not only one that
  // brought text: a Reddit/Spotify capture is "metadata_only" with a title and
  // image but no body, and leaving it marked "failed" would misdescribe a row
  // that now previews fine. A fresh "failed" is never written back, so a good
  // capture that has since broken keeps its old, better fidelity.
  if (extraction.contentFidelity !== "failed") {
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
