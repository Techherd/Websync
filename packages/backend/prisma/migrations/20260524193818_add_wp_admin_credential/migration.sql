-- CreateTable
CREATE TABLE "WpAdminCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "lastRotated" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WpAdminCredential_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReceivedSite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceServerId" TEXT NOT NULL,
    "sourceServerName" TEXT NOT NULL,
    "sourceServerUrl" TEXT,
    "label" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "siteType" TEXT NOT NULL DEFAULT 'custom',
    "siteUrl" TEXT,
    "lastSyncAt" DATETIME,
    "lastSyncStatus" TEXT,
    "lastSyncLogs" TEXT,
    "filesCount" INTEGER,
    "totalSize" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "WpAdminCredential_siteId_key" ON "WpAdminCredential"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivedSite_sourceServerId_key" ON "ReceivedSite"("sourceServerId");
