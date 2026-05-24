import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireOwner } from '../middleware/auth';
import { logAudit } from '../lib/audit';

const NewUserSchema = z.object({
    email: z.string().email().transform(s => s.toLowerCase()),
    name: z.string().min(1),
    password: z.string().min(8),
    role: z.enum(['owner', 'viewer']).optional()
});

const UpdateUserSchema = z.object({
    name: z.string().min(1).optional(),
    role: z.enum(['owner', 'viewer']).optional(),
    password: z.string().min(8).optional()
});

const publicUser = (u: { id: string; email: string; name: string; role: string; createdAt: Date; lastLoginAt: Date | null }) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt
});

export default async function userRoutes(server: FastifyInstance) {
    // List users — visible to any authenticated user
    server.get('/users', async (request, reply) => {
        if (!request.user) return reply.status(401).send({ error: 'Authentication required' });
        const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
        return users.map(publicUser);
    });

    server.get('/users/me', async (request, reply) => {
        if (!request.user) return reply.status(401).send({ error: 'Authentication required' });
        const me = await prisma.user.findUnique({ where: { id: request.user.id } });
        if (!me) return reply.status(404).send({ error: 'User not found' });
        return publicUser(me);
    });

    // Create new user — owner-only
    server.post('/users', { preHandler: requireOwner }, async (request, reply) => {
        const parsed = NewUserSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
        }
        const { email, name, password, role } = parsed.data;
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) return reply.status(409).send({ error: 'A user with that email already exists' });
        const passwordHash = await bcrypt.hash(password, 10);
        const user = await prisma.user.create({
            data: { email, name, passwordHash, role: role || 'owner' }
        });
        await logAudit(request, 'user.create', null, { email, role: user.role });
        return publicUser(user);
    });

    // Update user (name / role / password) — owner-only
    server.patch('/users/:id', { preHandler: requireOwner }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const parsed = UpdateUserSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
        }
        const data: { name?: string; role?: string; passwordHash?: string } = {};
        if (parsed.data.name) data.name = parsed.data.name;
        if (parsed.data.role) data.role = parsed.data.role;
        if (parsed.data.password) data.passwordHash = await bcrypt.hash(parsed.data.password, 10);
        const user = await prisma.user.update({ where: { id }, data });
        if (parsed.data.password) {
            // Boot all sessions when password is reset by an owner
            await prisma.session.deleteMany({ where: { userId: id } });
        }
        await logAudit(request, 'user.update', null, { targetUserId: id, fields: Object.keys(data) });
        return publicUser(user);
    });

    // Delete user — owner-only, must not be self, must not be the last owner
    server.delete('/users/:id', { preHandler: requireOwner }, async (request, reply) => {
        const { id } = request.params as { id: string };
        if (request.user?.id === id) {
            return reply.status(400).send({ error: 'You cannot delete your own account' });
        }
        const target = await prisma.user.findUnique({ where: { id } });
        if (!target) return reply.status(404).send({ error: 'User not found' });
        if (target.role === 'owner') {
            const ownerCount = await prisma.user.count({ where: { role: 'owner' } });
            if (ownerCount <= 1) {
                return reply.status(400).send({ error: 'Cannot delete the last owner' });
            }
        }
        await prisma.user.delete({ where: { id } });
        await logAudit(request, 'user.delete', null, { targetUserId: id, email: target.email });
        return { success: true };
    });
}
