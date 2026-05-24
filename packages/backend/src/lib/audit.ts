import { FastifyRequest } from 'fastify';
import prisma from './prisma';

/**
 * Record an audit event. Fire-and-forget; logs to console on failure.
 *
 * Pass `null` request for system-generated events (health monitors, schedulers).
 */
export const logAudit = async (
    request: FastifyRequest | null,
    action: string,
    siteId?: string | null,
    metadata?: Record<string, unknown>
): Promise<void> => {
    try {
        await prisma.auditEvent.create({
            data: {
                userId: request?.user?.id || null,
                action,
                siteId: siteId || null,
                metadata: metadata ? JSON.stringify(metadata) : null
            }
        });
    } catch (e) {
        console.error('[audit] failed to record event', action, e);
    }
};
