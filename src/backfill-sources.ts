// One-off script: warms SourceProfile for every hostname already saved, so
// the first canvas load after this ships isn't a wall of neutral headers.
// Safe to re-run - resolveSourceProfileForCapture is a no-op for any
// hostname whose cached profile is still fresh.
import { prisma } from "./db.js";
import { resolveSourceProfileForCapture } from "./sourceProfile.js";

async function main() {
  const items = await prisma.item.findMany({
    where: { rawUrl: { not: null } },
    select: { rawUrl: true },
  });

  // One representative URL per hostname - resolveSourceProfileForCapture
  // caches by hostname, so resolving twice for the same one is wasted work.
  const urlByHostname = new Map<string, string>();
  for (const { rawUrl } of items) {
    if (!rawUrl) continue;
    try {
      urlByHostname.set(new URL(rawUrl).hostname, rawUrl);
    } catch {
      // malformed URL slipped through capture - nothing to resolve
    }
  }

  console.log(`Resolving source profiles for ${urlByHostname.size} hostname(s)...`);

  for (const rawUrl of urlByHostname.values()) {
    const profile = await resolveSourceProfileForCapture(rawUrl);
    if (profile) {
      console.log(`  ${profile.hostname} -> ${profile.name} (${profile.color}, via ${profile.colorSource})`);
    }
  }

  console.log("Done.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
