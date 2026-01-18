import cron, { ScheduledTask } from 'node-cron';
import { syncFiles, syncDatabase, canSync, notifyRemoteOfSync } from './sync';
import prisma from './prisma';
import { broadcastJobUpdate } from './websocket';
import { startRemoteContainers, importRemoteDatabase } from './remoteDocker';

const activeJobs: Map<string, ScheduledTask> = new Map();

export const refreshScheduler = async () => {
    console.log('[SCHEDULER] Refreshing scheduler...');

    // Stop all existing jobs
    activeJobs.forEach(job => job.stop());
    activeJobs.clear();

    const sites = await prisma.site.findMany({
        where: {
            schedule: { not: null }
        }
    });

    console.log(`[SCHEDULER] Found ${sites.length} sites with schedules`);

    for (const site of sites) {
        if (!site.schedule) continue;

        // Validate cron expression
        if (!cron.validate(site.schedule)) {
            console.error(`[SCHEDULER] Invalid cron expression for ${site.label}: ${site.schedule}`);
            continue;
        }

        console.log(`[SCHEDULER] Scheduling site "${site.label}" with cron: ${site.schedule}`);

        const task = cron.schedule(site.schedule, async () => {
            console.log(`[SCHEDULER] Running scheduled sync for "${site.label}" at ${new Date().toISOString()}`);
            
            // Re-fetch the site to get latest data
            const currentSite = await prisma.site.findUnique({ where: { id: site.id } });
            if (!currentSite) {
                console.log(`[SCHEDULER] Site ${site.id} no longer exists, skipping`);
                return;
            }
            
            // Check if sync is allowed (health check)
            const syncCheck = await canSync();
            if (!syncCheck.canSync) {
                console.log(`[SCHEDULER] Skipping scheduled sync for "${currentSite.label}": ${syncCheck.reason}`);
                
                // Create a skipped job record for visibility
                await prisma.job.create({
                    data: {
                        siteId: currentSite.id,
                        type: 'SCHEDULED_SYNC',
                        status: 'FAILED',
                        progress: 0,
                        logs: `Sync skipped: ${syncCheck.reason}`,
                        endedAt: new Date()
                    }
                });
                return;
            }
            
            // Create Job record
            const jobRecord = await prisma.job.create({
                data: {
                    siteId: currentSite.id,
                    type: 'SCHEDULED_SYNC',
                    status: 'RUNNING',
                    progress: 0
                }
            });

            broadcastJobUpdate({
                type: 'job:started',
                job: jobRecord
            });

            try {
                // File sync (0-40% progress)
                console.log(`[SCHEDULER] Starting file sync for "${currentSite.label}"`);
                await syncFiles(currentSite.localPath, currentSite.remotePath, async (progress, message) => {
                    const scaledProgress = Math.floor(progress * 0.4);
                    await prisma.job.update({
                        where: { id: jobRecord.id },
                        data: { progress: scaledProgress }
                    });
                    broadcastJobUpdate({
                        type: 'job:progress',
                        jobId: jobRecord.id,
                        progress: scaledProgress,
                        message
                    });
                });

                // Database sync (40-70% progress)
                if (currentSite.dbContainer && currentSite.dbType) {
                    console.log(`[SCHEDULER] Starting database sync for "${currentSite.label}"`);
                    await syncDatabase(
                        currentSite.label,
                        currentSite.dbContainer,
                        currentSite.dbType as 'mysql' | 'postgres',
                        currentSite.dbUser || '',
                        currentSite.dbPassword || '',
                        currentSite.dbName || '',
                        currentSite.remotePath,
                        async (progress, message) => {
                            const scaledProgress = 40 + Math.floor(progress * 0.3);
                            await prisma.job.update({
                                where: { id: jobRecord.id },
                                data: { progress: scaledProgress }
                            });
                            broadcastJobUpdate({
                                type: 'job:progress',
                                jobId: jobRecord.id,
                                progress: scaledProgress,
                                message
                            });
                        }
                    );
                }

                // Auto-start remote containers if configured (70-80%)
                if (currentSite.autoStartRemote && currentSite.remoteContainers) {
                    const containers = currentSite.remoteContainers.split(',').map(c => c.trim()).filter(Boolean);
                    if (containers.length > 0) {
                        console.log(`[SCHEDULER] Auto-starting remote containers for "${currentSite.label}": ${containers.join(', ')}`);
                        await startRemoteContainers(containers);
                    }
                }

                // Import database on remote if configured (80-90%)
                if (currentSite.remoteDbContainer && currentSite.dbType && currentSite.remoteDbUser && currentSite.remoteDbName) {
                    const dumpPath = `${currentSite.remotePath}/dumps/*.sql`;
                    console.log(`[SCHEDULER] Importing database on remote for "${currentSite.label}"`);
                    const importResult = await importRemoteDatabase(
                        currentSite.remoteDbContainer,
                        currentSite.dbType as 'mysql' | 'postgres',
                        currentSite.remoteDbUser,
                        currentSite.remoteDbPassword || '',
                        currentSite.remoteDbName,
                        dumpPath
                    );
                    if (!importResult.success) {
                        console.error(`[SCHEDULER] Remote DB import failed for "${currentSite.label}":`, importResult.error);
                    }
                }

                const completedJob = await prisma.job.update({
                    where: { id: jobRecord.id },
                    data: { status: 'COMPLETED', endedAt: new Date(), progress: 100 }
                });

                broadcastJobUpdate({
                    type: 'job:completed',
                    job: completedJob
                });

                // Notify remote server of completed sync
                console.log(`[SCHEDULER] Notifying remote of completed sync for "${currentSite.label}"`);
                await notifyRemoteOfSync({
                    id: currentSite.id,
                    label: currentSite.label,
                    remotePath: currentSite.remotePath,
                    siteType: currentSite.siteType,
                    siteUrl: currentSite.siteUrl,
                    status: 'COMPLETED'
                });

                console.log(`[SCHEDULER] Scheduled sync completed for "${currentSite.label}"`);
            } catch (err) {
                console.error(`[SCHEDULER] Sync failed for "${currentSite.label}":`, err);
                const failedJob = await prisma.job.update({
                    where: { id: jobRecord.id },
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

                // Notify remote of failed sync
                await notifyRemoteOfSync({
                    id: currentSite.id,
                    label: currentSite.label,
                    remotePath: currentSite.remotePath,
                    siteType: currentSite.siteType,
                    siteUrl: currentSite.siteUrl,
                    status: 'FAILED',
                    logs: String(err)
                });
            }
        });

        activeJobs.set(site.id, task);
        console.log(`[SCHEDULER] Task registered for "${site.label}"`);
    }

    console.log(`[SCHEDULER] Scheduler ready with ${activeJobs.size} active jobs`);
};

export const startScheduler = () => {
    console.log('[SCHEDULER] Starting scheduler...');
    refreshScheduler();
};
