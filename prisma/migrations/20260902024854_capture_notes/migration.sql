-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rawUrl" TEXT,
    "title" TEXT,
    "rawText" TEXT NOT NULL,
    "extractedText" TEXT,
    "contentFidelity" TEXT NOT NULL,
    "messageSid" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Item" ("contentFidelity", "createdAt", "extractedText", "id", "messageSid", "phone", "rawText", "rawUrl", "title", "type") SELECT "contentFidelity", "createdAt", "extractedText", "id", "messageSid", "phone", "rawText", "rawUrl", "title", "type" FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
CREATE UNIQUE INDEX "Item_messageSid_key" ON "Item"("messageSid");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
