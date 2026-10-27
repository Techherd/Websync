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
    "provisioned" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Site" ("autoStartRemote", "createdAt", "dbContainer", "dbName", "dbPassword", "dbType", "dbUser", "dockerContainers", "editorUrl", "id", "label", "localPath", "remoteContainers", "remoteDbContainer", "remoteDbName", "remoteDbPassword", "remoteDbUser", "remotePath", "schedule", "siteType", "siteUrl", "updatedAt", "wpAdminUrl", "wpContainer", "wpPath") SELECT "autoStartRemote", "createdAt", "dbContainer", "dbName", "dbPassword", "dbType", "dbUser", "dockerContainers", "editorUrl", "id", "label", "localPath", "remoteContainers", "remoteDbContainer", "remoteDbName", "remoteDbPassword", "remoteDbUser", "remotePath", "schedule", "siteType", "siteUrl", "updatedAt", "wpAdminUrl", "wpContainer", "wpPath" FROM "Site";
DROP TABLE "Site";
ALTER TABLE "new_Site" RENAME TO "Site";
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "siteId" TEXT,
    "label" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "logs" TEXT,
    "progress" INTEGER,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "Job_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("endedAt", "id", "logs", "progress", "siteId", "startedAt", "status", "type") SELECT "endedAt", "id", "logs", "progress", "siteId", "startedAt", "status", "type" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
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
    "hideBranding" BOOLEAN NOT NULL DEFAULT false,
    "provisionSitesRoot" TEXT NOT NULL DEFAULT '/mnt/user/appdata/websites',
    "provisionWebPortStart" INTEGER NOT NULL DEFAULT 8100,
    "provisionHostIp" TEXT,
    "wordpressImage" TEXT NOT NULL DEFAULT 'althe3rd/wordpress-with-cli:latest',
    "staticImage" TEXT NOT NULL DEFAULT 'nginx:alpine',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Settings" ("createdAt", "healthCheckInterval", "hideBranding", "id", "lastHealthCheck", "remoteApiToken", "remoteApiUrl", "remoteHealthy", "remoteHost", "remotePort", "serverName", "serverRole", "sshKeyPath", "syncDirection", "syncOnlyWhenHealthy", "updatedAt") SELECT "createdAt", "healthCheckInterval", "hideBranding", "id", "lastHealthCheck", "remoteApiToken", "remoteApiUrl", "remoteHealthy", "remoteHost", "remotePort", "serverName", "serverRole", "sshKeyPath", "syncDirection", "syncOnlyWhenHealthy", "updatedAt" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

