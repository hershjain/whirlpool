// One-off script: warms SourceProfile for every hostname already saved, so
// the first canvas load after this ships isn't a wall of neutral headers.
// Safe to re-run - a hostname whose cached profile is still fresh is skipped.
// The server runs the same sweep on startup, so this is only needed to force
// a fill-in without a restart.
import { prisma } from "./db.js";
import { resolveMissingSourceProfiles } from "./sourceProfile.js";

async function main() {
  console.log("Resolving source profiles for hostnames without a fresh one...");
  const resolved = await resolveMissingSourceProfiles();
  console.log(`Done - ${resolved} resolved.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
