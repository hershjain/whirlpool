-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "rawUrl" TEXT,
    "title" TEXT,
    "author" TEXT,
    "siteName" TEXT,
    "imageUrl" TEXT,
    "rawText" TEXT NOT NULL,
    "extractedText" TEXT,
    "contentFidelity" TEXT NOT NULL,
    "linkStatus" INTEGER,
    "messageSid" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canvasX" REAL,
    "canvasY" REAL,
    "folderId" TEXT,
    CONSTRAINT "Item_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Item" ("author", "canvasX", "canvasY", "contentFidelity", "createdAt", "extractedText", "id", "imageUrl", "linkStatus", "messageSid", "phone", "rawText", "rawUrl", "siteName", "title", "type") SELECT "author", "canvasX", "canvasY", "contentFidelity", "createdAt", "extractedText", "id", "imageUrl", "linkStatus", "messageSid", "phone", "rawText", "rawUrl", "siteName", "title", "type" FROM "Item";
DROP TABLE "Item";
ALTER TABLE "new_Item" RENAME TO "Item";
CREATE UNIQUE INDEX "Item_messageSid_key" ON "Item"("messageSid");
CREATE INDEX "Item_folderId_idx" ON "Item"("folderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Folder_phone_idx" ON "Folder"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_phone_name_key" ON "Folder"("phone", "name");
