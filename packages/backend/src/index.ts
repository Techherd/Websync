import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';

import siteRoutes from './routes/sites';
import settingsRoutes from './routes/settings';
import jobRoutes from './routes/jobs';
import userRoutes from './routes/users';
import auditRoutes from './routes/audit';
import { receivedSitesRoutes } from './routes/received-sites';
import { registerWebSocket } from './lib/websocket';
import { registerAuthRoutes, authMiddleware } from './middleware/auth';
import { startScheduler } from './lib/scheduler';
import { startHealthChecker } from './lib/healthChecker';
import { startSiteHealthMonitor } from './lib/healthMonitor';
import { startSecurityScanner } from './lib/securityScanner';
import prisma from './lib/prisma';

const server = Fastify({
    logger: true
});

const isProduction = process.env.NODE_ENV === 'production';

// Register plugins
server.register(cors, {
    origin: '*',
    credentials: true
});

server.register(websocket);

// Health check endpoint (no auth required) - includes server identity for bidirectional sync
server.get('/health', async (request) => {
    const settings = await prisma.settings.findUnique({
        where: { id: 'default' }
    });

    // Verify sync token if provided (for server-to-server communication)
    const syncToken = request.headers['x-sync-token'];
    const isValidSyncToken = syncToken && settings?.remoteApiToken === syncToken;

    return { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        serverName: settings?.serverName || 'WebSync Server',
        serverRole: settings?.serverRole || 'primary',
        syncDirection: settings?.syncDirection || 'push',
        // Only include sensitive info if valid sync token
        ...(isValidSyncToken ? {
            remoteHealthy: settings?.remoteHealthy,
            lastHealthCheck: settings?.lastHealthCheck
        } : {})
    };
});

// Register auth routes first (login doesn't require auth)
server.register(registerAuthRoutes);

// Apply auth middleware to protected routes (skip static files and frontend routes)
server.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0]; // Remove query string
    
    // Skip auth for static assets and frontend routes in production
    if (isProduction) {
        // Static assets
        if (url.startsWith('/assets/') || 
            url === '/favicon.ico' ||
            url === '/vite.svg') {
            return;
        }
        
        // Frontend routes (SPA) - these serve index.html, auth is handled client-side
        // Only skip if it looks like a frontend route (not an API call)
        const isApiRoute = url.startsWith('/auth/') ||
                          url.startsWith('/sites') ||
                          url.startsWith('/scan-allowlist') ||
                          url.startsWith('/jobs') ||
                          url.startsWith('/settings') ||
                          url.startsWith('/users') ||
                          url.startsWith('/audit') ||
                          url.startsWith('/remote-containers') ||
                          url.startsWith('/received-sites') ||
                          url === '/ws' ||
                          url === '/health';
        
        if (!isApiRoute) {
            // This is a frontend route (/, /login, /jobs, /settings page, etc.)
            return;
        }
    }
    
    return authMiddleware(request, reply);
});

// Register WebSocket handler
server.register(registerWebSocket);

// Register API routes
server.register(siteRoutes);
server.register(settingsRoutes);
server.register(jobRoutes);
server.register(userRoutes);
server.register(auditRoutes);
server.register(receivedSitesRoutes);

// Serve static frontend in production
if (isProduction) {
    const publicPath = path.join(__dirname, '..', 'public');
    
    if (fs.existsSync(publicPath)) {
        server.register(fastifyStatic, {
            root: publicPath,
            prefix: '/'
        });

        // SPA fallback - serve index.html for client-side routes
        server.setNotFoundHandler(async (request, reply) => {
            // If it's an API route, return 404
            if (request.url.startsWith('/sites') ||
                request.url.startsWith('/scan-allowlist') ||
                request.url.startsWith('/jobs') ||
                request.url.startsWith('/settings') ||
                request.url.startsWith('/auth') ||
                request.url.startsWith('/users') ||
                request.url.startsWith('/audit') ||
                request.url.startsWith('/remote-containers') ||
                request.url.startsWith('/received-sites') ||
                request.url.startsWith('/ws')) {
                return reply.status(404).send({ error: 'Not found' });
            }
            // Otherwise serve the SPA
            return reply.sendFile('index.html');
        });
    }
} else {
    // Development - just show API info at root
    server.get('/', async () => {
        return { 
            name: 'WebSync API',
            version: '1.0.0',
            mode: 'development',
            endpoints: ['/sites', '/jobs', '/settings', '/auth/login', '/ws']
        };
    });
}

// Start scheduler and health checker
startScheduler();
startHealthChecker();
startSiteHealthMonitor();
startSecurityScanner();

const start = async () => {
    try {
        await server.listen({ port: 3000, host: '0.0.0.0' });
        console.log(`WebSync server running on http://0.0.0.0:3000 (${isProduction ? 'production' : 'development'})`);
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};

start();
