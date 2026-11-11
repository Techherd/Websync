import { getDocker, executeCommand, locateWpCli, isBrokenPackagesOutput, repairWpCliPackages } from './docker';

/**
 * Site Doctor: health checks for a site's containers and WordPress install,
 * each with an optional one-click fix. Checks are read-only; fixes only do
 * things that are safe to repeat (start a stopped container, hand files back
 * to www-data, move a broken WP-CLI packages dir aside).
 */

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
    id: string;
    label: string;
    status: DoctorStatus;
    detail?: string;
    /** Label for the fix button, when WebSync can fix this itself. */
    fix?: string;
    /** What to do by hand when there's no automatic fix. */
    hint?: string;
}

export interface DoctorReport {
    siteId: string;
    checkedAt: string;
    checks: DoctorCheck[];
    issues: number;   // warn + fail
    fixable: number;  // issues with a fix
}

export interface DoctorSite {
    id: string;
    siteType?: string | null;
    siteUrl?: string | null;
    wpContainer?: string | null;
    wpPath?: string | null;
    dbContainer?: string | null;
    dockerContainers?: string | null;
}

const MIN_UPLOAD_BYTES = 16 * 1024 * 1024;

const siteContainers = (site: DoctorSite): string[] =>
    [...new Set([
        site.wpContainer,
        site.dbContainer,
        ...(site.dockerContainers || '').split(',')
    ].map(s => (s || '').trim()).filter(Boolean))];

const containerState = async (name: string): Promise<'running' | 'stopped' | 'missing'> => {
    try {
        const info = await getDocker().getContainer(name).inspect();
        return info.State?.Running ? 'running' : 'stopped';
    } catch {
        return 'missing';
    }
};

const sh = (container: string, script: string) => executeCommand(container, ['sh', '-c', script]);

/** Paths under wp-content not owned by www-data. mu-plugins is skipped: those are usually placed by hand. */
const ownershipScript = (wpPath: string, limit: number) =>
    `cd ${wpPath} && find wp-content -path wp-content/mu-plugins -prune -o ! -user www-data -print 2>/dev/null | head -${limit}`;

const parseBytes = (v: string): number => {
    const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*([KMG]?)/i);
    if (!m) return 0;
    const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G'];
    return Number(m[1]) * mult;
};

const normalizeUrl = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();

export const runDoctor = async (site: DoctorSite): Promise<DoctorReport> => {
    const checks: DoctorCheck[] = [];
    const add = (c: DoctorCheck) => checks.push(c);

    const containers = siteContainers(site);
    const states = new Map<string, Awaited<ReturnType<typeof containerState>>>();
    for (const name of containers) {
        const state = await containerState(name);
        states.set(name, state);
        add(state === 'running'
            ? { id: `container:${name}`, label: `Container ${name} is running`, status: 'ok' }
            : state === 'stopped'
                ? { id: `container:${name}`, label: `Container ${name} is running`, status: 'fail', detail: 'The container is stopped.', fix: 'Start container' }
                : { id: `container:${name}`, label: `Container ${name} is running`, status: 'fail', detail: "No container with this name exists on this server.",
                    hint: "Check the container name in the site's settings, or recreate it from its Unraid template." });
    }

    const wp = site.siteType === 'wordpress' ? site.wpContainer : null;
    const wpPath = site.wpPath || '/var/www/html';
    if (!wp) return finish(site.id, checks);
    if (states.get(wp) !== 'running') {
        add({ id: 'wordpress', label: 'WordPress checks', status: 'skip', detail: `Skipped until ${wp} is running.` });
        return finish(site.id, checks);
    }

    // WP-CLI
    const wpCli = await locateWpCli(wp, wpPath);
    let cliWorks = false;
    if (!wpCli) {
        add({ id: 'wpcli', label: 'WP-CLI is available', status: 'fail', detail: `WP-CLI wasn't found in ${wp}.`,
            hint: 'Use an image that includes WP-CLI, such as althe3rd/wordpress-with-cli.' });
    } else {
        const out = await sh(wp, `${wpCli} cli version --allow-root 2>&1`);
        if (isBrokenPackagesOutput(out)) {
            add({ id: 'wpcli', label: 'WP-CLI is working', status: 'fail',
                detail: 'A half-installed WP-CLI package makes every wp command crash, so syncs and logins fail.',
                fix: 'Repair WP-CLI' });
        } else {
            cliWorks = true;
            add({ id: 'wpcli', label: 'WP-CLI is working', status: 'ok', detail: out.split('\n').pop() });
        }
    }

    // File ownership
    const notOwned = (await sh(wp, ownershipScript(wpPath, 6))).split('\n').map(s => s.trim()).filter(Boolean);
    const uploadsExists = (await sh(wp, `test -d ${wpPath}/wp-content/uploads && echo yes || echo no`)).includes('yes');
    if (notOwned.length || !uploadsExists) {
        const parts = [
            ...(!uploadsExists ? ['wp-content/uploads is missing.'] : []),
            ...(notOwned.length ? [`Not writable by WordPress (owned by another user): ${notOwned.slice(0, 5).join(', ')}${notOwned.length > 5 ? ', …' : ''}.`] : [])
        ];
        add({ id: 'ownership', label: 'WordPress can write to wp-content', status: 'fail',
            detail: `${parts.join(' ')} Media uploads, plugin updates and theme installs can fail with "could not be moved".`,
            fix: 'Fix file ownership' });
    } else {
        add({ id: 'ownership', label: 'WordPress can write to wp-content', status: 'ok' });
    }

    // PHP upload limit
    const limits = await sh(wp, `php -r 'echo ini_get("upload_max_filesize")," ",ini_get("post_max_size");' 2>/dev/null`);
    const [uploadMax = '', postMax = ''] = limits.trim().split(/\s+/);
    if (uploadMax) {
        const effective = Math.min(parseBytes(uploadMax), parseBytes(postMax) || Infinity);
        add(effective >= MIN_UPLOAD_BYTES
            ? { id: 'phpLimits', label: 'PHP upload limit', status: 'ok', detail: `upload_max_filesize ${uploadMax}, post_max_size ${postMax}` }
            : { id: 'phpLimits', label: 'PHP upload limit', status: 'warn',
                detail: `upload_max_filesize ${uploadMax}, post_max_size ${postMax}. Larger images, themes and plugins will be rejected.`,
                hint: 'Mount the shared uploads.ini (in the sites folder under config/php/) at /usr/local/etc/php/conf.d/uploads.ini in the container\'s Unraid template.' });
    }

    // Installed + site URL
    if (cliWorks && wpCli) {
        const installed = (await sh(wp, `cd ${wpPath} && ${wpCli} core is-installed --allow-root >/dev/null 2>&1 && echo yes || echo no`)).includes('yes');
        if (!installed) {
            add({ id: 'installed', label: 'WordPress is installed', status: 'fail',
                detail: "WordPress can't reach its database, or it hasn't been installed yet.",
                hint: 'Check the database container and the WORDPRESS_DB_* settings.' });
        } else {
            const siteurl = (await sh(wp, `cd ${wpPath} && ${wpCli} option get siteurl --allow-root 2>/dev/null`)).split('\n').pop()?.trim() || '';
            if (site.siteUrl && siteurl && normalizeUrl(siteurl) !== normalizeUrl(site.siteUrl)) {
                add({ id: 'siteUrl', label: 'Site address matches', status: 'warn',
                    detail: `WordPress thinks its address is ${siteurl}, but WebSync has ${site.siteUrl}.`,
                    hint: 'If the site moved to a new domain, run a search-replace in WordPress; otherwise update the URL in WebSync.' });
            } else {
                add({ id: 'siteUrl', label: 'Site address matches', status: 'ok', detail: siteurl || undefined });
            }
        }
    }

    return finish(site.id, checks);
};

const finish = (siteId: string, checks: DoctorCheck[]): DoctorReport => {
    const issues = checks.filter(c => c.status === 'warn' || c.status === 'fail');
    return {
        siteId,
        checkedAt: new Date().toISOString(),
        checks,
        issues: issues.length,
        fixable: issues.filter(c => c.fix).length
    };
};

/** Apply the fix for one check. Throws if the check has no fix. */
export const applyFix = async (site: DoctorSite, checkId: string): Promise<string> => {
    const wpPath = site.wpPath || '/var/www/html';

    if (checkId.startsWith('container:')) {
        const name = checkId.slice('container:'.length);
        if (!siteContainers(site).includes(name)) throw new Error(`${name} doesn't belong to this site`);
        await getDocker().getContainer(name).start();
        return `Started ${name}`;
    }

    const wp = site.wpContainer;
    if (!wp) throw new Error('This site has no WordPress container');

    if (checkId === 'wpcli') {
        const wpCli = await locateWpCli(wp, wpPath);
        if (!wpCli) throw new Error('WP-CLI not found');
        const r = await repairWpCliPackages(wp, wpCli);
        if (r.error) throw new Error(r.error);
        return r.repaired ? 'Moved the broken WP-CLI packages folder aside' : 'WP-CLI was already working';
    }

    if (checkId === 'ownership') {
        const out = await sh(wp, [
            `cd ${wpPath}`,
            'mkdir -p wp-content/uploads',
            'find wp-content -path wp-content/mu-plugins -prune -o ! -user www-data -exec chown www-data:www-data {} + 2>&1',
            'echo __DONE__'
        ].join(' && '));
        if (!out.includes('__DONE__')) throw new Error(out || 'chown failed');
        return 'Handed wp-content back to www-data';
    }

    throw new Error(`No automatic fix for "${checkId}"`);
};
