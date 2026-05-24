import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function auditRoutes(server: FastifyInstance) {
    server.get('/audit', async (request, reply) => {
        if (!request.user) return reply.status(401).send({ error: 'Authentication required' });
        const query = request.query as { siteId?: string; userId?: string; limit?: string; offset?: string };
        const limit = Math.min(parseInt(query.limit || '50', 10) || 50, 200);
        const offset = Math.max(parseInt(query.offset || '0', 10) || 0, 0);

        const where: { siteId?: string; userId?: string } = {};
        if (query.siteId) where.siteId = query.siteId;
        if (query.userId) where.userId = query.userId;

        const [events, total] = await Promise.all([
            prisma.auditEvent.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: limit,
                skip: offset,
                include: { user: { select: { id: true, name: true, email: true } } }
            }),
            prisma.auditEvent.count({ where })
        ]);

        return {
            total,
            events: events.map(e => ({
                id: e.id,
                action: e.action,
                siteId: e.siteId,
                createdAt: e.createdAt,
                metadata: e.metadata ? JSON.parse(e.metadata) : null,
                user: e.user
            }))
        };
    });
}
