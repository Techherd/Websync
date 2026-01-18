import { spawn } from 'child_process';
import { executeCommand } from './docker';
import path from 'path';
import prisma from './prisma';
import { isRemoteHealthy } from './healthChecker';

// Type for site data when notifying remote
interface SiteNotification {
    id: string;
    label: string;
    remotePath: string;
    siteType: string;
    siteUrl?: string | null;
    status: 'COMPLETED' | 'FAILED';
    logs?: string;
}

// Notify the remote server that a sync has completed
export const notifyRemoteOfSync = async (site: SiteNotification): Promise<boolean> => {
    console.log('[SYNC NOTIFY] Starting notification for site:', site.label);
    
    try {
        const settings = await prisma.settings.findUnique({
            where: { id: 'default' }
        });

        console.log('[SYNC NOTIFY] Settings check:', {
            hasRemoteApiUrl: !!settings?.remoteApiUrl,
            remoteApiUrl: settings?.remoteApiUrl,
            hasRemoteApiToken: !!settings?.remoteApiToken,
            tokenLength: settings?.remoteApiToken?.length
        });

        if (!settings?.remoteApiUrl || !settings?.remoteApiToken) {
            console.log('[SYNC NOTIFY] Cannot notify remote: API URL or token not configured');
            return false;
        }

        const notifyUrl = `${settings.remoteApiUrl}/received-sites/register`;
        const payload = {
            sourceServerId: site.id,
            sourceServerName: settings.serverName || 'WebSync Server',
            sourceServerUrl: settings.remoteApiUrl ? 
                `http://${settings.remoteHost?.split('@')[1]?.split(':')[0] || 'unknown'}:3000` : 
                undefined,
            label: site.label,
            localPath: site.remotePath,
            siteType: site.siteType,
            siteUrl: site.siteUrl,
            lastSyncStatus: site.status,
            lastSyncLogs: site.logs
        };

        console.log('[SYNC NOTIFY] Sending to:', notifyUrl);
        console.log('[SYNC NOTIFY] Payload:', JSON.stringify(payload, null, 2));

        const response = await fetch(notifyUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Sync-Token': settings.remoteApiToken
            },
            body: JSON.stringify(payload)
        });

        const responseText = await response.text();
        console.log('[SYNC NOTIFY] Response status:', response.status);
        console.log('[SYNC NOTIFY] Response body:', responseText);

        if (!response.ok) {
            console.error('[SYNC NOTIFY] Failed to notify remote:', responseText);
            return false;
        }

        console.log(`[SYNC NOTIFY] Successfully notified remote server of sync for site: ${site.label}`);
        return true;
    } catch (error) {
        console.error('[SYNC NOTIFY] Error notifying remote:', error);
        return false;
    }
};

// Event emitter for progress updates
type ProgressCallback = (progress: number, message: string) => void;

export type SyncDirection = 'push' | 'pull' | 'bidirectional';

export const getRemoteSettings = async () => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });
    if (!settings?.remoteHost) {
        throw new Error('Remote host not configured. Please configure settings first.');
    }
    return settings;
};

// Check if sync should proceed based on health status
export const canSync = async (): Promise<{ canSync: boolean; reason?: string }> => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });

    if (!settings?.remoteHost) {
        return { canSync: false, reason: 'Remote host not configured' };
    }

    if (settings.syncOnlyWhenHealthy) {
        const healthy = await isRemoteHealthy();
        if (!healthy) {
            return { canSync: false, reason: 'Remote server is not healthy' };
        }
    }

    return { canSync: true };
};

// Push files from local to remote
export const pushFiles = async (
    localPath: string, 
    remotePath: string, 
    onProgress?: ProgressCallback
) => {
    const settings = await getRemoteSettings();
    
    // Build rsync destination (local -> remote)
    const source = localPath;
    const dest = `${settings.remoteHost}:${remotePath}`;
    
    onProgress?.(0, 'Pushing files to remote...');
    
    const args = buildRsyncArgs(settings, source, dest);
    return runSpawnWithProgress('rsync', args, onProgress);
};

// Pull files from remote to local
export const pullFiles = async (
    localPath: string, 
    remotePath: string, 
    onProgress?: ProgressCallback
) => {
    const settings = await getRemoteSettings();
    
    // Build rsync source (remote -> local)
    const source = `${settings.remoteHost}:${remotePath}`;
    const dest = localPath;
    
    onProgress?.(0, 'Pulling files from remote...');
    
    const args = buildRsyncArgs(settings, source, dest);
    return runSpawnWithProgress('rsync', args, onProgress);
};

// Sync files based on configured direction
export const syncFiles = async (
    localPath: string, 
    remotePath: string, 
    onProgress?: ProgressCallback,
    direction?: SyncDirection
) => {
    const settings = await getRemoteSettings();
    const syncDir = direction || (settings.syncDirection as SyncDirection) || 'push';
    
    if (syncDir === 'push') {
        return pushFiles(localPath, remotePath, onProgress);
    } else if (syncDir === 'pull') {
        return pullFiles(localPath, remotePath, onProgress);
    } else if (syncDir === 'bidirectional') {
        // For bidirectional, we do a two-way sync
        // First, pull to get any remote changes (0-50%)
        onProgress?.(0, 'Syncing from remote (bidirectional)...');
        await pullFiles(localPath, remotePath, (p, m) => {
            onProgress?.(Math.floor(p * 0.5), `Pull: ${m}`);
        });
        
        // Then push local changes (50-100%)
        onProgress?.(50, 'Syncing to remote (bidirectional)...');
        await pushFiles(localPath, remotePath, (p, m) => {
            onProgress?.(50 + Math.floor(p * 0.5), `Push: ${m}`);
        });
        
        onProgress?.(100, 'Bidirectional sync complete');
        return;
    }
    
    throw new Error(`Unknown sync direction: ${syncDir}`);
};

// Build rsync arguments with SSH options
const buildRsyncArgs = (settings: any, source: string, dest: string): string[] => {
    const args = ['-avz', '--delete', '--progress'];
    
    // Add SSH options - always include to handle read-only .ssh mounts and suppress warnings
    let sshCmd = 'ssh -o StrictHostKeyChecking=no -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR';
    if (settings.remotePort !== 22) {
        sshCmd += ` -p ${settings.remotePort}`;
    }
    if (settings.sshKeyPath) {
        sshCmd += ` -i ${settings.sshKeyPath}`;
    }
    args.push('-e', sshCmd);
    
    args.push(source, dest);
    return args;
};

// Push database dump to remote
export const pushDatabase = async (
    siteLabel: string,
    dbContainer: string,
    dbType: 'mysql' | 'postgres',
    dbUser: string,
    dbPass: string,
    dbName: string,
    remotePath: string,
    onProgress?: ProgressCallback
) => {
    const dumpFile = `/tmp/${siteLabel}_${Date.now()}.sql`;
    console.log(`[DB DUMP] Starting database dump for ${siteLabel}`);
    console.log(`[DB DUMP] Container: ${dbContainer}, Type: ${dbType}, DB: ${dbName}`);

    onProgress?.(10, 'Creating database dump...');

    // 1. Dump Database - capture both stdout and stderr for debugging
    let dumpCmd: string;
    const containerDumpPath = `/tmp/dump.sql`;
    
    if (dbType === 'mysql') {
        // MariaDB uses mariadb-dump, MySQL uses mysqldump
        // Try mariadb-dump first, fall back to mysqldump
        dumpCmd = `(command -v mariadb-dump >/dev/null 2>&1 && mariadb-dump -u${dbUser} -p'${dbPass}' --single-transaction --quick ${dbName} || mysqldump -u${dbUser} -p'${dbPass}' --single-transaction --quick ${dbName})`;
    } else if (dbType === 'postgres') {
        dumpCmd = `PGPASSWORD='${dbPass}' pg_dump -U ${dbUser} ${dbName}`;
    } else {
        throw new Error('Unsupported DB Type');
    }

    // Capture both stdout (the dump) and stderr (errors) properly
    const fullDumpCmd = ['sh', '-c', `${dumpCmd} > ${containerDumpPath} 2>&1 && echo "DUMP_SUCCESS" || (cat ${containerDumpPath} && echo "DUMP_FAILED")`];
    
    console.log(`[DB DUMP] Running dump command in container...`);
    const dumpResult = await executeCommand(dbContainer, fullDumpCmd);
    console.log(`[DB DUMP] Command output: ${dumpResult.substring(0, 500)}`);
    
    if (dumpResult.includes('DUMP_FAILED') || dumpResult.includes('error') || dumpResult.includes('ERROR')) {
        console.error(`[DB DUMP] Database dump failed: ${dumpResult}`);
        throw new Error(`Database dump failed: ${dumpResult}`);
    }
    
    onProgress?.(30, 'Copying dump from container...');

    // 2. Copy dump out of container
    await runSpawn('docker', ['cp', `${dbContainer}:${containerDumpPath}`, dumpFile]);
    
    // Verify dump file size
    const fs = await import('fs');
    const stats = fs.statSync(dumpFile);
    console.log(`[DB DUMP] Dump file size: ${stats.size} bytes`);
    
    if (stats.size === 0) {
        console.error(`[DB DUMP] Dump file is empty!`);
        throw new Error('Database dump created empty file - check database credentials and connectivity');
    }
    
    onProgress?.(50, 'Cleaning up container...');

    // 3. Clean up container dump file
    await executeCommand(dbContainer, ['rm', containerDumpPath]);
    onProgress?.(60, 'Pushing database dump to remote...');

    // 4. Push dump to remote
    await pushFiles(dumpFile, path.join(remotePath, 'dumps/'), (p, m) => {
        onProgress?.(60 + Math.floor(p * 0.3), m);
    });

    // 5. Cleanup local dump
    await runSpawn('rm', [dumpFile]);
    console.log(`[DB DUMP] Database dump and push complete`);
    onProgress?.(100, 'Database push complete');
};

// Pull database dump from remote and restore
export const pullDatabase = async (
    siteLabel: string,
    dbContainer: string,
    dbType: 'mysql' | 'postgres',
    dbUser: string,
    dbPass: string,
    dbName: string,
    remotePath: string,
    onProgress?: ProgressCallback
) => {
    const dumpFile = `/tmp/${siteLabel}_restore_${Date.now()}.sql`;
    const remoteDumpPath = path.join(remotePath, 'dumps/');

    onProgress?.(10, 'Pulling database dump from remote...');

    // 1. Pull the dump file from remote
    await pullFiles(dumpFile, remoteDumpPath, (p, m) => {
        onProgress?.(10 + Math.floor(p * 0.3), m);
    });

    onProgress?.(50, 'Copying dump to container...');

    // 2. Copy dump into container
    const containerDumpPath = `/tmp/restore.sql`;
    await runSpawn('docker', ['cp', dumpFile, `${dbContainer}:${containerDumpPath}`]);

    onProgress?.(70, 'Restoring database...');

    // 3. Restore Database
    let restoreCmd: string[] = [];
    if (dbType === 'mysql') {
        restoreCmd = ['sh', '-c', `mysql -u ${dbUser} -p${dbPass} ${dbName} < ${containerDumpPath}`];
    } else if (dbType === 'postgres') {
        restoreCmd = ['sh', '-c', `psql -U ${dbUser} -d ${dbName} < ${containerDumpPath}`];
    }

    if (restoreCmd.length === 0) throw new Error('Unsupported DB Type');

    await executeCommand(dbContainer, restoreCmd);

    // 4. Cleanup
    await executeCommand(dbContainer, ['rm', containerDumpPath]);
    await runSpawn('rm', [dumpFile]);

    onProgress?.(100, 'Database restore complete');
};

// Sync database based on direction
export const syncDatabase = async (
    siteLabel: string,
    dbContainer: string,
    dbType: 'mysql' | 'postgres',
    dbUser: string,
    dbPass: string,
    dbName: string,
    remotePath: string,
    onProgress?: ProgressCallback,
    direction?: SyncDirection
) => {
    const settings = await getRemoteSettings();
    const syncDir = direction || (settings.syncDirection as SyncDirection) || 'push';

    if (syncDir === 'push') {
        return pushDatabase(siteLabel, dbContainer, dbType, dbUser, dbPass, dbName, remotePath, onProgress);
    } else if (syncDir === 'pull') {
        return pullDatabase(siteLabel, dbContainer, dbType, dbUser, dbPass, dbName, remotePath, onProgress);
    } else if (syncDir === 'bidirectional') {
        // For bidirectional DB, only push (pulling would overwrite local changes)
        // In a real scenario, you'd want DB replication, not file sync
        onProgress?.(0, 'Syncing database (push only for safety)...');
        return pushDatabase(siteLabel, dbContainer, dbType, dbUser, dbPass, dbName, remotePath, onProgress);
    }
    
    throw new Error(`Unknown sync direction: ${syncDir}`);
};

const runSpawn = (cmd: string, args: string[]): Promise<void> => {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);

        proc.stdout.on('data', (data) => console.log(`[${cmd}] ${data}`));
        proc.stderr.on('data', (data) => console.error(`[${cmd}] ${data}`));

        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
};

const runSpawnWithProgress = (
    cmd: string, 
    args: string[],
    onProgress?: ProgressCallback
): Promise<void> => {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args);
        let lastProgress = 0;

        proc.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[${cmd}] ${output}`);
            
            // Parse rsync progress (e.g., "  1,234,567 100%   12.34MB/s")
            const progressMatch = output.match(/(\d+)%/);
            if (progressMatch && onProgress) {
                const progress = parseInt(progressMatch[1], 10);
                if (progress > lastProgress) {
                    lastProgress = progress;
                    onProgress(progress, `Syncing files... ${progress}%`);
                }
            }
        });

        proc.stderr.on('data', (data) => console.error(`[${cmd}] ${data}`));

        proc.on('close', (code) => {
            if (code === 0) {
                onProgress?.(100, 'Sync complete');
                resolve();
            } else {
                reject(new Error(`${cmd} exited with code ${code}`));
            }
        });
    });
};
