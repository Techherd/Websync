-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Site" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "remotePath" TEXT NOT NULL,
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
INSERT INTO "new_Site" ("createdAt", "dbContainer", "dbName", "dbPassword", "dbType", "dbUser", "dockerContainers", "id", "label", "localPath", "remotePath", "schedule", "updatedAt") SELECT "createdAt", "dbContainer", "dbName", "dbPassword", "dbType", "dbUser", "dockerContainers", "id", "label", "localPath", "remotePath", "schedule", "updatedAt" FROM "Site";
DROP TABLE "Site";
ALTER TABLE "new_Site" RENAME TO "Site";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
