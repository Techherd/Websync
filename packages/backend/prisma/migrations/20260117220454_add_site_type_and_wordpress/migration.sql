-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "remotePath" TEXT NOT NULL,
    "siteType" TEXT NOT NULL DEFAULT 'custom',
    "wpContainer" TEXT,
    "wpPath" TEXT,
    "editorUrl" TEXT,
    "siteUrl" TEXT,
    "wpAdminUrl" TEXT,
    "dockerContainers" TEXT,
    "dbContainer" TEXT,
    "dbType" TEXT,
    "dbUser" TEXT,
    "dbPassword" TEXT,
    "dbName" TEXT,
    "remoteContainers" TEXT,
    "autoStartRemote" BOOLEAN NOT NULL DEFAULT false,
    "remoteDbContainer" TEXT,
    "remoteDbUser" TEXT,
    "remoteDbPassword" TEXT,
    "remoteDbName" TEXT,
    "schedule" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Site" ("autoStartRemote", "createdAt", "dbContainer", "dbName", "dbPassword", "dbType", "dbUser", "dockerContainers", "editorUrl", "id", "label", "localPath", "remoteContainers", "remoteDbContainer", "remoteDbName", "remoteDbPassword", "remoteDbUser", "remotePath", "schedule", "siteUrl", "updatedAt") SELECT "autoStartRemote", "createdAt", "dbContainer", "dbName", "dbPassword", "dbType", "dbUser", "dockerContainers", "editorUrl", "id", "label", "localPath", "remoteContainers", "remoteDbContainer", "remoteDbName", "remoteDbPassword", "remoteDbUser", "remotePath", "schedule", "siteUrl", "updatedAt" FROM "Site";
DROP TABLE "Site";
ALTER TABLE "new_Site" RENAME TO "Site";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
