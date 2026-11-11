import prisma from './prisma';
import { decrypt } from './crypto';

/**
 * Minimal Cloudflare API client for routing a hostname through a remotely
 * managed Cloudflare Tunnel: the tunnel's ingress rules plus the proxied CNAME
 * that points the hostname at the tunnel.
 *
 * The API token needs: Account → Cloudflare Tunnel: Edit, Zone → DNS: Edit,
 * Zone → Zone: Read (for every zone sites live in).
 */

const API = 'https://api.cloudflare.com/client/v4';

export interface CloudflareConfig {
    token: string;
    accountId: string;
    tunnelId: string;
}

export interface IngressRule {
    hostname?: string;
    path?: string;
    service: string;
    originRequest?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface TunnelConfig {
    ingress?: IngressRule[];
    [key: string]: unknown;
}

export interface TunnelInfo {
    id: string;
    name: string;
    status: string;
    remoteConfig: boolean;
}

export interface DnsRecord {
    id: string;
    type: string;
    name: string;
    content: string;
    proxied?: boolean;
}

export class CloudflareError extends Error {
    constructor(message: string, public status?: number) {
        super(message);
    }
}

export const getCloudflareConfig = async (): Promise<CloudflareConfig | null> => {
    const s = await prisma.settings.findUnique({ where: { id: 'default' } });
    if (!s?.cloudflareApiToken || !s.cloudflareAccountId || !s.cloudflareTunnelId) return null;
    let token: string;
    try {
        token = decrypt(s.cloudflareApiToken);
    } catch {
        throw new CloudflareError('The stored Cloudflare API token could not be decrypted. Enter it again in Settings.');
    }
    return { token, accountId: s.cloudflareAccountId, tunnelId: s.cloudflareTunnelId };
};

const cf = async <T>(cfg: Pick<CloudflareConfig, 'token'>, method: string, path: string, body?: unknown): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let res: Response;
    try {
        res = await fetch(`${API}${path}`, {
            method,
            signal: controller.signal,
            headers: {
                Authorization: `Bearer ${cfg.token}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
            },
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
    } catch (e: any) {
        throw new CloudflareError(e.name === 'AbortError' ? 'Cloudflare API timed out' : `Could not reach Cloudflare: ${e.message}`);
    } finally {
        clearTimeout(timeout);
    }
    const json = await res.json().catch(() => null) as any;
    if (!res.ok || !json?.success) {
        const msg = json?.errors?.map((e: any) => e.message).filter(Boolean).join('; ') || `HTTP ${res.status}`;
        const hint = res.status === 403 || res.status === 401
            ? ' (check the API token\'s permissions: Cloudflare Tunnel Edit, DNS Edit, Zone Read)'
            : '';
        throw new CloudflareError(`Cloudflare ${method} ${path.split('?')[0]} failed: ${msg}${hint}`, res.status);
    }
    return json.result as T;
};

export const tunnelTarget = (cfg: CloudflareConfig) => `${cfg.tunnelId}.cfargotunnel.com`;

export const getTunnel = async (cfg: CloudflareConfig): Promise<TunnelInfo> => {
    const t = await cf<any>(cfg, 'GET', `/accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}`);
    return { id: t.id, name: t.name, status: t.status, remoteConfig: !!t.remote_config };
};

export const getTunnelConfig = async (cfg: CloudflareConfig): Promise<TunnelConfig> => {
    const r = await cf<any>(cfg, 'GET', `/accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}/configurations`);
    return (r?.config || {}) as TunnelConfig;
};

export const putTunnelConfig = async (cfg: CloudflareConfig, config: TunnelConfig): Promise<void> => {
    await cf(cfg, 'PUT', `/accounts/${cfg.accountId}/cfd_tunnel/${cfg.tunnelId}/configurations`, { config });
};

/** The zone a hostname belongs to (most specific match), or null. */
export const findZone = async (cfg: CloudflareConfig, hostname: string): Promise<{ id: string; name: string } | null> => {
    const labels = hostname.toLowerCase().split('.');
    for (let i = 0; i < labels.length - 1; i++) {
        const name = labels.slice(i).join('.');
        const zones = await cf<any[]>(cfg, 'GET', `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(cfg.accountId)}`);
        if (zones?.length) return { id: zones[0].id, name: zones[0].name };
    }
    return null;
};

export const getDnsRecords = async (cfg: CloudflareConfig, zoneId: string, hostname: string): Promise<DnsRecord[]> =>
    cf<DnsRecord[]>(cfg, 'GET', `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);

export const createTunnelCname = async (cfg: CloudflareConfig, zoneId: string, hostname: string): Promise<DnsRecord> =>
    cf<DnsRecord>(cfg, 'POST', `/zones/${zoneId}/dns_records`, {
        type: 'CNAME', name: hostname, content: tunnelTarget(cfg), proxied: true, ttl: 1,
        comment: 'Managed by WebSync'
    });

export const updateDnsRecord = async (cfg: CloudflareConfig, zoneId: string, recordId: string, data: Partial<DnsRecord> & { ttl?: number }): Promise<DnsRecord> =>
    cf<DnsRecord>(cfg, 'PATCH', `/zones/${zoneId}/dns_records/${recordId}`, data);

export const deleteDnsRecord = async (cfg: CloudflareConfig, zoneId: string, recordId: string): Promise<void> => {
    await cf(cfg, 'DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
};

/** Ingress rule that routes exactly this hostname (ignoring path-specific rules). */
export const findHostRule = (config: TunnelConfig, hostname: string): IngressRule | undefined =>
    config.ingress?.find(r => r.hostname?.toLowerCase() === hostname.toLowerCase() && !r.path);

/**
 * Return a new config with `newHost` routed to `service`.
 *   - If `oldHost` has a rule, the new rule copies its settings (originRequest etc.).
 *   - `keepOld` leaves the old rule in place; otherwise it's removed.
 *   - New rules go before the catch-all (the last rule, which has no hostname).
 */
export const withHostRoute = (
    config: TunnelConfig,
    newHost: string,
    service: string,
    oldHost: string | null,
    keepOld: boolean
): TunnelConfig => {
    const ingress = [...(config.ingress || [])].map(r => ({ ...r }));
    const oldRule = oldHost ? ingress.find(r => r.hostname?.toLowerCase() === oldHost.toLowerCase() && !r.path) : undefined;
    const existingNew = ingress.find(r => r.hostname?.toLowerCase() === newHost.toLowerCase() && !r.path);

    if (existingNew) {
        existingNew.service = service;
    } else {
        const rule: IngressRule = oldRule ? { ...oldRule, hostname: newHost, service } : { hostname: newHost, service };
        let at = ingress.length;
        if (oldRule) at = ingress.indexOf(oldRule);
        else if (ingress.length && !ingress[ingress.length - 1].hostname) at = ingress.length - 1;
        ingress.splice(at, 0, rule);
    }

    let result = ingress;
    if (oldRule && !keepOld && oldRule !== existingNew) result = ingress.filter(r => r !== oldRule);
    // cloudflared requires a catch-all as the last rule.
    if (!result.length || result[result.length - 1].hostname) result.push({ service: 'http_status:404' });
    return { ...config, ingress: result };
};

export const withoutHostRoute = (config: TunnelConfig, hostname: string): TunnelConfig => ({
    ...config,
    ingress: (config.ingress || []).filter(r => !(r.hostname?.toLowerCase() === hostname.toLowerCase() && !r.path))
});

/** Check the token, account and tunnel together. */
export const testCloudflare = async (cfg: CloudflareConfig): Promise<{ tunnel: TunnelInfo; routes: number; warning?: string }> => {
    const tunnel = await getTunnel(cfg);
    if (!tunnel.remoteConfig) {
        return {
            tunnel, routes: 0,
            warning: 'This tunnel is configured locally (config.yml), so WebSync can\'t change its routes. ' +
                'Migrate it to the Cloudflare dashboard (Zero Trust → Networks → Tunnels → Migrate) to let WebSync manage hostnames.'
        };
    }
    const config = await getTunnelConfig(cfg);
    return { tunnel, routes: (config.ingress || []).filter(r => r.hostname).length };
};
