import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { Site } from '@prisma/client';
import prisma from './prisma';
import { getDocker, executeCommand, findWpCli, ensureWpHtaccess } from './docker';
import { broadcastJobUpdate } from './websocket';
import { runHealthCheckCycle } from './healthMonitor';
import {
    CloudflareConfig,
    TunnelConfig,
    getCloudflareConfig,
    getTunnel,
    getTunnelConfig,
    putTunnelConfig,
    findZone,
    getDnsRecords,
    createTunnelCname,
    deleteDnsRecord,
    findHostRule,
    withHostRoute,
    tunnelTarget
} from './cloudflare';

/**
 * Change a site's address. For WordPress this rewrites every stored URL in the
 * database (serialization-safe, via `wp search-replace`) after taking a backup;
 * optionally it also routes the new hostname through the Cloudflare Tunnel and
 * creates its DNS record. Everything done is undone if a later step fails.
 */

export interface UrlChangeInput {
    newUrl: string;
    cloudflare: boolean;    // route the new hostname through the tunnel
    keepOld: boolean;       // leave the old hostname routed (WordPress redirects it to the new one)
    service?: string | null; // tunnel origin override, e.g. http://192.168.1.161:8105
}

export interface UrlCheck {
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'fail';
    detail?: string;
    fix?: string;
}

/** How the database is backed up and restored if the change has to be undone. */
type DbAccess =
    | { via: 'db'; container: string; user: string; password: string; name: string }  // the site's MariaDB/MySQL container
    | { via: 'wp' };                                                                     // `wp db export/import` (needs a mysql client in the WP image)

interface WpPlan {
    container: string;
    wpPath: string;
    wpCli: string;
    oldHome: string;
    oldSiteurl: string;
    newHome: string;
    newSiteurl: string;
    db: DbAccess;
}

interface CfPlan {
    cfg: CloudflareConfig;
    zoneId: string;
    zoneName: string;
    newHost: string;
    oldHost: string | null;     // only set when the old host has an ingress rule
    service: string;
    createDns: boolean;         // false when a CNAME to this tunnel already exists
}

export interface UrlChangePlan {
    oldUrl: string | null;
    newUrl: string;
    wp: WpPlan | null;
    cf: CfPlan | null;
    keepOld: boolean;
    replacements: [string, string][];
}

const inFlight = new Set<string>();
export const urlChangeInFlight = (siteId: string) => inFlight.has(siteId);

// ---------------------------------------------------------------------------
// Helpers

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[[0-9a-f:]+\]$/i;

/** `example.com` → `https://example.com`; strips trailing slashes. Throws on anything odd. */
export const normalizeUrl = (raw: string): string => {
    const trimmed = raw.trim();
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let u: URL;
    try {
        u = new URL(withScheme);
    } catch {
        throw new Error('Enter a valid address, like https://example.com');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The address must start with http:// or https://');
    if (u.search || u.hash) throw new Error('The address can\'t include a query string or #fragment');
    if (u.username || u.password) throw new Error('The address can\'t include a username or password');
    if (!u.hostname.includes('.') && !IP_RE.test(u.hostname) && u.hostname !== 'localhost') {
        throw new Error('Enter a full domain, like example.com');
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
};

const stripSlash = (url: string) => url.replace(/\/+$/, '');

const tunnelable = (url: string): string | null => {
    const u = new URL(url);
    if (u.port || IP_RE.test(u.hostname) || u.hostname === 'localhost') return null;
    return u.hostname;
};

const hostOf = (url: string | null | undefined): string | null => {
    if (!url) return null;
    try { return new URL(url).hostname; } catch { return null; }
};

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const cleanOutput = (output: string): string =>
    output.split('\n').map(s => s.trim())
        .filter(s => s && !/^(\[[^\]]+\]\s+)?(PHP\s+)?(Warning|Notice|Deprecated):/i.test(s))
        .join('\n').trim();

/** Run WP-CLI with shell-quoted args; returns output and exit code. */
const wp = async (plan: Pick<WpPlan, 'container' | 'wpPath' | 'wpCli'>, args: string[]): Promise<{ ok: boolean; out: string }> => {
    const cmd = `cd ${shq(plan.wpPath)} && ${shq(plan.wpCli)} ${args.map(shq).join(' ')} --path=${shq(plan.wpPath)} --allow-root 2>&1; echo "__EXIT_$?"`;
    const raw = await executeCommand(plan.container, ['sh', '-c', cmd]);
    const m = raw.match(/__EXIT_(\d+)\s*$/);
    return { ok: !!m && m[1] === '0', out: cleanOutput(raw.replace(/__EXIT_\d+\s*$/, '')) };
};

const wpOrThrow = async (plan: WpPlan, args: string[], what: string): Promise<string> => {
    const r = await wp(plan, args);
    if (!r.ok) throw new Error(`${what} failed: ${r.out.split('\n').pop() || 'unknown error'}`);
    return r.out;
};

const runSpawn = (cmd: string, args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
        const p = spawn(cmd, args);
        let err = '';
        p.stderr.on('data', d => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited with ${code}`))));
    });

const dbClient = (db: Extract<DbAccess, { via: 'db' }>, tool: 'dump' | 'client') => {
    const [mariadb, mysql] = tool === 'dump' ? ['mariadb-dump', 'mysqldump'] : ['mariadb', 'mysql'];
    // An empty -p would make the client prompt for a password and hang.
    const pass = db.password ? ` -p${shq(db.password)}` : '';
    return `$(command -v ${mariadb} >/dev/null 2>&1 && echo ${mariadb} || echo ${mysql}) -u${shq(db.user)}${pass}`;
};

const backupDatabase = async (plan: WpPlan, file: string): Promise<{ container: string }> => {
    if (plan.db.via === 'wp') {
        await wpOrThrow(plan, ['db', 'export', file], 'Database backup');
        return { container: plan.container };
    }
    const db = plan.db;
    const out = await executeCommand(db.container, ['sh', '-c',
        `${dbClient(db, 'dump')} --single-transaction --quick --default-character-set=utf8mb4 ${shq(db.name)} > ${shq(file)} 2>${shq(file)}.err; ` +
        `code=$?; cat ${shq(file)}.err; rm -f ${shq(file)}.err; test -s ${shq(file)} || code=1; echo "__EXIT_$code"`]);
    if (!/__EXIT_0\s*$/.test(out)) {
        await executeCommand(db.container, ['rm', '-f', file]).catch(() => {});
        throw new Error(`Database backup failed: ${cleanOutput(out.replace(/__EXIT_\d+\s*$/, '')) || 'empty dump'}`);
    }
    return { container: db.container };
};

const restoreDatabase = async (plan: WpPlan, file: string): Promise<void> => {
    if (plan.db.via === 'wp') {
        await wpOrThrow(plan, ['db', 'import', file], 'Database restore');
        return;
    }
    const db = plan.db;
    const out = await executeCommand(db.container, ['sh', '-c',
        `${dbClient(db, 'client')} ${shq(db.name)} < ${shq(file)} 2>&1; echo "__EXIT_$?"`]);
    if (!/__EXIT_0\s*$/.test(out)) throw new Error(`Database restore failed: ${cleanOutput(out.replace(/__EXIT_\d+\s*$/, ''))}`);
};

/** Every form of the old URL that shows up in WordPress content, paired with its replacement. */
const replacementPairs = (oldUrl: string, newUrl: string): [string, string][] => {
    const pairs: [string, string][] = [];
    const add = (from: string, to: string) => {
        if (from !== to && !pairs.some(([f]) => f === from)) pairs.push([from, to]);
    };
    const old = new URL(oldUrl);
    const rest = oldUrl.slice(old.protocol.length);              // //host:port/path
    const otherScheme = `${old.protocol === 'https:' ? 'http:' : 'https:'}${rest}`;
    for (const from of [oldUrl, otherScheme]) {
        add(from, newUrl);
        add(from.replace(/\//g, '\\/'), newUrl.replace(/\//g, '\\/'));   // JSON-escaped (blocks, page builders)
    }
    return pairs;
};

const webContainerFor = (site: Site): string | null =>
    site.wpContainer || site.dockerContainers?.split(',').map(s => s.trim()).filter(Boolean)[0] || null;

/** Default tunnel origin: the site container's published port on the server. */
const defaultService = async (site: Site, oldUrl: string | null): Promise<string | null> => {
    if (oldUrl) {
        const u = new URL(oldUrl);
        if (u.port && IP_RE.test(u.hostname)) return u.origin;
    }
    const name = webContainerFor(site);
    if (!name) return null;
    try {
        const info = await getDocker().getContainer(name).inspect();
        const binding = info.NetworkSettings?.Ports?.['80/tcp']?.[0]?.HostPort
            || Object.values(info.NetworkSettings?.Ports || {}).find(b => b?.[0]?.HostPort)?.[0]?.HostPort;
        const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
        if (binding && settings?.provisionHostIp) return `http://${settings.provisionHostIp}:${binding}`;
        return `http://${name}:80`;
    } catch {
        return null;
    }
};

// ---------------------------------------------------------------------------
// Preflight

export const planUrlChange = async (
    site: Site,
    input: UrlChangeInput
): Promise<{ checks: UrlCheck[]; plan: UrlChangePlan | null }> => {
    const checks: UrlCheck[] = [];
    const add = (c: UrlCheck) => checks.push(c);

    let newUrl: string;
    try {
        newUrl = normalizeUrl(input.newUrl);
    } catch (e: any) {
        add({ id: 'url', label: 'New address', status: 'fail', detail: e.message });
        return { checks, plan: null };
    }

    if (inFlight.has(site.id)) {
        add({ id: 'busy', label: 'No other address change running', status: 'fail', detail: 'An address change for this site is already in progress.' });
    }

    // --- WordPress -------------------------------------------------------
    let wpPlan: WpPlan | null = null;
    let oldUrl: string | null = site.siteUrl ? stripSlash(site.siteUrl) : null;

    if (site.siteType === 'wordpress') {
        const container = site.wpContainer;
        const wpPath = site.wpPath || '/var/www/html';
        if (!container) {
            add({ id: 'wp', label: 'WordPress container', status: 'fail', detail: 'This site has no WordPress container set.',
                fix: 'Edit the site and set its WordPress container, so the database can be updated.' });
        } else {
            let running = false;
            try {
                running = !!(await getDocker().getContainer(container).inspect()).State?.Running;
            } catch {}
            const wpCli = running ? await findWpCli(container, wpPath) : null;
            if (!running) {
                add({ id: 'wp', label: 'WordPress container is running', status: 'fail', detail: `${container} isn't running.`, fix: 'Start it, then try again.' });
            } else if (!wpCli) {
                add({ id: 'wp', label: 'WP-CLI is available', status: 'fail', detail: `WP-CLI wasn't found in ${container}.`,
                    fix: 'Use a WordPress image that includes WP-CLI.' });
            } else {
                const base = { container, wpPath, wpCli };
                const [home, siteurl, multisite, hasHomeConst, hasSiteurlConst, cfgFile] = await Promise.all([
                    wp(base, ['option', 'get', 'home']),
                    wp(base, ['option', 'get', 'siteurl']),
                    wp(base, ['eval', 'echo is_multisite() ? "yes" : "no";']),
                    wp(base, ['config', 'has', 'WP_HOME']),
                    wp(base, ['config', 'has', 'WP_SITEURL']),
                    wp(base, ['config', 'path'])
                ]);
                if (!home.ok || !siteurl.ok) {
                    add({ id: 'wp', label: 'WordPress database is reachable', status: 'fail',
                        detail: (home.ok ? siteurl.out : home.out).split('\n').pop(),
                        fix: 'Check that the database container is running (Site Doctor can help).' });
                } else if (multisite.out.trim().endsWith('yes')) {
                    add({ id: 'wp', label: 'Single-site WordPress', status: 'fail',
                        detail: 'This is a multisite network. Changing its domain also means editing wp_blogs and wp_site, which WebSync doesn\'t do.' });
                } else if (hasHomeConst.ok || hasSiteurlConst.ok) {
                    add({ id: 'wp', label: 'Address isn\'t fixed in wp-config.php', status: 'fail',
                        detail: 'wp-config.php defines WP_HOME or WP_SITEURL, which would override the database.',
                        fix: 'Remove those lines from wp-config.php (or update them by hand), then try again.' });
                } else {
                    let db: DbAccess | null = null;
                    if (site.dbContainer && site.dbUser && site.dbName && (site.dbType || 'mysql') === 'mysql') {
                        let dbRunning = false;
                        try { dbRunning = !!(await getDocker().getContainer(site.dbContainer).inspect()).State?.Running; } catch {}
                        if (dbRunning) db = { via: 'db', container: site.dbContainer, user: site.dbUser, password: site.dbPassword || '', name: site.dbName };
                    }
                    if (!db) {
                        const hasClient = await executeCommand(container, ['sh', '-c',
                            '(command -v mariadb-dump || command -v mysqldump) >/dev/null 2>&1 && echo yes || echo no']).catch(() => '');
                        if (hasClient.includes('yes')) db = { via: 'wp' };
                    }
                    if (!db) {
                        add({ id: 'backup', label: 'Database can be backed up', status: 'fail',
                            detail: 'The WordPress image has no mysqldump, and this site has no running database container with credentials set.',
                            fix: 'Edit the site and fill in its database container, user, password and name.' });
                    } else {
                        add({ id: 'backup', label: 'Database can be backed up', status: 'ok',
                            detail: db.via === 'db' ? `Using ${db.container}` : `Using WP-CLI in ${container}` });
                    }
                    const oldHome = stripSlash(home.out.split('\n').pop()!.trim());
                    const oldSiteurl = stripSlash(siteurl.out.split('\n').pop()!.trim());
                    oldUrl = oldHome;
                    let newSiteurl: string | null = null;
                    if (oldSiteurl === oldHome) newSiteurl = newUrl;
                    else if (oldSiteurl.startsWith(`${oldHome}/`)) newSiteurl = newUrl + oldSiteurl.slice(oldHome.length);
                    else if (hostOf(oldSiteurl) === hostOf(oldHome)) newSiteurl = new URL(newUrl).origin + new URL(oldSiteurl).pathname.replace(/\/+$/, '');

                    if (new URL(oldHome).pathname !== new URL(newUrl).pathname) {
                        add({ id: 'path', label: 'Same folder path', status: 'fail',
                            detail: `The site lives at "${new URL(oldHome).pathname}" and the new address uses "${new URL(newUrl).pathname}". Only the domain, scheme or port can change; moving WordPress to another folder isn't supported.` });
                    } else if (!newSiteurl) {
                        add({ id: 'wp', label: 'WordPress addresses', status: 'fail',
                            detail: `Home (${oldHome}) and Site URL (${oldSiteurl}) are on different domains, so WebSync can't work out the new Site URL.`,
                            fix: 'Make them match in Settings → General first.' });
                    } else if (db) {
                        wpPlan = { ...base, oldHome, oldSiteurl, newHome: newUrl, newSiteurl, db };
                        add({ id: 'wp', label: 'WordPress database', status: 'ok',
                            detail: `Every ${oldHome} link will become ${newUrl}. A database backup is taken first.` });
                    }

                    if (newUrl.startsWith('https:') && cfgFile.ok) {
                        const cfgPath = cfgFile.out.split('\n').pop()!.trim();
                        const grep = await executeCommand(container, ['sh', '-c',
                            `grep -qs HTTP_X_FORWARDED_PROTO ${shq(cfgPath)} && echo yes || echo no`]).catch(() => '');
                        if (!grep.includes('yes')) {
                            add({ id: 'https', label: 'WordPress detects HTTPS behind the tunnel', status: 'warn',
                                detail: 'wp-config.php doesn\'t check X-Forwarded-Proto. Behind Cloudflare, WordPress may think it\'s on plain HTTP and loop on redirects or load mixed content.',
                                fix: "Add to wp-config.php: if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') { $_SERVER['HTTPS'] = 'on'; }" });
                        }
                    }
                }
            }
        }
    }

    if (oldUrl && oldUrl === newUrl) {
        add({ id: 'url', label: 'New address', status: 'fail', detail: 'That is already the site\'s address.' });
    } else {
        add({ id: 'url', label: 'New address', status: 'ok', detail: oldUrl ? `${oldUrl} → ${newUrl}` : newUrl });
    }

    // --- Cloudflare Tunnel -----------------------------------------------
    let cfPlan: CfPlan | null = null;
    const newHost = tunnelable(newUrl);
    if (input.cloudflare) {
        if (!newHost) {
            add({ id: 'cf', label: 'Cloudflare Tunnel', status: 'fail',
                detail: 'Tunnels route domain names; this address is an IP or has a port.',
                fix: 'Turn off "Route through Cloudflare Tunnel", or use a domain.' });
        } else {
            try {
                const cfg = await getCloudflareConfig();
                if (!cfg) {
                    add({ id: 'cf', label: 'Cloudflare Tunnel', status: 'fail', detail: 'Cloudflare isn\'t set up.',
                        fix: 'Add an API token, account ID and tunnel ID in Settings → Cloudflare Tunnel, or turn tunnel routing off.' });
                } else {
                    const tunnel = await getTunnel(cfg);
                    if (!tunnel.remoteConfig) {
                        add({ id: 'cf', label: 'Cloudflare Tunnel', status: 'fail',
                            detail: `Tunnel "${tunnel.name}" is configured locally (config.yml), so its routes can't be changed through the API.`,
                            fix: 'Migrate the tunnel to dashboard management in Cloudflare Zero Trust, or turn tunnel routing off and update config.yml yourself.' });
                    } else {
                        const config = await getTunnelConfig(cfg);
                        const zone = await findZone(cfg, newHost);
                        const candidates = [hostOf(oldUrl), hostOf(site.siteUrl)].filter(Boolean) as string[];
                        const oldHost = candidates.find(h => h !== newHost && findHostRule(config, h)) || null;
                        const oldRule = oldHost ? findHostRule(config, oldHost) : undefined;
                        const newRule = findHostRule(config, newHost);
                        const service = input.service?.trim() || newRule?.service || oldRule?.service || await defaultService(site, oldUrl);

                        if (!zone) {
                            add({ id: 'cf-zone', label: 'Domain is on Cloudflare', status: 'fail',
                                detail: `No Cloudflare zone found for ${newHost} that this token can see.`,
                                fix: 'Add the domain to Cloudflare, or give the API token Zone Read + DNS Edit on it.' });
                        }
                        let createDns = true;
                        if (zone) {
                            const records = await getDnsRecords(cfg, zone.id, newHost);
                            const ours = records.find(r => r.type === 'CNAME' && r.content.toLowerCase() === tunnelTarget(cfg));
                            if (ours) {
                                createDns = false;
                                add({ id: 'cf-dns', label: 'DNS record', status: 'ok', detail: `${newHost} already points at the tunnel.` });
                            } else if (records.length) {
                                add({ id: 'cf-dns', label: 'DNS record', status: 'fail',
                                    detail: `${newHost} already has ${records.map(r => `${r.type} → ${r.content}`).join(', ')}.`,
                                    fix: 'Delete that record in Cloudflare DNS if it\'s no longer needed, then try again.' });
                            } else {
                                add({ id: 'cf-dns', label: 'DNS record', status: 'ok', detail: `Will create a proxied CNAME for ${newHost} in ${zone.name}.` });
                            }
                        }
                        if (!service) {
                            add({ id: 'cf-route', label: 'Tunnel route', status: 'fail',
                                detail: 'Couldn\'t work out where the tunnel should send traffic.',
                                fix: 'Enter the origin service, like http://192.168.1.161:8105.' });
                        } else if (!/^(https?|unix|tcp|ssh|rdp|http_status):/i.test(service)) {
                            add({ id: 'cf-route', label: 'Tunnel route', status: 'fail', detail: `"${service}" isn't a valid tunnel service.`,
                                fix: 'Use a URL like http://192.168.1.161:8105.' });
                        } else {
                            add({ id: 'cf-route', label: 'Tunnel route', status: 'ok',
                                detail: `${newHost} → ${service} on tunnel "${tunnel.name}"` +
                                    (oldHost ? (input.keepOld ? ` (${oldHost} stays routed and will redirect)` : ` (replaces ${oldHost})`) : '') +
                                    (newRule ? ' (updates the existing route)' : '') });
                        }
                        if (zone && service) {
                            cfPlan = { cfg, zoneId: zone.id, zoneName: zone.name, newHost, oldHost, service, createDns };
                        }
                    }
                }
            } catch (e: any) {
                add({ id: 'cf', label: 'Cloudflare Tunnel', status: 'fail', detail: e.message });
            }
        }
    } else if (newHost) {
        add({ id: 'cf', label: 'Cloudflare Tunnel', status: 'warn', detail: 'Not changing tunnel routes or DNS.',
            fix: `Make sure ${newHost} reaches this site through your proxy or tunnel.` });
    }

    const plan: UrlChangePlan = {
        oldUrl,
        newUrl,
        wp: wpPlan,
        cf: cfPlan,
        keepOld: input.keepOld,
        replacements: wpPlan ? replacementPairs(wpPlan.oldHome, wpPlan.newHome) : []
    };
    return { checks, plan };
};

// ---------------------------------------------------------------------------
// Run

type Undo = { label: string; run: () => Promise<unknown> };

export const runUrlChange = async (site: Site, plan: UrlChangePlan, jobId: string): Promise<void> => {
    if (inFlight.has(site.id)) throw new Error('An address change for this site is already running');
    inFlight.add(site.id);

    const undo: Undo[] = [];
    const logs: string[] = [];
    const { wp: wpPlan, cf: cfPlan } = plan;
    const stepNames = [
        ...(wpPlan ? ['Back up database'] : []),
        ...(cfPlan ? ['Route hostname through Cloudflare Tunnel'] : []),
        ...(wpPlan ? ['Update WordPress addresses'] : []),
        'Update WebSync site'
    ];
    let stepIndex = 0;

    const log = async (message: string) => {
        logs.push(`[${new Date().toISOString()}] ${message}`);
        await prisma.job.update({ where: { id: jobId }, data: { logs: logs.join('\n') } });
    };
    const step = async (name: string, fn: () => Promise<void>) => {
        const progress = Math.round((stepIndex / stepNames.length) * 100);
        await prisma.job.update({ where: { id: jobId }, data: { progress } });
        broadcastJobUpdate({ type: 'job:progress', jobId, progress, message: name });
        await log(`▶ ${name}`);
        await fn();
        stepIndex++;
    };

    try {
        await log(`Changing address: ${plan.oldUrl || '(none)'} → ${plan.newUrl}`);
        let backupFile: string | null = null;
        let backupContainer: string | null = null;

        if (wpPlan) {
            await step('Back up database', async () => {
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const name = `websync-url-change-${stamp}-${crypto.randomBytes(4).toString('hex')}.sql`;
                backupFile = `/tmp/${name}`;
                const { container } = await backupDatabase(wpPlan, backupFile);
                backupContainer = container;
                await log(`Backed up the database to ${backupFile} in ${container}`);

                // Provisioned sites keep a copy in <site>/backups (outside the web root), which
                // survives the container being recreated.
                if (site.provisioned) {
                    const backupsDir = path.posix.join(site.localPath, 'backups');
                    try {
                        await fs.mkdir(backupsDir, { recursive: true });
                        await runSpawn('docker', ['cp', `${container}:${backupFile}`, path.posix.join(backupsDir, name)]);
                        await log(`Saved a copy to ${path.posix.join(backupsDir, name)}`);
                    } catch (e: any) {
                        await log(`Couldn't keep a copy outside the container (${e.message}); the backup in ${container} is still used for rollback.`);
                    }
                }
            });
        }

        if (cfPlan) {
            await step('Route hostname through Cloudflare Tunnel', async () => {
                const { cfg } = cfPlan;
                const before: TunnelConfig = await getTunnelConfig(cfg);
                const after = withHostRoute(before, cfPlan.newHost, cfPlan.service, cfPlan.oldHost, plan.keepOld);
                await putTunnelConfig(cfg, after);
                undo.push({ label: 'tunnel routes', run: () => putTunnelConfig(cfg, before) });
                await log(`Tunnel now routes ${cfPlan.newHost} → ${cfPlan.service}` +
                    (cfPlan.oldHost && !plan.keepOld ? `; removed ${cfPlan.oldHost}` : ''));

                if (cfPlan.createDns) {
                    const record = await createTunnelCname(cfg, cfPlan.zoneId, cfPlan.newHost);
                    undo.push({ label: `DNS record ${cfPlan.newHost}`, run: () => deleteDnsRecord(cfg, cfPlan.zoneId, record.id) });
                    await log(`Created DNS record ${cfPlan.newHost} → ${tunnelTarget(cfg)} (proxied)`);
                } else {
                    await log(`DNS for ${cfPlan.newHost} already points at the tunnel`);
                }
            });
        }

        if (wpPlan) {
            await step('Update WordPress addresses', async () => {
                // From here on, a failure restores the backup.
                undo.push({
                    label: 'WordPress database (restored from backup)',
                    run: () => restoreDatabase(wpPlan, backupFile!)
                });
                for (const [from, to] of plan.replacements) {
                    const out = await wpOrThrow(wpPlan, [
                        'search-replace', from, to,
                        '--all-tables-with-prefix', '--skip-columns=guid', '--precise', '--format=count'
                    ], `Replacing ${from}`);
                    await log(`${from} → ${to}: ${out.split('\n').pop()} replacement(s)`);
                }
                await wpOrThrow(wpPlan, ['option', 'update', 'home', wpPlan.newHome], 'Setting home');
                await wpOrThrow(wpPlan, ['option', 'update', 'siteurl', wpPlan.newSiteurl], 'Setting siteurl');
                await log(`home = ${wpPlan.newHome}, siteurl = ${wpPlan.newSiteurl}`);

                // Best effort: stale object cache / rewrite rules shouldn't fail the change.
                for (const [args, label] of [[['cache', 'flush'], 'object cache'], [['rewrite', 'flush'], 'rewrite rules']] as const) {
                    const r = await wp(wpPlan, [...args]);
                    await log(r.ok ? `Flushed ${label}` : `Couldn't flush ${label}: ${r.out.split('\n').pop()}`);
                }
                await ensureWpHtaccess(wpPlan.container, wpPlan.wpPath).catch(() => {});
            });
        }

        await step('Update WebSync site', async () => {
            const oldBase = site.siteUrl ? stripSlash(site.siteUrl) : null;
            let wpAdminUrl = site.wpAdminUrl;
            if (wpAdminUrl && oldBase && wpAdminUrl.startsWith(oldBase)) wpAdminUrl = plan.newUrl + wpAdminUrl.slice(oldBase.length);
            else if (wpAdminUrl && plan.oldUrl && wpAdminUrl.startsWith(plan.oldUrl)) wpAdminUrl = plan.newUrl + wpAdminUrl.slice(plan.oldUrl.length);
            await prisma.site.update({ where: { id: site.id }, data: { siteUrl: plan.newUrl, wpAdminUrl } });
            // The old address's uptime/SSL results no longer apply.
            await prisma.siteHealth.deleteMany({ where: { siteId: site.id } });
            await log(`Site address set to ${plan.newUrl}`);
        });

        // Not part of the transaction: the change has succeeded, this is tidy-up.
        if (cfPlan?.oldHost && !plan.keepOld) {
            try {
                const zone = await findZone(cfPlan.cfg, cfPlan.oldHost);
                const records = zone ? await getDnsRecords(cfPlan.cfg, zone.id, cfPlan.oldHost) : [];
                const ours = records.find(r => r.type === 'CNAME' && r.content.toLowerCase() === tunnelTarget(cfPlan.cfg));
                if (zone && ours) {
                    await deleteDnsRecord(cfPlan.cfg, zone.id, ours.id);
                    await log(`Removed DNS record for ${cfPlan.oldHost}`);
                }
            } catch (e: any) {
                await log(`Couldn't remove the old DNS record for ${cfPlan.oldHost}: ${e.message}`);
            }
        }

        if (backupFile && backupContainer && site.provisioned) {
            // A copy is in <site>/backups; don't leave a full dump in the container's /tmp.
            const saved = await fs.access(path.posix.join(site.localPath, 'backups', path.posix.basename(backupFile))).then(() => true, () => false);
            if (saved) await executeCommand(backupContainer, ['rm', '-f', backupFile]).catch(() => {});
        }

        const job = await prisma.job.update({
            where: { id: jobId },
            data: { status: 'COMPLETED', progress: 100, endedAt: new Date() },
            include: { site: true }
        });
        broadcastJobUpdate({ type: 'job:completed', job });
        runHealthCheckCycle().catch(() => {});
    } catch (error: any) {
        const message = error?.message || String(error);
        await log(`✖ ${message}`).catch(() => {});
        for (const u of undo.reverse()) {
            try {
                await u.run();
                await log(`Rolled back ${u.label}`).catch(() => {});
            } catch (e: any) {
                await log(`Could not roll back ${u.label}: ${e.message}`).catch(() => {});
            }
        }
        const job = await prisma.job.update({
            where: { id: jobId },
            data: { status: 'FAILED', endedAt: new Date() }
        });
        broadcastJobUpdate({ type: 'job:failed', job, jobId, error: message });
    } finally {
        inFlight.delete(site.id);
    }
};
