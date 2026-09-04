-- AlterTable
ALTER TABLE "Item" ADD COLUMN "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "SiteProfile" (
    "domain" TEXT NOT NULL PRIMARY KEY,
    "faviconDataUri" TEXT,
    "accentColor" TEXT,
    "colorSource" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
