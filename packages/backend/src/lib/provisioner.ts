import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import prisma from './prisma';
import { getDocker, executeCommand, generateWpAdmin } from './docker';
import { toHostPath } from './hostPaths';
import { encrypt } from './crypto';
import { broadcastJobUpdate } from './websocket';
import { refreshScheduler } from './scheduler';
import {
    UNRAID_TEMPLATES_DIR,
    UnraidTemplate,
    writeTemplate,
    templatePath,
    templatePorts,
    userNetworksPreserved
} from './unraidTemplate';

/**
 * One-click site provisioning: creates the folders, containers and Unraid
 * templates for a new WordPress or static site, then registers it as a
 * WebSync site. Everything created is rolled back if a step fails.
 */

export const SITES_NETWORK = 'websync-sites';
const WP_ICON = 'https://s.w.org/style/images/about/WordPress-logotype-wmark.png';
const MARIADB_ICON = 'https://github.com/mgutt/unraid-docker-templates/raw/main/mgutt/images/mariadb.png';
const NGINX_ICON = 'https://raw.githubusercontent.com/linuxserver/docker-templates/master/linuxserver.io/img/nginx-logo.png';
const MARIADB_IMAGE = 'mariadb';
const WP_ROOT = '/var/www/html';

export type ProvisionType = 'wordpress' | 'static';

export interface ProvisionInput {
    type: ProvisionType;
    name: string;
    slug: string;
    domain?: string | null;
    adminEmail?: string | null;
}

export interface PreflightCheck {
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'fail';
    detail?: string;
    fix?: string;
}

interface ProvisionPlan {
    input: ProvisionInput;
    siteDir: string;            // as WebSync sees it
    wwwDir: string;
    dbDir: string | null;
    uploadsIni: string | null;  // shared PHP upload overrides, if present
    webContainer: string;
    dbContainer: string | null;
    webImage: string;
    webPort: number;
    siteUrl: string | null;
    db: { name: string; user: string; password: string } | null;
}

const inFlight = new Set<string>();

const randomSecret = (length = 24): string =>
    crypto.randomBytes(length * 2).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, length);

const exists = async (p: string): Promise<boolean> =>
    fs.access(p).then(() => true, () => false);

const getSettings = async () => {
    const s = await prisma.settings.findUnique({ where: { id: 'default' } });
    return {
        sitesRoot: s?.provisionSitesRoot || '/mnt/user/appdata/websites',
        webPortStart: s?.provisionWebPortStart || 8100,
        hostIp: s?.provisionHostIp || null,
        wordpressImage: s?.wordpressImage || 'althe3rd/wordpress-with-cli:latest',
        staticImage: s?.staticImage || 'nginx:alpine'
    };
};

const containerNames = (input: Pick<ProvisionInput, 'type' | 'slug'>) => ({
    web: `Website-${input.slug}`,
    db: input.type === 'wordpress' ? `${input.slug}-MariaDB` : null
});

const findFreePort = async (start: number): Promise<number> => {
    const used = await templatePorts();
    for (const c of await getDocker().listContainers({ all: true })) {
        for (const p of c.Ports || []) if (p.PublicPort) used.add(p.PublicPort);
    }
    let port = start;
    while (used.has(port)) port++;
    return port;
};

const buildPlan = async (input: ProvisionInput): Promise<ProvisionPlan> => {
    const settings = await getSettings();
    const names = containerNames(input);
    const siteDir = path.posix.join(settings.sitesRoot, input.slug);
    const uploadsIni = path.posix.join(settings.sitesRoot, 'config/php/uploads.ini');
    const webPort = await findFreePort(settings.webPortStart);
    const siteUrl = input.domain
        ? `https://${input.domain}`
        : settings.hostIp ? `http://${settings.hostIp}:${webPort}` : null;
    const dbBase = input.slug.replace(/-/g, '_');
    return {
        input,
        siteDir,
        wwwDir: path.posix.join(siteDir, 'www'),
        dbDir: names.db ? path.posix.join(path.posix.dirname(settings.sitesRoot), `${input.slug}-mariadb`) : null,
        uploadsIni: input.type === 'wordpress' && await exists(uploadsIni) ? uploadsIni : null,
        webContainer: names.web,
        dbContainer: names.db,
        webImage: input.type === 'wordpress' ? settings.wordpressImage : settings.staticImage,
        webPort,
        siteUrl,
        db: names.db ? { name: `${dbBase}db`, user: `${dbBase}db_user`, password: randomSecret() } : null
    };
};

const containerExists = async (name: string): Promise<boolean> =>
    getDocker().getContainer(name).inspect().then(() => true, () => false);

const imagePresent = async (image: string): Promise<boolean> =>
    getDocker().getImage(image).inspect().then(() => true, () => false);

/**
 * Everything that must be true before provisioning starts. A `fail` blocks the
 * run; a `warn` is shown but doesn't.
 */
export const preflight = async (input: ProvisionInput): Promise<{ checks: PreflightCheck[]; plan: ProvisionPlan | null }> => {
    const checks: PreflightCheck[] = [];
    const add = (c: PreflightCheck) => checks.push(c);

    try {
        await getDocker().ping();
        add({ id: 'docker', label: 'Docker is reachable', status: 'ok' });
    } catch (e: any) {
        add({ id: 'docker', label: 'Docker is reachable', status: 'fail', detail: e.message,
            fix: 'Mount /var/run/docker.sock into the WebSync container.' });
        return { checks, plan: null };
    }

    try {
        await fs.access(UNRAID_TEMPLATES_DIR, fs.constants.W_OK);
        add({ id: 'templates', label: 'Unraid templates folder is writable', status: 'ok' });
    } catch {
        add({ id: 'templates', label: 'Unraid templates folder is writable', status: 'fail',
            detail: `${UNRAID_TEMPLATES_DIR} isn't mounted or isn't writable.`,
            fix: `Add a path to the WebSync container: ${UNRAID_TEMPLATES_DIR} → ${UNRAID_TEMPLATES_DIR} (read/write).` });
    }

    const preserved = await userNetworksPreserved();
    if (preserved === true) {
        add({ id: 'network', label: 'Unraid keeps custom Docker networks', status: 'ok' });
    } else if (preserved === false) {
        add({ id: 'network', label: 'Unraid keeps custom Docker networks', status: 'fail',
            detail: `Unraid deletes the "${SITES_NETWORK}" network whenever Docker restarts, which would cut sites off from their databases.`,
            fix: 'In Unraid, go to Settings → Docker, stop the Docker service, set "Preserve user defined networks" to Yes, and start it again.' });
    } else {
        add({ id: 'network', label: 'Unraid keeps custom Docker networks', status: 'warn',
            detail: "Couldn't read Unraid's docker.cfg, so this wasn't checked.",
            fix: 'Mount /boot/config/docker.cfg into WebSync (read-only), or confirm "Preserve user defined networks" is on in Settings → Docker.' });
    }

    const plan = await buildPlan(input);
    const settings = await getSettings();

    try {
        await fs.access(settings.sitesRoot, fs.constants.W_OK);
        await toHostPath(settings.sitesRoot);
        add({ id: 'sitesRoot', label: 'Sites folder is available', status: 'ok', detail: settings.sitesRoot });
    } catch (e: any) {
        add({ id: 'sitesRoot', label: 'Sites folder is available', status: 'fail',
            detail: e.code ? `${settings.sitesRoot} isn't writable from WebSync.` : e.message,
            fix: 'Check the sites folder in Settings → Provisioning, and that it sits on a volume mounted into WebSync.' });
    }

    const taken: string[] = [];
    for (const name of [plan.webContainer, plan.dbContainer].filter(Boolean) as string[]) {
        if (await containerExists(name)) taken.push(`container ${name}`);
        if (await exists(templatePath(name))) taken.push(`template my-${name}.xml`);
    }
    for (const dir of [plan.siteDir, plan.dbDir].filter(Boolean) as string[]) {
        if (await exists(dir)) taken.push(`folder ${dir}`);
    }
    if (await prisma.site.findFirst({ where: { localPath: `${plan.siteDir}/` } })) taken.push('a WebSync site with this folder');
    if (inFlight.has(input.slug)) taken.push('a provisioning run already in progress');
    add(taken.length
        ? { id: 'names', label: 'Name is available', status: 'fail', detail: `Already exists: ${taken.join(', ')}.`,
            fix: 'Pick a different short name.' }
        : { id: 'names', label: 'Name is available', status: 'ok' });

    add({ id: 'port', label: 'Web port', status: 'ok', detail: `Port ${plan.webPort} on the server` });

    if (!plan.siteUrl) {
        add({ id: 'url', label: 'Site address', status: 'fail',
            detail: "No domain was entered and the server's LAN IP isn't set.",
            fix: 'Enter a domain, or set the server LAN IP in Settings → Provisioning.' });
    }

    for (const image of [plan.webImage, plan.dbContainer ? MARIADB_IMAGE : null].filter(Boolean) as string[]) {
        add(await imagePresent(image)
            ? { id: `image:${image}`, label: `Image ${image}`, status: 'ok' }
            : { id: `image:${image}`, label: `Image ${image}`, status: 'warn', detail: 'Not downloaded yet; it will be pulled first (this can take a minute).' });
    }

    return { checks, plan };
};

// ---------------------------------------------------------------------------

type Undo = { label: string; run: () => Promise<unknown> };

const unraidEnv = (containerName: string): string[] => [
    `TZ=${process.env.TZ || 'UTC'}`,
    'HOST_OS=Unraid',
    `HOST_HOSTNAME=${process.env.HOST_HOSTNAME || ''}`,
    `HOST_CONTAINERNAME=${containerName}`
];

const unraidLabels = (icon: string, webUI?: string): Record<string, string> => ({
    'net.unraid.docker.managed': 'dockerman',
    'net.unraid.docker.icon': icon,
    ...(webUI ? { 'net.unraid.docker.webui': webUI } : {}),
    'websync.provisioned': 'true'
});

const pullImage = async (image: string): Promise<void> => {
    const docker = getDocker();
    const stream = await docker.pull(image);
    await new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()))
    );
};

const waitFor = async (what: string, timeoutMs: number, check: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check().catch(() => false)) return;
        await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
};

const mkdirOwned = async (dir: string, uid?: number, gid?: number): Promise<void> => {
    await fs.mkdir(dir, { recursive: true });
    if (uid !== undefined && gid !== undefined) await fs.chown(dir, uid, gid).catch(() => {});
};

/**
 * Run a provisioning job. `preflight` must have passed; this re-validates
 * nothing beyond what Docker itself enforces (name collisions etc.).
 */
export const provisionSite = async (
    input: ProvisionInput,
    jobId: string,
    userId: string | null
): Promise<void> => {
    if (inFlight.has(input.slug)) throw new Error(`Already provisioning ${input.slug}`);
    inFlight.add(input.slug);

    const docker = getDocker();
    const undo: Undo[] = [];
    const logs: string[] = [];
    const plan = await buildPlan(input);
    const isWp = input.type === 'wordpress';
    const stepNames = [
        'Create folders',
        ...(isWp ? ['Create site network'] : []),
        'Download images',
        ...(isWp ? ['Start database', 'Start WordPress', 'Install WordPress'] : ['Start web server']),
        'Write Unraid templates',
        'Register site in WebSync'
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
        const hostSiteDir = await toHostPath(plan.siteDir);
        const hostWww = `${hostSiteDir}/www`;

        await step('Create folders', async () => {
            await mkdirOwned(plan.siteDir);
            undo.push({ label: `folder ${plan.siteDir}`, run: () => fs.rm(plan.siteDir, { recursive: true, force: true }) });
            // www-data in the WordPress image is uid 33; nginx only needs to read.
            await mkdirOwned(plan.wwwDir, isWp ? 33 : undefined, isWp ? 33 : undefined);
            if (!isWp) {
                await fs.writeFile(path.posix.join(plan.wwwDir, 'index.html'), placeholderPage(input.name));
            }
            if (plan.dbDir) {
                await mkdirOwned(plan.dbDir, 99, 100);
                undo.push({ label: `folder ${plan.dbDir}`, run: () => fs.rm(plan.dbDir!, { recursive: true, force: true }) });
                await mkdirOwned(`${plan.dbDir}/data`, 99, 100);
                await mkdirOwned(`${plan.dbDir}/config`, 99, 100);
            }
            await log(`Created ${plan.siteDir}${plan.dbDir ? ` and ${plan.dbDir}` : ''}`);
        });

        if (isWp) {
            await step('Create site network', async () => {
                const existing = await docker.listNetworks({ filters: { name: [SITES_NETWORK] } });
                if (existing.some(n => n.Name === SITES_NETWORK)) {
                    await log(`Using existing network ${SITES_NETWORK}`);
                    return;
                }
                const network = await docker.createNetwork({ Name: SITES_NETWORK, Driver: 'bridge', Labels: { 'websync.provisioned': 'true' } });
                undo.push({ label: `network ${SITES_NETWORK}`, run: () => network.remove() });
                await log(`Created network ${SITES_NETWORK}`);
            });
        }

        await step('Download images', async () => {
            for (const image of [plan.webImage, plan.dbContainer ? MARIADB_IMAGE : null].filter(Boolean) as string[]) {
                if (await imagePresent(image)) continue;
                await log(`Pulling ${image}…`);
                await pullImage(image);
            }
        });

        const webTemplate: UnraidTemplate = isWp
            ? wordpressTemplate(plan, hostWww, plan.uploadsIni ? await toHostPath(plan.uploadsIni) : null)
            : staticTemplate(plan, hostWww);
        const dbTemplate: UnraidTemplate | null = plan.dbContainer
            ? mariadbTemplate(plan, await toHostPath(plan.dbDir!))
            : null;

        if (dbTemplate && plan.db) {
            await step('Start database', async () => {
                const container = await docker.createContainer({
                    name: dbTemplate.name,
                    Image: MARIADB_IMAGE,
                    User: '99:100',
                    Env: [
                        ...unraidEnv(dbTemplate.name),
                        'MARIADB_RANDOM_ROOT_PASSWORD=yes',
                        `MARIADB_DATABASE=${plan.db!.name}`,
                        `MARIADB_USER=${plan.db!.user}`,
                        `MARIADB_PASSWORD=${plan.db!.password}`
                    ],
                    Labels: unraidLabels(MARIADB_ICON),
                    HostConfig: {
                        Binds: [
                            `${await toHostPath(`${plan.dbDir}/data`)}:/var/lib/mysql:rw`,
                            `${await toHostPath(`${plan.dbDir}/config`)}:/etc/mysql/conf.d:rw`
                        ],
                        Memory: 2 * 1024 ** 3,
                        RestartPolicy: { Name: 'unless-stopped' },
                        NetworkMode: SITES_NETWORK
                    }
                });
                undo.push({ label: `container ${dbTemplate.name}`, run: () => container.remove({ force: true }) });
                await container.start();
                // -h 127.0.0.1 forces TCP, which stays off during MariaDB's first-run init,
                // so this only succeeds once the real server is up.
                await waitFor('the database to start', 120_000, async () => {
                    const out = await executeCommand(dbTemplate.name, [
                        'mariadb-admin', 'ping', '-h', '127.0.0.1', `-u${plan.db!.user}`, `-p${plan.db!.password}`
                    ]);
                    return out.includes('is alive');
                });
                await log(`Database ${plan.db!.name} is running in ${dbTemplate.name}`);
            });
        }

        await step(isWp ? 'Start WordPress' : 'Start web server', async () => {
            const containerPort = '80/tcp';
            const binds = isWp
                ? [`${hostWww}:${WP_ROOT}:rw`, ...(plan.uploadsIni ? [`${await toHostPath(plan.uploadsIni)}:/usr/local/etc/php/conf.d/uploads.ini:rw`] : [])]
                : [`${hostWww}:/usr/share/nginx/html:ro`];
            const container = await docker.createContainer({
                name: webTemplate.name,
                Image: plan.webImage,
                Env: [
                    ...unraidEnv(webTemplate.name),
                    ...(isWp && plan.db ? [
                        `WORDPRESS_DB_HOST=${plan.dbContainer}`,
                        `WORDPRESS_DB_USER=${plan.db.user}`,
                        `WORDPRESS_DB_PASSWORD=${plan.db.password}`,
                        `WORDPRESS_DB_NAME=${plan.db.name}`
                    ] : [])
                ],
                Labels: unraidLabels(webTemplate.icon!, webTemplate.webUI),
                ExposedPorts: { [containerPort]: {} },
                HostConfig: {
                    Binds: binds,
                    PortBindings: { [containerPort]: [{ HostPort: String(plan.webPort) }] },
                    RestartPolicy: { Name: 'unless-stopped' },
                    NetworkMode: isWp ? SITES_NETWORK : 'bridge'
                }
            });
            undo.push({ label: `container ${webTemplate.name}`, run: () => container.remove({ force: true }) });
            await container.start();
            if (isWp) {
                // The image's entrypoint copies WordPress into the empty volume and writes wp-config.php.
                await waitFor('WordPress files to be copied', 120_000, async () => {
                    const out = await executeCommand(webTemplate.name, [
                        'sh', '-c', `test -f ${WP_ROOT}/wp-includes/version.php && test -f ${WP_ROOT}/wp-config.php && echo ready`
                    ]);
                    return out.includes('ready');
                });
            }
            await log(`${webTemplate.name} is running on port ${plan.webPort}`);
        });

        let credential: { username: string; password: string } | null = null;
        if (isWp) {
            await step('Install WordPress', async () => {
                const out = await executeCommand(webTemplate.name, [
                    'wp', 'core', 'install',
                    `--path=${WP_ROOT}`,
                    `--url=${plan.siteUrl}`,
                    `--title=${input.name}`,
                    '--admin_user=websync_admin',
                    `--admin_password=${randomSecret()}`,
                    `--admin_email=${input.adminEmail || 'websync_admin@websync.local'}`,
                    '--skip-email',
                    '--allow-root'
                ]);
                await log(out);
                if (!/success:/i.test(out)) throw new Error(`wp core install failed: ${out.split('\n').pop()}`);
                // Rotates websync_admin's password and hands back credentials we can store.
                const admin = await generateWpAdmin(webTemplate.name, WP_ROOT);
                if (!admin.success || !admin.username || !admin.password) {
                    throw new Error(admin.error || 'Could not create the WebSync admin user');
                }
                credential = { username: admin.username, password: admin.password };
                await log(`WordPress installed; admin user ${admin.username}`);
            });
        }

        await step('Write Unraid templates', async () => {
            for (const t of [dbTemplate, webTemplate].filter(Boolean) as UnraidTemplate[]) {
                const file = await writeTemplate(t);
                undo.push({ label: `template ${file}`, run: () => fs.unlink(file) });
                await log(`Wrote ${file}`);
            }
        });

        await step('Register site in WebSync', async () => {
            const cred = credential as { username: string; password: string } | null;
            const site = await prisma.site.create({
                data: {
                    label: input.name,
                    localPath: `${plan.siteDir}/`,
                    remotePath: `${plan.siteDir}/`,
                    siteType: input.type,
                    siteUrl: plan.siteUrl,
                    wpContainer: isWp ? plan.webContainer : null,
                    wpPath: isWp ? WP_ROOT : null,
                    dockerContainers: [plan.webContainer, plan.dbContainer].filter(Boolean).join(','),
                    dbContainer: plan.dbContainer,
                    dbType: plan.db ? 'mysql' : null,
                    dbUser: plan.db?.user || null,
                    dbPassword: plan.db?.password || null,
                    dbName: plan.db?.name || null,
                    provisioned: true,
                    createdById: userId,
                    ...(cred ? {
                        wpCredential: { create: { username: cred.username, password: encrypt(cred.password) } }
                    } : {})
                }
            });
            await refreshScheduler();
            await prisma.job.update({ where: { id: jobId }, data: { siteId: site.id } });
            await log(`Registered site ${site.id}`);
        });

        const job = await prisma.job.update({
            where: { id: jobId },
            data: { status: 'COMPLETED', progress: 100, endedAt: new Date() },
            include: { site: true }
        });
        broadcastJobUpdate({ type: 'job:completed', job });
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
        inFlight.delete(input.slug);
    }
};

// ---------------------------------------------------------------------------
// Unraid templates. These mirror the hand-made Kru-x WordPress and mgutt
// MariaDB-Official templates already on th-mh, so Edit/Update in Unraid
// rebuild the containers exactly as WebSync created them.

const wordpressTemplate = (plan: ProvisionPlan, hostWww: string, hostUploadsIni: string | null): UnraidTemplate => ({
    name: plan.webContainer,
    repository: plan.webImage,
    registry: 'https://hub.docker.com/_/wordpress/',
    network: SITES_NETWORK,
    webUI: 'http://[IP]:[PORT:80]/',
    icon: WP_ICON,
    project: 'https://wordpress.org/',
    overview: `WordPress site "${plan.input.name}", created by WebSync.`,
    category: 'Other: Network:Web',
    extraParams: '--restart unless-stopped',
    configs: [
        { name: 'Container port', target: '80', type: 'Port', mode: 'tcp', value: String(plan.webPort) },
        { name: 'www', target: WP_ROOT, type: 'Path', mode: 'rw', value: hostWww },
        { name: 'WORDPRESS_DB_HOST', target: 'WORDPRESS_DB_HOST', type: 'Variable', value: plan.dbContainer! },
        { name: 'WORDPRESS_DB_USER', target: 'WORDPRESS_DB_USER', type: 'Variable', value: plan.db!.user },
        { name: 'WORDPRESS_DB_PASSWORD', target: 'WORDPRESS_DB_PASSWORD', type: 'Variable', value: plan.db!.password, mask: true },
        { name: 'WORDPRESS_DB_NAME', target: 'WORDPRESS_DB_NAME', type: 'Variable', value: plan.db!.name },
        ...(hostUploadsIni ? [{ name: 'Uploads Overrides', target: '/usr/local/etc/php/conf.d/uploads.ini', type: 'Path' as const, mode: 'rw', value: hostUploadsIni }] : [])
    ]
});

const mariadbTemplate = (plan: ProvisionPlan, hostDbDir: string): UnraidTemplate => ({
    name: plan.dbContainer!,
    repository: MARIADB_IMAGE,
    registry: 'https://hub.docker.com/_/mariadb',
    network: SITES_NETWORK,
    icon: MARIADB_ICON,
    project: 'https://mariadb.org/',
    overview: `Database for "${plan.input.name}", created by WebSync. Only reachable from containers on the ${SITES_NETWORK} network.`,
    category: 'Tools:Utilities Other: Network:Other',
    extraParams: '--user=99:100 --memory=2G --restart unless-stopped',
    configs: [
        { name: 'Generate Random Password', target: 'MARIADB_RANDOM_ROOT_PASSWORD', type: 'Variable', value: 'yes' },
        { name: 'Database Name', target: 'MARIADB_DATABASE', type: 'Variable', value: plan.db!.name, required: true },
        { name: 'Database User', target: 'MARIADB_USER', type: 'Variable', value: plan.db!.user, required: true },
        { name: 'Database Password', target: 'MARIADB_PASSWORD', type: 'Variable', value: plan.db!.password, required: true, mask: true },
        { name: 'Data', target: '/var/lib/mysql', type: 'Path', mode: 'rw', value: `${hostDbDir}/data`, required: true },
        { name: 'Config', target: '/etc/mysql/conf.d', type: 'Path', mode: 'rw', value: `${hostDbDir}/config`, required: true, display: 'always-hide' }
    ]
});

const staticTemplate = (plan: ProvisionPlan, hostWww: string): UnraidTemplate => ({
    name: plan.webContainer,
    repository: plan.webImage,
    registry: 'https://hub.docker.com/_/nginx',
    network: 'bridge',
    webUI: 'http://[IP]:[PORT:80]/',
    icon: NGINX_ICON,
    project: 'https://nginx.org/',
    overview: `Static site "${plan.input.name}", created by WebSync.`,
    category: 'Other: Network:Web',
    extraParams: '--restart unless-stopped',
    configs: [
        { name: 'Container port', target: '80', type: 'Port', mode: 'tcp', value: String(plan.webPort) },
        { name: 'www', target: '/usr/share/nginx/html', type: 'Path', mode: 'ro', value: hostWww }
    ]
});

const placeholderPage = (name: string): string => {
    const safe = name.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]!));
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safe}</title></head>
<body style="font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0;">
<main><h1>${safe}</h1><p>This site is ready. Upload your files to replace this page.</p></main>
</body>
</html>
`;
};
