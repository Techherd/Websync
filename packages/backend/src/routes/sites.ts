import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { syncFiles, syncDatabase, canSync, SyncDirection, notifyRemoteOfSync } from '../lib/sync';
import prisma from '../lib/prisma';
import { refreshScheduler } from '../lib/scheduler';
import { broadcastJobUpdate } from '../lib/websocket';
import { generateWpAdmin, deleteWpAdmin, generateMagicLoginUrl, executeCommand } from '../lib/docker';
import { encrypt, decrypt } from '../lib/crypto';
import { logAudit } from '../lib/audit';
import { runHealthCheckCycle } from '../lib/healthMonitor';
import { 
    startRemoteContainers, 
    stopRemoteContainers, 
    restartRemoteContainers,
    getRemoteContainerStatus,
    listRemoteContainers,
    importRemoteDatabase
} from '../lib/remoteDocker';

const SiteSchema = z.object({
    label: z.string().min(1, 'Label is required'),
    localPath: z.string().min(1, 'Local path is required'),
    remotePath: z.string().min(1, 'Remote path is required'),
    // Site type
    siteType: z.enum(['wordpress', 'laravel', 'static', 'node', 'custom']).optional(),
    // WordPress-specific
    wpContainer: z.string().nullish(),
    wpPath: z.string().nullish(),
    wpAdminUrl: z.string().url().nullish().or(z.literal('')),
    // Quick links
    editorUrl: z.string().url().nullish().or(z.literal('')),
    siteUrl: z.string().url().nullish().or(z.literal('')),
    // Local containers
    dockerContainers: z.string().nullish(),
    dbContainer: z.string().nullish(),
    dbType: z.enum(['mysql', 'postgres']).nullish(),
    dbUser: z.string().nullish(),
    dbPassword: z.string().nullish(),
    dbName: z.string().nullish(),
    // Remote container management
    remoteContainers: z.string().nullish(),
    autoStartRemote: z.boolean().optional(),
    // Remote database import
    remoteDbContainer: z.string().nullish(),
    remoteDbUser: z.string().nullish(),
    remoteDbPassword: z.string().nullish(),
    remoteDbName: z.string().nullish(),
    schedule: z.string().nullish(),
});

export default async function siteRoutes(server: FastifyInstance) {
    // List all sites
    server.get('/sites', async () => {
        return prisma.site.findMany({
            include: {
                jobs: {
                    orderBy: { startedAt: 'desc' },
                    take: 1
                },
                health: true
            }
        });
    });

    // Get single site
    server.get('/sites/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({
            where: { id },
            include: {
                jobs: {
                    orderBy: { startedAt: 'desc' },
                    take: 10
                },
                health: true
            }
        });
        if (!site) return reply.status(404).send({ error: 'Site not found' });
        return site;
    });

    // Create site
    server.post('/sites', async (request, reply) => {
        const body = SiteSchema.parse(request.body);
        const site = await prisma.site.create({ data: body });
        await refreshScheduler();
        await logAudit(request, 'site.create', site.id, { label: site.label });
        return site;
    });

    // Update site
    server.put('/sites/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = SiteSchema.partial().parse(request.body);

        const existing = await prisma.site.findUnique({ where: { id } });
        if (!existing) return reply.status(404).send({ error: 'Site not found' });

        const site = await prisma.site.update({
            where: { id },
            data: body
        });

        // Refresh scheduler if schedule changed
        if (body.schedule !== undefined) {
            await refreshScheduler();
        }

        await logAudit(request, 'site.update', site.id, { fields: Object.keys(body) });
        return site;
    });

    // Delete site
    server.delete('/sites/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        const existing = await prisma.site.findUnique({ where: { id } });
        if (!existing) return reply.status(404).send({ error: 'Site not found' });

        await prisma.site.delete({ where: { id } });
        await refreshScheduler();
        await logAudit(request, 'site.delete', id, { label: existing.label });
        return { success: true };
    });

    // Trigger manual sync
    server.post('/sites/:id/sync', async (request, reply) => {
        const { id } = request.params as { id: string };
        const { direction, force } = (request.body || {}) as { direction?: SyncDirection; force?: boolean };
        
        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        // Check if sync is allowed (health check)
        if (!force) {
            const syncCheck = await canSync();
            if (!syncCheck.canSync) {
                return reply.status(503).send({ 
                    error: 'Sync not available', 
                    reason: syncCheck.reason 
                });
            }
        }

        // Create Job
        const job = await prisma.job.create({
            data: {
                siteId: site.id,
                type: direction ? `MANUAL_${direction.toUpperCase()}` : 'FULL_SYNC',
                status: 'RUNNING',
                progress: 0
            }
        });

        broadcastJobUpdate({
            type: 'job:started',
            job
        });

        await logAudit(request, 'site.sync', site.id, { jobId: job.id, direction: direction || 'default', force: !!force });

        // Run Sync in Background
        (async () => {
            try {
                // File sync (0-50% progress)
                await syncFiles(site.localPath, site.remotePath, async (progress, message) => {
                    const scaledProgress = Math.floor(progress * 0.5);
                    await prisma.job.update({
                        where: { id: job.id },
                        data: { progress: scaledProgress }
                    });
                    broadcastJobUpdate({
                        type: 'job:progress',
                        jobId: job.id,
                        progress: scaledProgress,
                        message
                    });
                }, direction);

                // Database sync (50-100% progress)
                if (site.dbContainer && site.dbType) {
                    await syncDatabase(
                        site.label,
                        site.dbContainer,
                        site.dbType as 'mysql' | 'postgres',
                        site.dbUser || '',
                        site.dbPassword || '',
                        site.dbName || '',
                        site.remotePath,
                        async (progress, message) => {
                            const scaledProgress = 50 + Math.floor(progress * 0.5);
                            await prisma.job.update({
                                where: { id: job.id },
                                data: { progress: scaledProgress }
                            });
                            broadcastJobUpdate({
                                type: 'job:progress',
                                jobId: job.id,
                                progress: scaledProgress,
                                message
                            });
                        },
                        direction
                    );
                }

                // Auto-start remote containers if configured
                if (site.autoStartRemote && site.remoteContainers) {
                    const containers = site.remoteContainers.split(',').map(c => c.trim()).filter(Boolean);
                    if (containers.length > 0) {
                        console.log(`Auto-starting remote containers: ${containers.join(', ')}`);
                        await startRemoteContainers(containers);
                    }
                }

                // Import database on remote if configured
                if (site.remoteDbContainer && site.dbType && site.remoteDbUser && site.remoteDbName) {
                    const dumpPath = `${site.remotePath}/dumps/*.sql`;
                    console.log(`[SYNC] Importing database on remote: ${site.remoteDbContainer}`);
                    console.log(`[SYNC] Remote DB settings:`, {
                        container: site.remoteDbContainer,
                        dbType: site.dbType,
                        dbUser: site.remoteDbUser,
                        dbName: site.remoteDbName,
                        dumpPath
                    });
                    
                    const importResult = await importRemoteDatabase(
                        site.remoteDbContainer,
                        site.dbType as 'mysql' | 'postgres',
                        site.remoteDbUser,
                        site.remoteDbPassword || '',
                        site.remoteDbName,
                        dumpPath
                    );
                    
                    if (!importResult.success) {
                        console.error(`[SYNC] Remote DB import failed:`, importResult.error);
                        // Don't fail the whole sync, just log the error
                    } else {
                        console.log(`[SYNC] Remote DB import successful`);
                    }
                } else {
                    console.log(`[SYNC] Skipping remote DB import - not configured:`, {
                        hasRemoteDbContainer: !!site.remoteDbContainer,
                        hasDbType: !!site.dbType,
                        hasRemoteDbUser: !!site.remoteDbUser,
                        hasRemoteDbName: !!site.remoteDbName
                    });
                }

                const completedJob = await prisma.job.update({
                    where: { id: job.id },
                    data: { status: 'COMPLETED', endedAt: new Date(), progress: 100 }
                });

                broadcastJobUpdate({
                    type: 'job:completed',
                    job: completedJob
                });

                // Notify remote server of successful sync (for received sites display)
                await notifyRemoteOfSync({
                    id: site.id,
                    label: site.label,
                    remotePath: site.remotePath,
                    siteType: site.siteType,
                    siteUrl: site.siteUrl,
                    status: 'COMPLETED'
                });
            } catch (err) {
                console.error(err);
                const failedJob = await prisma.job.update({
                    where: { id: job.id },
                    data: {
                        status: 'FAILED',
                        endedAt: new Date(),
                        logs: String(err)
                    }
                });

                broadcastJobUpdate({
                    type: 'job:failed',
                    job: failedJob,
                    error: String(err)
                });

                // Notify remote server of failed sync
                await notifyRemoteOfSync({
                    id: site.id,
                    label: site.label,
                    remotePath: site.remotePath,
                    siteType: site.siteType,
                    siteUrl: site.siteUrl,
                    status: 'FAILED',
                    logs: String(err)
                });
            }
        })();

        return job;
    });

    // Get remote container status for a site
    server.get('/sites/:id/remote-containers', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        if (!site.remoteContainers) {
            return { containers: [], message: 'No remote containers configured' };
        }

        const containers = site.remoteContainers.split(',').map(c => c.trim()).filter(Boolean);
        return getRemoteContainerStatus(containers);
    });

    // Start remote containers for a site
    server.post('/sites/:id/remote-containers/start', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        if (!site.remoteContainers) {
            return reply.status(400).send({ 
                error: 'No remote containers configured',
                detail: `Site "${site.label}" (${id}) has no remoteContainers value in database. Edit and re-save the site.`
            });
        }

        const containers = site.remoteContainers.split(',').map(c => c.trim()).filter(Boolean);
        return startRemoteContainers(containers);
    });

    // Stop remote containers for a site
    server.post('/sites/:id/remote-containers/stop', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        if (!site.remoteContainers) {
            return reply.status(400).send({ 
                error: 'No remote containers configured',
                detail: `Site "${site.label}" (${id}) has no remoteContainers value in database. Edit and re-save the site.`
            });
        }

        const containers = site.remoteContainers.split(',').map(c => c.trim()).filter(Boolean);
        return stopRemoteContainers(containers);
    });

    // Restart remote containers for a site
    server.post('/sites/:id/remote-containers/restart', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        if (!site.remoteContainers) {
            return reply.status(400).send({ 
                error: 'No remote containers configured',
                detail: `Site "${site.label}" (${id}) has no remoteContainers value in database. Edit and re-save the site.`
            });
        }

        const containers = site.remoteContainers.split(',').map(c => c.trim()).filter(Boolean);
        return restartRemoteContainers(containers);
    });

    // List all containers on remote server (for discovery)
    server.get('/remote-containers', async () => {
        return listRemoteContainers();
    });

    // Manually trigger a health-check cycle for all sites (fire and forget).
    // Results are persisted and broadcast via WebSocket.
    server.post('/sites/health/recheck', async () => {
        runHealthCheckCycle().catch(err => console.error('[HEALTH] manual recheck failed', err));
        return { success: true };
    });

    // ==========================================
    // WordPress Admin Generation
    // ==========================================

    const buildWpAdminUrl = (site: { wpAdminUrl: string | null; siteUrl: string | null }) =>
        site.wpAdminUrl || (site.siteUrl ? `${site.siteUrl.replace(/\/+$/, '')}/wp-admin` : undefined);

    // Retrieve stored WP admin credentials for a site
    server.get('/sites/:id/wp-admin', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({
            where: { id },
            include: { wpCredential: true }
        });
        if (!site) return reply.status(404).send({ error: 'Site not found' });
        if (!site.wpCredential) {
            return reply.status(404).send({ error: 'No stored credentials yet — create one to begin.' });
        }
        return {
            username: site.wpCredential.username,
            password: decrypt(site.wpCredential.password),
            lastRotated: site.wpCredential.lastRotated,
            loginUrl: buildWpAdminUrl(site)
        };
    });

    // Create or rotate the persistent WP admin user and store its password
    server.post('/sites/:id/wp-admin', async (request, reply) => {
        const { id } = request.params as { id: string };

        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        if (site.siteType !== 'wordpress') {
            return reply.status(400).send({ error: 'Site is not a WordPress site' });
        }
        if (!site.wpContainer) {
            return reply.status(400).send({
                error: 'WordPress container not configured. Set wpContainer in site settings.'
            });
        }

        console.log(`Rotating WP admin for site ${site.label}, container: ${site.wpContainer}`);
        const result = await generateWpAdmin(site.wpContainer, site.wpPath || '/var/www/html');

        if (!result.success || !result.username || !result.password) {
            return reply.status(500).send({ error: result.error, debug: result.debug });
        }

        await prisma.wpAdminCredential.upsert({
            where: { siteId: site.id },
            create: {
                siteId: site.id,
                username: result.username,
                password: encrypt(result.password)
            },
            update: {
                username: result.username,
                password: encrypt(result.password),
                lastRotated: new Date()
            }
        });

        await logAudit(request, 'wp.rotatePassword', site.id, { username: result.username, reused: !!result.reused });

        return {
            success: true,
            username: result.username,
            password: result.password,
            reused: result.reused,
            loginUrl: buildWpAdminUrl(site),
            message: result.reused ? 'Password rotated for existing WebSync admin.' : 'WebSync admin created.'
        };
    });

    // Generate a one-time magic login URL for the stored WP admin.
    // If no stored credential exists yet (and no websync_admin user in WP),
    // bootstrap one transparently so the first click "just works".
    server.post('/sites/:id/wp-admin/login', async (request, reply) => {
        const { id } = request.params as { id: string };
        const site = await prisma.site.findUnique({
            where: { id },
            include: { wpCredential: true }
        });
        if (!site) return reply.status(404).send({ error: 'Site not found' });
        if (!site.wpContainer) {
            return reply.status(400).send({ error: 'WordPress container not configured.' });
        }

        let username = site.wpCredential?.username || 'websync_admin';
        const wpPath = site.wpPath || '/var/www/html';

        // Verify the stored username actually exists in WP — guards against drift
        // from earlier defaults (e.g. legacy `websync_admin_<suffix>` users that
        // were never recorded in our DB).
        let needsRediscover = !site.wpCredential;
        if (site.wpContainer && site.wpCredential) {
            try {
                const check = await executeCommand(site.wpContainer, [
                    'sh', '-c',
                    `cd ${wpPath} && wp user get "${username}" --field=ID --allow-root 2>/dev/null || echo "missing"`
                ]);
                if (!/^\d+$/.test(check.trim())) {
                    needsRediscover = true;
                }
            } catch {
                needsRediscover = true;
            }
        }

        if (needsRediscover) {
            const created = await generateWpAdmin(site.wpContainer, wpPath);
            if (!created.success || !created.username || !created.password) {
                return reply.status(500).send({ error: created.error, debug: created.debug });
            }
            username = created.username;
            await prisma.wpAdminCredential.upsert({
                where: { siteId: site.id },
                create: {
                    siteId: site.id,
                    username: created.username,
                    password: encrypt(created.password)
                },
                update: {
                    username: created.username,
                    password: encrypt(created.password),
                    lastRotated: new Date()
                }
            });
            await logAudit(request, 'wp.rotatePassword', site.id, { username, autoCreated: !site.wpCredential });
        }

        const result = await generateMagicLoginUrl(site.wpContainer, username, wpPath);
        if (!result.success || !result.url) {
            return reply.status(500).send({ error: result.error, debug: result.debug });
        }
        await logAudit(request, 'wp.login', site.id, { username });
        return { success: true, url: result.url, username };
    });

    // Delete a WordPress admin user manually (also clears stored credential)
    server.delete('/sites/:id/wp-admin/:username', async (request, reply) => {
        const { id, username } = request.params as { id: string; username: string };

        const site = await prisma.site.findUnique({ where: { id } });
        if (!site) return reply.status(404).send({ error: 'Site not found' });

        if (!site.wpContainer) {
            return reply.status(400).send({ error: 'WordPress container not configured' });
        }

        // Safety check - only allow deleting websync-created users
        if (!username.startsWith('websync_admin')) {
            return reply.status(400).send({
                error: 'Can only delete WebSync-created admin users (websync_admin*)'
            });
        }

        const result = await deleteWpAdmin(
            site.wpContainer,
            username,
            site.wpPath || '/var/www/html'
        );

        if (!result.success) {
            return reply.status(500).send({ error: result.error });
        }

        await prisma.wpAdminCredential.deleteMany({ where: { siteId: site.id, username } });

        return { success: true, message: `User ${username} deleted` };
    });
}
