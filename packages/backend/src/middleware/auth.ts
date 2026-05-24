import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import prisma from '../lib/prisma';

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BOOTSTRAP_EMAIL = 'admin@local';

declare module 'fastify' {
    interface FastifyRequest {
        user?: { id: string; email: string; name: string; role: string };
    }
}

const generateToken = () => crypto.randomBytes(32).toString('hex');

const createSession = async (userId: string, request: FastifyRequest) => {
    const token = generateToken();
    await prisma.session.create({
        data: {
            userId,
            token,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            userAgent: request.headers['user-agent']?.toString().slice(0, 256),
            ip: (request.ip || '').slice(0, 64) || null
        }
    });
    return token;
};

const lookupSession = async (token: string) => {
    const session = await prisma.session.findUnique({
        where: { token },
        include: { user: true }
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) {
        await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
        return null;
    }
    return session;
};

/**
 * First-launch bootstrap: if there are no users yet, accept the legacy
 * AUTH_PASSWORD as the password and create an `admin@local` owner. This makes
 * the upgrade transparent for existing deployments.
 */
const tryBootstrap = async (email: string, password: string) => {
    const userCount = await prisma.user.count();
    if (userCount > 0) return null;
    if (password !== AUTH_PASSWORD) return null;
    const targetEmail = email || BOOTSTRAP_EMAIL;
    const passwordHash = await bcrypt.hash(password, 10);
    return prisma.user.create({
        data: {
            email: targetEmail,
            passwordHash,
            name: 'Owner',
            role: 'owner'
        }
    });
};

export const registerAuthRoutes = async (server: FastifyInstance) => {
    server.post('/auth/login', async (request, reply) => {
        const body = (request.body || {}) as { email?: string; password?: string };
        const password = body.password || '';
        const email = (body.email || '').trim().toLowerCase();

        if (!password) {
            return reply.status(400).send({ error: 'Password required' });
        }

        let user = email
            ? await prisma.user.findUnique({ where: { email } })
            : null;

        // Bootstrap path: legacy single-password login on a fresh install
        if (!user) {
            const bootstrapped = await tryBootstrap(email, password);
            if (bootstrapped) {
                user = bootstrapped;
            }
        }

        if (!user) {
            return reply.status(401).send({ error: 'Invalid email or password' });
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) {
            return reply.status(401).send({ error: 'Invalid email or password' });
        }

        const token = await createSession(user.id, request);
        await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() }
        });

        return {
            token,
            user: { id: user.id, email: user.email, name: user.name, role: user.role }
        };
    });

    server.post('/auth/logout', async (request) => {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            await prisma.session.deleteMany({ where: { token } });
        }
        return { success: true };
    });

    server.get('/auth/status', async (request) => {
        const authHeader = request.headers.authorization;
        if (!authHeader?.startsWith('Bearer ')) {
            return { authenticated: false };
        }
        const session = await lookupSession(authHeader.substring(7));
        if (!session) return { authenticated: false };
        return {
            authenticated: true,
            user: {
                id: session.user.id,
                email: session.user.email,
                name: session.user.name,
                role: session.user.role
            }
        };
    });

    server.post('/auth/change-password', async (request, reply) => {
        if (!request.user) return reply.status(401).send({ error: 'Authentication required' });
        const { currentPassword, newPassword } = (request.body || {}) as {
            currentPassword?: string; newPassword?: string;
        };
        if (!currentPassword || !newPassword || newPassword.length < 8) {
            return reply.status(400).send({ error: 'Both fields required; new password must be at least 8 characters' });
        }
        const user = await prisma.user.findUnique({ where: { id: request.user.id } });
        if (!user) return reply.status(404).send({ error: 'User not found' });
        const ok = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!ok) return reply.status(401).send({ error: 'Current password is incorrect' });
        const passwordHash = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
        // Invalidate all other sessions for this user
        const currentToken = request.headers.authorization?.substring(7);
        await prisma.session.deleteMany({
            where: { userId: user.id, NOT: { token: currentToken } }
        });
        return { success: true };
    });
};

// Routes that don't require authentication
const PUBLIC_ROUTES = [
    '/auth/login',
    '/auth/logout',
    '/auth/status',
    '/ws',
    '/health',
    '/received-sites/register'  // Uses X-Sync-Token auth
];

export const authMiddleware = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split('?')[0];

    if (PUBLIC_ROUTES.includes(url)) {
        return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Authentication required' });
    }

    const token = authHeader.substring(7);
    const session = await lookupSession(token);
    if (!session) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    request.user = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role
    };
};

export const requireOwner = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user || request.user.role !== 'owner') {
        return reply.status(403).send({ error: 'Owner role required' });
    }
};
