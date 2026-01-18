import { FastifyInstance } from 'fastify';
import prisma from '../lib/prisma';

export default async function jobRoutes(server: FastifyInstance) {
    // List jobs with filtering and pagination
    server.get('/jobs', async (request) => {
        const { 
            siteId, 
            status, 
            limit = '20', 
            offset = '0' 
        } = request.query as { 
            siteId?: string; 
            status?: string; 
            limit?: string; 
            offset?: string;
        };

        const where: any = {};
        if (siteId) where.siteId = siteId;
        if (status) where.status = status;

        const [jobs, total] = await Promise.all([
            prisma.job.findMany({
                where,
                include: {
                    site: {
                        select: { label: true }
                    }
                },
                orderBy: { startedAt: 'desc' },
                take: parseInt(limit),
                skip: parseInt(offset)
            }),
            prisma.job.count({ where })
        ]);

        return {
            jobs,
            total,
            limit: parseInt(limit),
            offset: parseInt(offset)
        };
    });

    // Get single job details
    server.get('/jobs/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        
        const job = await prisma.job.findUnique({
            where: { id },
            include: {
                site: true
            }
        });

        if (!job) return reply.status(404).send({ error: 'Job not found' });
        return job;
    });

    // Get running jobs count (for UI status indicator)
    server.get('/jobs/running/count', async () => {
        const count = await prisma.job.count({
            where: { status: 'RUNNING' }
        });
        return { count };
    });
}
