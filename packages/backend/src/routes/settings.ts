import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import crypto from 'crypto';
import { requireOwner } from '../middleware/auth';
import { encrypt } from '../lib/crypto';
import { getCloudflareConfig, testCloudflare } from '../lib/cloudflare';

const SettingsSchema = z.object({
    // Server identity
    serverName: z.string().min(1).default('Primary'),
    serverRole: z.enum(['primary', 'secondary', 'peer']).default('primary'),
    
    // SSH connection (optional - sync features won't work without it)
    remoteHost: z.string().optional().or(z.literal('')),
    remotePort: z.number().int().min(1).max(65535).default(22),
    sshKeyPath: z.string().optional(),
    
    // Remote WebSync API
    remoteApiUrl: z.string().url().optional().or(z.literal('')),
    remoteApiToken: z.string().optional(),
    
    // Sync configuration
    syncDirection: z.enum(['push', 'pull', 'bidirectional']).default('push'),
    syncOnlyWhenHealthy: z.boolean().default(true),
    
    // Health check
    healthCheckInterval: z.number().int().min(10).max(300).default(30),
    
    // UI preferences
    hideBranding: z.boolean().default(false),

    // Site provisioning defaults (optional so older clients don't reset them)
    provisionSitesRoot: z.string().startsWith('/').optional(),
    provisionWebPortStart: z.number().int().min(1024).max(65000).optional(),
    provisionHostIp: z.string().nullish(),
    wordpressImage: z.string().min(1).optional(),
    staticImage: z.string().min(1).optional(),

    // Cloudflare Tunnel. Token: omit to keep the stored one, '' to clear it.
    cloudflareApiToken: z.string().trim().optional(),
    cloudflareAccountId: z.string().trim().regex(/^[a-f0-9]{32}$/i, 'Cloudflare account ID is a 32-character hex string').nullish().or(z.literal('')),
    cloudflareTunnelId: z.string().trim().regex(/^[0-9a-f-]{36}$/i, 'Tunnel ID looks like 6ff42ae2-765d-4adf-8112-31c55c1551ef').nullish().or(z.literal('')),
});

/** Settings as sent to the browser: never include the Cloudflare token itself. */
const publicSettings = <T extends { cloudflareApiToken?: string | null }>(s: T) => {
    const { cloudflareApiToken, ...rest } = s;
    return { ...rest, cloudflareApiTokenSet: !!cloudflareApiToken };
};

// Generate a secure token for API communication between servers
const generateApiToken = () => crypto.randomBytes(32).toString('hex');

export default async function settingsRoutes(server: FastifyInstance) {
    // Get current settings
    server.get('/settings', async () => {
        const settings = await prisma.settings.findUnique({
            where: { id: 'default' }
        });
        
        if (!settings) {
            return {
                serverName: 'Primary',
                serverRole: 'primary',
                remoteHost: '',
                remotePort: 22,
                sshKeyPath: null,
                remoteApiUrl: null,
                remoteApiToken: null,
                syncDirection: 'push',
                syncOnlyWhenHealthy: true,
                healthCheckInterval: 30,
                remoteHealthy: false,
                lastHealthCheck: null
            };
        }
        
        return publicSettings(settings);
    });

    // Update settings (creates if doesn't exist)
    server.put('/settings', { preHandler: requireOwner }, async (request, reply) => {
        const body = SettingsSchema.parse(request.body);
        
        const settings = await prisma.settings.upsert({
            where: { id: 'default' },
            update: {
                serverName: body.serverName,
                serverRole: body.serverRole,
                remoteHost: body.remoteHost || '',
                remotePort: body.remotePort,
                sshKeyPath: body.sshKeyPath || null,
                remoteApiUrl: body.remoteApiUrl || null,
                remoteApiToken: body.remoteApiToken || null,
                syncDirection: body.syncDirection,
                syncOnlyWhenHealthy: body.syncOnlyWhenHealthy,
                healthCheckInterval: body.healthCheckInterval,
                hideBranding: body.hideBranding,
                provisionSitesRoot: body.provisionSitesRoot,
                provisionWebPortStart: body.provisionWebPortStart,
                provisionHostIp: body.provisionHostIp === undefined ? undefined : (body.provisionHostIp || null),
                wordpressImage: body.wordpressImage,
                staticImage: body.staticImage,
                cloudflareApiToken: body.cloudflareApiToken === undefined ? undefined : (body.cloudflareApiToken ? encrypt(body.cloudflareApiToken) : null),
                cloudflareAccountId: body.cloudflareAccountId === undefined ? undefined : (body.cloudflareAccountId || null),
                cloudflareTunnelId: body.cloudflareTunnelId === undefined ? undefined : (body.cloudflareTunnelId || null),
            },
            create: {
                id: 'default',
                serverName: body.serverName,
                serverRole: body.serverRole,
                remoteHost: body.remoteHost || '',
                remotePort: body.remotePort,
                sshKeyPath: body.sshKeyPath || null,
                remoteApiUrl: body.remoteApiUrl || null,
                remoteApiToken: body.remoteApiToken || generateApiToken(),
                syncDirection: body.syncDirection,
                syncOnlyWhenHealthy: body.syncOnlyWhenHealthy,
                healthCheckInterval: body.healthCheckInterval,
                hideBranding: body.hideBranding,
                provisionSitesRoot: body.provisionSitesRoot,
                provisionWebPortStart: body.provisionWebPortStart,
                provisionHostIp: body.provisionHostIp === undefined ? undefined : (body.provisionHostIp || null),
                wordpressImage: body.wordpressImage,
                staticImage: body.staticImage,
                cloudflareApiToken: body.cloudflareApiToken === undefined ? undefined : (body.cloudflareApiToken ? encrypt(body.cloudflareApiToken) : null),
                cloudflareAccountId: body.cloudflareAccountId === undefined ? undefined : (body.cloudflareAccountId || null),
                cloudflareTunnelId: body.cloudflareTunnelId === undefined ? undefined : (body.cloudflareTunnelId || null),
            }
        });
        
        return publicSettings(settings);
    });

    // Check the Cloudflare token, account and tunnel
    server.post('/settings/cloudflare/test', { preHandler: requireOwner }, async () => {
        try {
            const cfg = await getCloudflareConfig();
            if (!cfg) return { success: false, error: 'Save an API token, account ID and tunnel ID first.' };
            const { tunnel, routes, warning } = await testCloudflare(cfg);
            return { success: !warning, tunnel: tunnel.name, status: tunnel.status, routes, error: warning };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // Generate a new API token for this server
    server.post('/settings/generate-token', { preHandler: requireOwner }, async () => {
        const token = generateApiToken();
        
        await prisma.settings.update({
            where: { id: 'default' },
            data: { remoteApiToken: token }
        });
        
        return { token };
    });

    // Check if settings are configured
    server.get('/settings/status', async () => {
        const settings = await prisma.settings.findUnique({
            where: { id: 'default' }
        });
        
        return {
            configured: !!settings?.remoteHost,
            hasRemoteHost: !!settings?.remoteHost,
            hasSshKey: !!settings?.sshKeyPath,
            hasRemoteApi: !!settings?.remoteApiUrl,
            syncDirection: settings?.syncDirection || 'push',
            serverRole: settings?.serverRole || 'primary',
            remoteHealthy: settings?.remoteHealthy || false,
            lastHealthCheck: settings?.lastHealthCheck
        };
    });

    // Check remote server health
    server.get('/settings/remote-health', async () => {
        const settings = await prisma.settings.findUnique({
            where: { id: 'default' }
        });

        if (!settings?.remoteApiUrl) {
            return { 
                healthy: false, 
                error: 'Remote API URL not configured',
                lastCheck: null
            };
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);

            const response = await fetch(`${settings.remoteApiUrl}/health`, {
                signal: controller.signal,
                headers: settings.remoteApiToken 
                    ? { 'X-Sync-Token': settings.remoteApiToken }
                    : {}
            });

            clearTimeout(timeout);

            if (response.ok) {
                const data = await response.json() as any;
                
                // Update health status in database
                await prisma.settings.update({
                    where: { id: 'default' },
                    data: {
                        remoteHealthy: true,
                        lastHealthCheck: new Date()
                    }
                });

                return {
                    healthy: true,
                    remoteServer: data.serverName || 'Unknown',
                    remoteRole: data.serverRole || 'unknown',
                    timestamp: data.timestamp,
                    lastCheck: new Date().toISOString()
                };
            } else {
                await prisma.settings.update({
                    where: { id: 'default' },
                    data: {
                        remoteHealthy: false,
                        lastHealthCheck: new Date()
                    }
                });

                return {
                    healthy: false,
                    error: `Remote returned status ${response.status}`,
                    lastCheck: new Date().toISOString()
                };
            }
        } catch (err: any) {
            await prisma.settings.update({
                where: { id: 'default' },
                data: {
                    remoteHealthy: false,
                    lastHealthCheck: new Date()
                }
            });

            return {
                healthy: false,
                error: err.name === 'AbortError' 
                    ? 'Connection timeout' 
                    : (err.message || 'Connection failed'),
                lastCheck: new Date().toISOString()
            };
        }
    });

    // Test SSH connection to remote
    server.get('/settings/test-ssh', async () => {
        const settings = await prisma.settings.findUnique({
            where: { id: 'default' }
        });

        if (!settings?.remoteHost) {
            return { success: false, error: 'Remote host not configured' };
        }

        const { spawn } = await import('child_process');
        
        return new Promise((resolve) => {
            const args = [
                '-o', 'BatchMode=yes',
                '-o', 'ConnectTimeout=5',
                '-o', 'StrictHostKeyChecking=no',
                '-p', String(settings.remotePort)
            ];
            
            if (settings.sshKeyPath) {
                args.push('-i', settings.sshKeyPath);
            }
            
            args.push(settings.remoteHost, 'echo', 'connected');

            const proc = spawn('ssh', args);
            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (data) => { stdout += data.toString(); });
            proc.stderr.on('data', (data) => { stderr += data.toString(); });

            proc.on('close', (code) => {
                if (code === 0 && stdout.includes('connected')) {
                    resolve({ success: true, message: 'SSH connection successful' });
                } else {
                    resolve({ 
                        success: false, 
                        error: stderr || 'SSH connection failed',
                        exitCode: code
                    });
                }
            });

            // Timeout after 10 seconds
            setTimeout(() => {
                proc.kill();
                resolve({ success: false, error: 'SSH connection timeout' });
            }, 10000);
        });
    });
}
