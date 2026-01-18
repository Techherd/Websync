import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';

// Schema for registering a received sync
const ReceivedSyncSchema = z.object({
    sourceServerId: z.string(),
    sourceServerName: z.string(),
    sourceServerUrl: z.string().optional(),
    label: z.string(),
    localPath: z.string(),
    siteType: z.string().optional().default('custom'),
    siteUrl: z.string().nullish(),
    lastSyncStatus: z.string().optional(),
    lastSyncLogs: z.string().optional(),
    filesCount: z.number().optional(),
    totalSize: z.string().optional()
});

export const receivedSitesRoutes = async (server: FastifyInstance) => {
    // Get all received sites (for dashboard display)
    server.get('/received-sites', async () => {
        const sites = await prisma.receivedSite.findMany({
            orderBy: { lastSyncAt: 'desc' }
        });
        return sites;
    });

    // Register/update a received sync (called by remote server after sync)
    // This endpoint requires the sync token for authentication
    server.post('/received-sites/register', async (request, reply) => {
        console.log('[RECEIVED SITES] Registration request received');
        console.log('[RECEIVED SITES] Headers:', JSON.stringify(request.headers, null, 2));
        console.log('[RECEIVED SITES] Body:', JSON.stringify(request.body, null, 2));
        
        // Verify sync token
        const syncToken = request.headers['x-sync-token'] as string;
        const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
        
        console.log('[RECEIVED SITES] Token check:', {
            receivedToken: syncToken ? `${syncToken.substring(0, 8)}...` : 'none',
            expectedToken: settings?.remoteApiToken ? `${settings.remoteApiToken.substring(0, 8)}...` : 'none',
            tokensMatch: syncToken === settings?.remoteApiToken
        });
        
        if (!settings?.remoteApiToken || syncToken !== settings.remoteApiToken) {
            console.log('[RECEIVED SITES] Token validation failed');
            return reply.status(401).send({ error: 'Invalid sync token' });
        }

        const body = ReceivedSyncSchema.parse(request.body);

        // Upsert the received site
        const receivedSite = await prisma.receivedSite.upsert({
            where: { sourceServerId: body.sourceServerId },
            update: {
                sourceServerName: body.sourceServerName,
                sourceServerUrl: body.sourceServerUrl,
                label: body.label,
                localPath: body.localPath,
                siteType: body.siteType,
                siteUrl: body.siteUrl,
                lastSyncAt: new Date(),
                lastSyncStatus: body.lastSyncStatus || 'COMPLETED',
                lastSyncLogs: body.lastSyncLogs,
                filesCount: body.filesCount,
                totalSize: body.totalSize
            },
            create: {
                sourceServerId: body.sourceServerId,
                sourceServerName: body.sourceServerName,
                sourceServerUrl: body.sourceServerUrl,
                label: body.label,
                localPath: body.localPath,
                siteType: body.siteType,
                siteUrl: body.siteUrl,
                lastSyncAt: new Date(),
                lastSyncStatus: body.lastSyncStatus || 'COMPLETED',
                lastSyncLogs: body.lastSyncLogs,
                filesCount: body.filesCount,
                totalSize: body.totalSize
            }
        });

        return { success: true, receivedSite };
    });

    // Delete a received site (for cleanup)
    server.delete('/received-sites/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        
        const existing = await prisma.receivedSite.findUnique({ where: { id } });
        if (!existing) return reply.status(404).send({ error: 'Received site not found' });

        await prisma.receivedSite.delete({ where: { id } });
        return { success: true };
    });
};
