-- CreateTable
CREATE TABLE "SiteHealth" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "httpStatus" INTEGER,
    "responseMs" INTEGER,
    "sslExpiresAt" DATETIME,
    "error" TEXT,
    "lastCheckedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SiteHealth_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteHealth_siteId_key" ON "SiteHealth"("siteId");
