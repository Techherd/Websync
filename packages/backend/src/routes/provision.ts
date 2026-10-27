import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { requireRole } from '../middleware/auth';
import { logAudit } from '../lib/audit';
import { broadcastJobUpdate } from '../lib/websocket';
import { preflight, provisionSite } from '../lib/provisioner';

const ProvisionSchema = z.object({
    type: z.enum(['wordpress', 'static']),
    name: z.string().trim().min(1, 'Site name is required').max(80),
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
        'Short name: 1-32 lowercase letters, numbers or dashes, not starting or ending with a dash'),
    domain: z.string().trim().toLowerCase()
        .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a domain like example.com, without https://')
        .nullish().or(z.literal('')),
    adminEmail: z.string().trim().email('Enter a valid email').nullish().or(z.literal(''))
});

const canProvision = requireRole('owner', 'manager');

export default async function provisionRoutes(server: FastifyInstance) {
    // Dry run: what would be created, and anything blocking it
    server.post('/provision/preflight', { preHandler: canProvision }, async (request, reply) => {
        const parsed = ProvisionSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
        }
        const { checks, plan } = await preflight(parsed.data);
        return {
            ok: checks.every(c => c.status !== 'fail'),
            checks,
            plan: plan && {
                siteDir: plan.siteDir,
                dbDir: plan.dbDir,
                webContainer: plan.webContainer,
                dbContainer: plan.dbContainer,
                webImage: plan.webImage,
                webPort: plan.webPort,
                siteUrl: plan.siteUrl
            }
        };
    });

    // Start provisioning in the background; progress arrives over the WebSocket
    server.post('/provision', { preHandler: canProvision }, async (request, reply) => {
        const parsed = ProvisionSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Invalid input' });
        }
        const input = parsed.data;

        const { checks } = await preflight(input);
        const failed = checks.filter(c => c.status === 'fail');
        if (failed.length) {
            return reply.status(409).send({ error: failed.map(c => c.detail || c.label).join(' '), checks });
        }

        const job = await prisma.job.create({
            data: { type: 'PROVISION', status: 'RUNNING', progress: 0, label: input.name }
        });
        broadcastJobUpdate({ type: 'job:started', job });
        await logAudit(request, 'site.provision', null, {
            jobId: job.id, type: input.type, slug: input.slug, domain: input.domain || null
        });

        provisionSite(input, job.id, request.user?.id || null).catch(err =>
            console.error('[provision] unexpected failure', err)
        );

        return { jobId: job.id };
    });
}
