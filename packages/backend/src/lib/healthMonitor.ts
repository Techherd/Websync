import tls from 'tls';
import { URL } from 'url';
import cron, { ScheduledTask } from 'node-cron';
import prisma from './prisma';
import { broadcast } from './websocket';
import { logAudit } from './audit';

type HealthStatus = 'up' | 'degraded' | 'down' | 'unknown';

interface CheckResult {
    status: HealthStatus;
    httpStatus?: number;
    responseMs?: number;
    sslExpiresAt?: Date;
    error?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const DEGRADED_RESPONSE_MS = 3_000;

const checkSsl = (hostname: string, port: number = 443): Promise<Date | null> => {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: Date | null) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch {}
            resolve(value);
        };
        const socket = tls.connect({
            host: hostname,
            port,
            servername: hostname,
            rejectUnauthorized: false,
            timeout: REQUEST_TIMEOUT_MS
        }, () => {
            const cert = socket.getPeerCertificate();
            if (cert && cert.valid_to) {
                finish(new Date(cert.valid_to));
            } else {
                finish(null);
            }
        });
        socket.on('error', () => finish(null));
        socket.on('timeout', () => finish(null));
    });
};

const checkUrl = async (rawUrl: string): Promise<CheckResult> => {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { status: 'unknown', error: 'Invalid URL' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const started = Date.now();

    try {
        let response = await fetch(url.toString(), {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal
        });
        // Some hosts reject HEAD; retry once with GET.
        if (response.status === 405 || response.status === 501) {
            response = await fetch(url.toString(), {
                method: 'GET',
                redirect: 'follow',
                signal: controller.signal
            });
        }
        const responseMs = Date.now() - started;
        clearTimeout(timer);

        let status: HealthStatus = 'up';
        if (response.status >= 500) status = 'down';
        else if (response.status >= 400) status = 'degraded';
        else if (responseMs > DEGRADED_RESPONSE_MS) status = 'degraded';

        let sslExpiresAt: Date | undefined;
        if (url.protocol === 'https:') {
            const expiry = await checkSsl(url.hostname, parseInt(url.port || '443', 10));
            if (expiry) sslExpiresAt = expiry;
        }

        return {
            status,
            httpStatus: response.status,
            responseMs,
            sslExpiresAt
        };
    } catch (e: any) {
        clearTimeout(timer);
        return {
            status: 'down',
            responseMs: Date.now() - started,
            error: e?.name === 'AbortError' ? 'Timed out' : (e?.message || 'Request failed')
        };
    }
};

const runOneSite = async (site: { id: string; siteUrl: string | null; label: string }) => {
    if (!site.siteUrl) return;
    const result = await checkUrl(site.siteUrl);

    const previous = await prisma.siteHealth.findUnique({ where: { siteId: site.id } });

    const updated = await prisma.siteHealth.upsert({
        where: { siteId: site.id },
        create: {
            siteId: site.id,
            status: result.status,
            httpStatus: result.httpStatus ?? null,
            responseMs: result.responseMs ?? null,
            sslExpiresAt: result.sslExpiresAt ?? null,
            error: result.error ?? null,
            lastCheckedAt: new Date()
        },
        update: {
            status: result.status,
            httpStatus: result.httpStatus ?? null,
            responseMs: result.responseMs ?? null,
            sslExpiresAt: result.sslExpiresAt ?? null,
            error: result.error ?? null,
            lastCheckedAt: new Date()
        }
    });

    broadcast({
        type: 'site:health',
        siteId: site.id,
        health: {
            status: updated.status,
            httpStatus: updated.httpStatus,
            responseMs: updated.responseMs,
            sslExpiresAt: updated.sslExpiresAt,
            error: updated.error,
            lastCheckedAt: updated.lastCheckedAt
        }
    });

    if (previous && previous.status !== result.status && result.status !== 'unknown') {
        await logAudit(null, `health.${result.status}`, site.id, {
            previous: previous.status,
            httpStatus: result.httpStatus,
            error: result.error
        });
    }
};

export const runHealthCheckCycle = async () => {
    const sites = await prisma.site.findMany({
        where: { siteUrl: { not: null } },
        select: { id: true, siteUrl: true, label: true }
    });
    // Run in parallel with a small concurrency cap
    const concurrency = 5;
    for (let i = 0; i < sites.length; i += concurrency) {
        await Promise.all(sites.slice(i, i + concurrency).map(runOneSite));
    }
};

let task: ScheduledTask | null = null;

export const startSiteHealthMonitor = () => {
    if (task) return;
    console.log('[HEALTH] Starting site health monitor (every 5 min)');
    task = cron.schedule('*/5 * * * *', () => {
        runHealthCheckCycle().catch(err => console.error('[HEALTH] cycle error', err));
    });
    // Kick off a first run shortly after boot so the dashboard isn't blank
    setTimeout(() => {
        runHealthCheckCycle().catch(err => console.error('[HEALTH] initial cycle error', err));
    }, 5_000);
};
