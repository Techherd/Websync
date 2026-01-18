import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';

// Simple token store (in production, use Redis or similar)
const validTokens: Set<string> = new Set();

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin';
const JWT_SECRET = process.env.JWT_SECRET || 'websync-dev-secret';

// Generate a simple token
const generateToken = (): string => {
    return crypto.randomBytes(32).toString('hex');
};

// Verify token
const verifyToken = (token: string): boolean => {
    return validTokens.has(token);
};

export const registerAuthRoutes = async (server: FastifyInstance) => {
    // Login endpoint
    server.post('/auth/login', async (request, reply) => {
        const { password } = request.body as { password: string };

        if (password !== AUTH_PASSWORD) {
            return reply.status(401).send({ error: 'Invalid password' });
        }

        const token = generateToken();
        validTokens.add(token);

        return { token };
    });

    // Logout endpoint
    server.post('/auth/logout', async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            validTokens.delete(token);
        }
        return { success: true };
    });

    // Check auth status
    server.get('/auth/status', async (request, reply) => {
        const authHeader = request.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return { authenticated: false };
        }

        const token = authHeader.substring(7);
        return { authenticated: verifyToken(token) };
    });
};

// Routes that don't require authentication
const PUBLIC_ROUTES = [
    '/auth/login',
    '/auth/logout', 
    '/auth/status',
    '/ws',
    '/health',
    '/received-sites/register',  // Uses X-Sync-Token auth
];

// Auth middleware for protected routes
export const authMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0]; // Remove query string
    
    // Skip auth for public routes
    if (PUBLIC_ROUTES.includes(url)) {
        return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Authentication required' });
    }

    const token = authHeader.substring(7);
    if (!verifyToken(token)) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
    }
};
