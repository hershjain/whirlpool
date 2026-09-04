-- AlterTable
ALTER TABLE "Item" ADD COLUMN "author" TEXT;
ALTER TABLE "Item" ADD COLUMN "siteName" TEXT;

-- CreateTable
CREATE TABLE "SourceProfile" (
    "hostname" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "textColor" TEXT NOT NULL,
    "iconBase64" TEXT,
    "iconMime" TEXT,
    "colorSource" TEXT NOT NULL,
    "fetchFailed" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
