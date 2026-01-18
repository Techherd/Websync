-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "serverName" TEXT NOT NULL DEFAULT 'Primary',
    "serverRole" TEXT NOT NULL DEFAULT 'primary',
    "remoteHost" TEXT NOT NULL,
    "remotePort" INTEGER NOT NULL DEFAULT 22,
    "sshKeyPath" TEXT,
    "remoteApiUrl" TEXT,
    "remoteApiToken" TEXT,
    "syncDirection" TEXT NOT NULL DEFAULT 'push',
    "syncOnlyWhenHealthy" BOOLEAN NOT NULL DEFAULT true,
    "healthCheckInterval" INTEGER NOT NULL DEFAULT 30,
    "lastHealthCheck" DATETIME,
    "remoteHealthy" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("createdAt", "id", "remoteHost", "remotePort", "sshKeyPath", "updatedAt") SELECT "createdAt", "id", "remoteHost", "remotePort", "sshKeyPath", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
