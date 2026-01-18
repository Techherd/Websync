import prisma from './prisma';
import { broadcastJobUpdate } from './websocket';

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let currentIntervalMs = 30000;

interface HealthStatus {
    healthy: boolean;
    serverName?: string;
    serverRole?: string;
    error?: string;
    lastCheck: Date;
}

let lastHealthStatus: HealthStatus | null = null;

export const getLastHealthStatus = () => lastHealthStatus;

export const checkRemoteHealth = async (): Promise<HealthStatus> => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });

    if (!settings?.remoteApiUrl) {
        const status: HealthStatus = {
            healthy: false,
            error: 'Remote API URL not configured',
            lastCheck: new Date()
        };
        lastHealthStatus = status;
        return status;
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
            
            const wasUnhealthy = !settings.remoteHealthy;
            
            await prisma.settings.update({
                where: { id: 'default' },
                data: {
                    remoteHealthy: true,
                    lastHealthCheck: new Date()
                }
            });

            const status: HealthStatus = {
                healthy: true,
                serverName: data.serverName || 'Unknown',
                serverRole: data.serverRole || 'unknown',
                lastCheck: new Date()
            };
            
            lastHealthStatus = status;

            // Broadcast health change
            if (wasUnhealthy) {
                broadcastJobUpdate({
                    type: 'health:changed' as any,
                    healthy: true,
                    serverName: status.serverName
                } as any);
            }

            return status;
        } else {
            throw new Error(`Remote returned status ${response.status}`);
        }
    } catch (err: any) {
        const wasHealthy = settings.remoteHealthy;
        
        await prisma.settings.update({
            where: { id: 'default' },
            data: {
                remoteHealthy: false,
                lastHealthCheck: new Date()
            }
        });

        const status: HealthStatus = {
            healthy: false,
            error: err.name === 'AbortError' 
                ? 'Connection timeout' 
                : (err.message || 'Connection failed'),
            lastCheck: new Date()
        };
        
        lastHealthStatus = status;

        // Broadcast health change
        if (wasHealthy) {
            broadcastJobUpdate({
                type: 'health:changed' as any,
                healthy: false,
                error: status.error
            } as any);
        }

        return status;
    }
};

export const isRemoteHealthy = async (): Promise<boolean> => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });
    
    // If we don't require health check, always return true
    if (!settings?.syncOnlyWhenHealthy) {
        return true;
    }
    
    // If no remote API configured, can't check - use SSH connectivity as fallback
    if (!settings.remoteApiUrl) {
        return true; // Assume healthy, SSH will fail if not
    }
    
    return settings.remoteHealthy;
};

export const refreshHealthChecker = async () => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });

    const intervalMs = (settings?.healthCheckInterval || 30) * 1000;

    // Only restart if interval changed
    if (healthCheckInterval && intervalMs !== currentIntervalMs) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }

    if (!healthCheckInterval && settings?.remoteApiUrl) {
        currentIntervalMs = intervalMs;
        
        // Run immediately
        checkRemoteHealth();
        
        // Then run on interval
        healthCheckInterval = setInterval(() => {
            checkRemoteHealth();
        }, intervalMs);
        
        console.log(`Health checker started with ${intervalMs / 1000}s interval`);
    }
};

export const startHealthChecker = () => {
    refreshHealthChecker();
};

export const stopHealthChecker = () => {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
};
