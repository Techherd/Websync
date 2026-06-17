-- CreateTable
CREATE TABLE "ScanAllowlist" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "category" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ScanAllowlist_category_path_key" ON "ScanAllowlist"("category", "path");
