import cron, { ScheduledTask } from 'node-cron';
import prisma from './prisma';
import { broadcast } from './websocket';
import { logAudit } from './audit';
import { executeCommand, findWpCli } from './docker';

/**
 * WordPress integrity / malware scanner.
 *
 * Runs entirely READ-ONLY commands inside each site's WordPress container via the
 * existing `executeCommand` plumbing (same channel WebSync uses for WP-CLI). Mirrors
 * the structure of healthMonitor.ts: a per-site runner, a cycle that fans out across
 * sites, and a cron-scheduled background job.
 *
 * Detection is layered:
 *   1. `wp core verify-checksums`   — official WordPress.org checksums for core files.
 *   2. `wp plugin verify-checksums` — official checksums for .org-hosted plugins.
 *   3. PHP files in wp-content/uploads (almost always malicious).
 *   4. Heuristic malware-signature grep over wp-content/*.php (flagged "needs review").
 *   5. Recently-modified PHP files (informational signal).
 *
 * Caveats surfaced to the user, never hidden:
 *   - Checks 1 & 2 require the container to reach api.wordpress.org; if it can't, the
 *     result is reported as `unverified`, not a false "clean".
 *   - Check 4 is heuristic — legitimate plugins use base64_decode() etc. — so matches are
 *     reported as suspicious "needs review", never as confirmed malware.
 */

export type ScanStatus = 'clean' | 'warning' | 'compromised' | 'error' | 'unknown';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Finding {
    category: string;
    severity: Severity;
    title: string;
    paths: string[];
    detail: string;
    remediation: string;
}

export interface ScanResult {
    status: ScanStatus;
    coreStatus: string | null;
    pluginStatus: string | null;
    findings: Finding[];
    findingsCount: number;
    critical: number;
    durationMs: number;
    error: string | null;
}

interface ScannableSite {
    id: string;
    label: string;
    siteType: string;
    wpContainer: string | null;
    wpPath: string | null;
}

const DEFAULT_WP_PATH = '/var/www/html';
const CMD_TIMEOUT_MS = 120_000;
const RECENT_DAYS = 7;
const MAX_PATHS = 200;

// Two-tier signature detection (POSIX ERE — portable across GNU + BusyBox grep).
//
// TIER 1 — high-confidence: patterns rarely present in legitimate code that strongly
// indicate a backdoor/webshell. These keep "high" severity and drive a "compromised"
// status. Scanned across ALL of wp-content (malware can hide inside fake vendor dirs).
const MALWARE_PATTERNS = [
    // Executing user-controlled input directly: eval/system/exec/... ( ... $_GET/$_POST ... )
    // (call_user_func intentionally excluded — legitimate AJAX/hook dispatchers use it.)
    '(eval|assert|create_function|system|exec|shell_exec|passthru|popen|proc_open)[[:space:]]*\\([^)]*\\$_(GET|POST|REQUEST|COOKIE|SERVER|FILES)',
    // Decode-then-execute (packed payloads): eval(base64_decode( … )), assert(gzinflate( … ))
    '(eval|assert)[[:space:]]*\\([[:space:]]*(base64_decode|gzinflate|gzuncompress|str_rot13|gzdecode|hex2bin|convert_uudecode|rawurldecode)[[:space:]]*\\(',
    // Function name supplied by user input:  $_GET[\'x\']( … )
    '\\$_(GET|POST|REQUEST|COOKIE)[[:space:]]*\\[[^]]*\\][[:space:]]*\\(',
    // preg_replace with the /e (code-execution) modifier — strict to avoid matching "/edit" etc.
    'preg_replace[[:space:]]*\\([^,]*/e[^a-zA-Z]',
    // Reversed-string obfuscation of common functions
    '(edoced_46esab|noitcnuf_etaerc)',
    // Distinctive webshell signatures
    '(FilesMan|c99shell|r57shell|b374k|0byt3m1n1)',
].join('|');

// TIER 2 — low-signal: functions that CAN be abused but appear constantly in legitimate
// plugins/libraries. Informational only (never marks a site compromised). Bundled
// third-party libraries are excluded so the list stays short and relevant.
const RISKY_FUNCTION_PATTERNS = [
    'eval[[:space:]]*\\(',
    'base64_decode[[:space:]]*\\(',
    'gzinflate[[:space:]]*\\(',
    'gzuncompress[[:space:]]*\\(',
    'str_rot13[[:space:]]*\\(',
    'create_function[[:space:]]*\\(',
    'assert[[:space:]]*\\(',
    'shell_exec[[:space:]]*\\(',
    'passthru[[:space:]]*\\(',
    'system[[:space:]]*\\(',
    'proc_open[[:space:]]*\\(',
].join('|');

// Bundled-dependency directories excluded from the low-signal (Tier 2) scan.
const LIB_EXCLUDES = ['vendor', 'vendor_prefixed', 'node_modules']
    .map(d => `--exclude-dir=${d}`).join(' ');

const REMEDIATION: Record<string, string> = {
    core_modified:
        'A core file was modified. Re-download a clean copy of WordPress core inside the container ' +
        '(`wp core download --force --skip-content --allow-root`), or restore these files from your ' +
        'last healthy WebSync sync on the other server.',
    core_unexpected:
        'Unexpected file found in a WordPress core directory (wp-admin / wp-includes). These should ' +
        'only contain official files — review and remove it, then re-verify checksums.',
    core_missing:
        'A core file is missing. Re-download clean core (`wp core download --force --skip-content ' +
        '--allow-root`) or restore from your last healthy sync.',
    core_unverified:
        'Core checksums could NOT be verified — the container likely cannot reach api.wordpress.org. ' +
        'This is not a clean result: allow outbound network access from the container, or verify core ' +
        'manually, then re-scan.',
    uploads_php:
        'Executable PHP found under wp-content/uploads. Uploads should never contain PHP — this is a ' +
        'classic backdoor location. Quarantine/remove these files and block PHP execution under ' +
        'wp-content/uploads at the web-server level (nginx/Apache rule).',
    plugin_modified:
        'A plugin file does not match the official WordPress.org checksum. Reinstall the plugin ' +
        '(`wp plugin install <slug> --force --allow-root`) or restore from your clean sync.',
    plugin_unverified:
        'Checksums are not available for these plugins (premium/custom plugins are not on ' +
        'WordPress.org). WebSync cannot auto-verify them — confirm their integrity against your own ' +
        'clean copy.',
    signature:
        'High-confidence backdoor pattern — these execute user input, run packed/obfuscated payloads, ' +
        'or look like known webshells, which legitimate code almost never does. Investigate urgently: ' +
        'open each file, compare against your clean synced copy, and restore from your good server (or ' +
        'remove) if confirmed malicious.',
    signature_review:
        'Low priority — these files use functions (base64_decode, eval, etc.) that are common in ' +
        'legitimate plugins and themes but can be abused. Bundled libraries are excluded. Only worth a ' +
        'look if a file seems out of place, sits outside a known plugin/theme, or was changed ' +
        'unexpectedly. Not a sign of compromise on its own.',
    recent_changes:
        'These PHP files changed recently. Confirm each matches a deploy you performed; investigate ' +
        'anything you did not expect.',
};

// Built-in allowlist: findings WebSync itself causes or that ship with the official
// Docker WordPress image, so they're suppressed out of the box (still listed in the UI
// as "built-in" for transparency). `wp-cli-login-server` is the plugin WebSync installs
// during magic-login setup; flagging it would be self-inflicted noise.
export const BUILTIN_ALLOWLIST_ENTRIES = [
    {
        id: 'builtin:wp-cli-login-server',
        category: 'plugin_unverified',
        path: 'wp-cli-login-server',
        note: 'WebSync-managed magic-login plugin',
        builtin: true as const,
    },
] as const;

const BUILTIN_KEYS = new Set(BUILTIN_ALLOWLIST_ENTRIES.map(e => `${e.category}::${e.path}`));

/** Build the set of `${category}::${path}` keys to suppress (built-ins + user allowlist). */
const loadIgnored = async (): Promise<Set<string>> => {
    const set = new Set<string>(BUILTIN_KEYS);
    try {
        const rows = await prisma.scanAllowlist.findMany();
        for (const r of rows) set.add(`${r.category}::${r.path}`);
    } catch (e) {
        console.error('[SCAN] could not load allowlist', e);
    }
    return set;
};

/** Drop allowlisted paths from a finding's path list. */
const filterIgnored = (category: string, paths: string[], ignored: Set<string>): string[] =>
    paths.filter(p => !ignored.has(`${category}::${p}`));

/** Run a shell command in the container with a hard timeout so a hung scan can't hang forever. */
const runCmd = (container: string, cmd: string): Promise<string> => {
    return Promise.race([
        executeCommand(container, ['sh', '-c', cmd]),
        new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error('Command timed out')), CMD_TIMEOUT_MS)
        ),
    ]);
};

/** Split command output into trimmed, non-empty lines. */
const lines = (out: string): string[] =>
    out.split('\n').map(l => l.trim()).filter(Boolean);

/** Extract the path/value that follows the last ": " on a WP-CLI warning line. */
const tail = (line: string): string => {
    const idx = line.lastIndexOf(': ');
    return (idx >= 0 ? line.slice(idx + 2) : line).trim();
};

const pushFinding = (
    findings: Finding[],
    category: string,
    severity: Severity,
    title: string,
    paths: string[],
    detail: string
) => {
    if (category !== 'core_unverified' && category !== 'plugin_unverified' && paths.length === 0) return;
    findings.push({
        category,
        severity,
        title,
        paths: paths.slice(0, MAX_PATHS),
        detail,
        remediation: REMEDIATION[category] || 'Review this finding manually.',
    });
};

/** Step 1 — verify WordPress core against official checksums. */
const verifyCore = async (
    container: string,
    wpCli: string,
    wpPath: string,
    findings: Finding[],
    ignored: Set<string>
): Promise<string> => {
    let out: string;
    try {
        out = await runCmd(container, `cd ${wpPath} && ${wpCli} core verify-checksums --allow-root 2>&1`);
    } catch (e: any) {
        pushFinding(findings, 'core_unverified', 'medium', 'WordPress core could not be verified', [],
            `Checksum verification failed to run: ${e.message || e}`);
        return 'error';
    }

    const ls = lines(out);
    const couldntFetch = ls.some(l => /could ?n.t (get|retrieve) the checksums|couldn.t get checksums/i.test(l));
    if (couldntFetch) {
        pushFinding(findings, 'core_unverified', 'medium', 'WordPress core could not be verified', [],
            'WP-CLI could not retrieve checksums from WordPress.org.');
        return 'unverified';
    }

    const rawModified: string[] = [];
    const rawUnexpected: string[] = [];
    const rawMissing: string[] = [];
    for (const l of ls) {
        if (!/^warning:/i.test(l)) continue;
        if (/verify against checksum/i.test(l)) rawModified.push(tail(l));
        else if (/should not exist/i.test(l)) rawUnexpected.push(tail(l));
        else if (/does ?n.t exist/i.test(l)) rawMissing.push(tail(l));
    }

    const modified = filterIgnored('core_modified', rawModified, ignored);
    const unexpected = filterIgnored('core_unexpected', rawUnexpected, ignored);
    const missing = filterIgnored('core_missing', rawMissing, ignored);

    pushFinding(findings, 'core_modified', 'critical', 'Modified WordPress core file(s)', modified,
        `${modified.length} core file(s) do not match the official WordPress.org checksum.`);
    pushFinding(findings, 'core_unexpected', 'high', 'Unexpected file(s) in core directories', unexpected,
        `${unexpected.length} file(s) exist in core directories that are not part of WordPress.`);
    pushFinding(findings, 'core_missing', 'high', 'Missing WordPress core file(s)', missing,
        `${missing.length} expected core file(s) are missing.`);

    if (modified.length || unexpected.length || missing.length) return 'modified';
    return 'ok';
};

/** Step 2 — verify installed plugins against official checksums. */
const verifyPlugins = async (
    container: string,
    wpCli: string,
    wpPath: string,
    findings: Finding[],
    ignored: Set<string>
): Promise<string> => {
    let out: string;
    try {
        out = await runCmd(container, `cd ${wpPath} && ${wpCli} plugin verify-checksums --all --allow-root 2>&1`);
    } catch (e: any) {
        pushFinding(findings, 'plugin_unverified', 'info', 'Plugins could not be verified', ['(all)'],
            `Plugin checksum verification failed to run: ${e.message || e}`);
        return 'error';
    }

    const rawModified: string[] = [];
    const rawUnverified: string[] = [];
    for (const l of lines(out)) {
        if (!/^warning:/i.test(l)) continue;
        if (/verify against checksum|should not exist/i.test(l)) rawModified.push(tail(l));
        else if (/could ?n.t (get|retrieve) the checksums|no checksums/i.test(l)) {
            const m = l.match(/of (?:plugin )?["']?([\w-]+)/i);
            rawUnverified.push(m ? m[1] : tail(l));
        }
    }

    const modified = filterIgnored('plugin_modified', rawModified, ignored);
    const unverified = filterIgnored('plugin_unverified', rawUnverified, ignored);

    pushFinding(findings, 'plugin_modified', 'high', 'Modified plugin file(s)', modified,
        `${modified.length} plugin file(s) do not match the official WordPress.org checksum.`);
    if (unverified.length) {
        pushFinding(findings, 'plugin_unverified', 'info', 'Plugins without official checksums', unverified,
            `${unverified.length} plugin(s) are not on WordPress.org and cannot be auto-verified.`);
    }

    if (modified.length) return 'modified';
    if (unverified.length) return 'unverified';
    return 'ok';
};

/** Step 3 — PHP files under wp-content/uploads (almost always malicious). */
const scanUploads = async (container: string, wpPath: string, findings: Finding[], ignored: Set<string>): Promise<void> => {
    try {
        const out = await runCmd(container,
            `find ${wpPath}/wp-content/uploads -type f -iname '*.ph*' 2>/dev/null | head -${MAX_PATHS}`);
        const hits = filterIgnored('uploads_php', lines(out), ignored);
        pushFinding(findings, 'uploads_php', 'critical', 'Executable PHP in uploads directory', hits,
            `${hits.length} PHP file(s) found under wp-content/uploads.`);
    } catch { /* non-fatal */ }
};

/** Step 4a — high-confidence malware/backdoor signatures (drives "compromised"). */
const scanMalwareSignatures = async (container: string, wpPath: string, findings: Finding[], ignored: Set<string>): Promise<void> => {
    try {
        const out = await runCmd(container,
            `grep -rlE '${MALWARE_PATTERNS}' ${wpPath}/wp-content --include='*.php' 2>/dev/null | head -${MAX_PATHS}`);
        const hits = filterIgnored('signature', lines(out), ignored);
        pushFinding(findings, 'signature', 'high', 'Likely malware / backdoor code', hits,
            `${hits.length} file(s) contain high-confidence backdoor patterns (executing user input, ` +
            `packed/obfuscated payloads, or known webshell markers). Review these urgently.`);
    } catch { /* non-fatal */ }
};

/** Step 4b — files using risky-but-common functions (informational; libraries excluded). */
const scanRiskyFunctions = async (container: string, wpPath: string, findings: Finding[], ignored: Set<string>): Promise<void> => {
    try {
        const out = await runCmd(container,
            `grep -rlE '${RISKY_FUNCTION_PATTERNS}' ${wpPath}/wp-content --include='*.php' ${LIB_EXCLUDES} 2>/dev/null | head -${MAX_PATHS}`);
        const hits = filterIgnored('signature_review', lines(out), ignored);
        pushFinding(findings, 'signature_review', 'info', 'Files using functions that can be abused (low priority)', hits,
            `${hits.length} plugin/theme file(s) use functions like base64_decode/eval that are common in ` +
            `legitimate code. Bundled libraries are excluded. Informational — not a sign of compromise on its own.`);
    } catch { /* non-fatal */ }
};

/** Step 5 — recently modified PHP files (informational). */
const scanRecentChanges = async (container: string, wpPath: string, findings: Finding[], ignored: Set<string>): Promise<void> => {
    try {
        const out = await runCmd(container,
            `find ${wpPath}/wp-content -type f -name '*.php' -mtime -${RECENT_DAYS} 2>/dev/null | head -${MAX_PATHS}`);
        const hits = filterIgnored('recent_changes', lines(out), ignored);
        pushFinding(findings, 'recent_changes', 'info', `PHP files changed in the last ${RECENT_DAYS} days`, hits,
            `${hits.length} PHP file(s) under wp-content were modified recently.`);
    } catch { /* non-fatal */ }
};

const aggregateStatus = (findings: Finding[], coreStatus: string): ScanStatus => {
    const has = (s: Severity) => findings.some(f => f.severity === s);
    if (has('critical') || has('high')) return 'compromised';
    if (has('medium') || has('low')) return 'warning';
    // Couldn't fully verify core but found nothing → not a confident "clean".
    if (coreStatus === 'unverified' || coreStatus === 'error') return 'warning';
    return 'clean';
};

/**
 * Run a full integrity/malware scan for one site, persist a SiteScan row, broadcast the
 * result, and audit a `security.compromised` event when warranted. Returns the result.
 */
export const runSiteScan = async (site: ScannableSite): Promise<ScanResult> => {
    const startedAt = Date.now();
    const findings: Finding[] = [];

    const fail = async (message: string): Promise<ScanResult> => {
        const result: ScanResult = {
            status: 'error', coreStatus: 'skipped', pluginStatus: 'skipped',
            findings: [], findingsCount: 0, critical: 0,
            durationMs: Date.now() - startedAt, error: message,
        };
        await persist(site.id, result);
        return result;
    };

    if (site.siteType !== 'wordpress') return fail('Site is not a WordPress site');
    if (!site.wpContainer) return fail('WordPress container not configured');

    const wpPath = site.wpPath || DEFAULT_WP_PATH;
    const wpCli = await findWpCli(site.wpContainer, wpPath).catch(() => null);
    if (!wpCli) return fail('WP-CLI not found in container');

    // Confirm WordPress is actually installed at wpPath before trusting any check.
    try {
        const installed = await runCmd(site.wpContainer,
            `cd ${wpPath} && ${wpCli} core is-installed --allow-root 2>&1 && echo __WP_OK__ || echo __WP_NO__`);
        if (!installed.includes('__WP_OK__')) return fail(`WordPress not found at ${wpPath}`);
    } catch (e: any) {
        return fail(`Could not reach WordPress in container: ${e.message || e}`);
    }

    const ignored = await loadIgnored();
    const coreStatus = await verifyCore(site.wpContainer, wpCli, wpPath, findings, ignored);
    const pluginStatus = await verifyPlugins(site.wpContainer, wpCli, wpPath, findings, ignored);
    await scanUploads(site.wpContainer, wpPath, findings, ignored);
    await scanMalwareSignatures(site.wpContainer, wpPath, findings, ignored);
    await scanRiskyFunctions(site.wpContainer, wpPath, findings, ignored);
    await scanRecentChanges(site.wpContainer, wpPath, findings, ignored);

    const critical = findings.filter(f => f.severity === 'critical').length;
    const result: ScanResult = {
        status: aggregateStatus(findings, coreStatus),
        coreStatus,
        pluginStatus,
        findings,
        findingsCount: findings.length,
        critical,
        durationMs: Date.now() - startedAt,
        error: null,
    };

    await persist(site.id, result);

    if (result.status === 'compromised') {
        await logAudit(null, 'security.compromised', site.id, {
            critical: result.critical,
            findingsCount: result.findingsCount,
            categories: findings.map(f => f.category),
        });
    }

    return result;
};

/** Persist a scan row and broadcast it to connected dashboards. */
const persist = async (siteId: string, result: ScanResult): Promise<void> => {
    const row = await prisma.siteScan.create({
        data: {
            siteId,
            status: result.status,
            coreStatus: result.coreStatus,
            pluginStatus: result.pluginStatus,
            findingsCount: result.findingsCount,
            critical: result.critical,
            findings: JSON.stringify(result.findings),
            durationMs: result.durationMs,
            error: result.error,
        },
    });

    broadcast({
        type: 'site:scan',
        siteId,
        scan: {
            id: row.id,
            status: row.status,
            coreStatus: row.coreStatus,
            pluginStatus: row.pluginStatus,
            findingsCount: row.findingsCount,
            critical: row.critical,
            createdAt: row.createdAt,
        },
    });
};

/** Scan every WordPress site that has a container configured, with a small concurrency cap. */
export const runScanCycle = async (): Promise<void> => {
    const sites = await prisma.site.findMany({
        where: { siteType: 'wordpress', wpContainer: { not: null } },
        select: { id: true, label: true, siteType: true, wpContainer: true, wpPath: true },
    });
    const concurrency = 2; // scans are heavier than health pings
    for (let i = 0; i < sites.length; i += concurrency) {
        await Promise.all(
            sites.slice(i, i + concurrency).map(s =>
                runSiteScan(s).catch(err => console.error(`[SCAN] failed for "${s.label}"`, err))
            )
        );
    }
};

let task: ScheduledTask | null = null;

export const startSecurityScanner = (): void => {
    if (task) return;
    console.log('[SCAN] Starting WordPress integrity scanner (daily at 03:30)');
    task = cron.schedule('30 3 * * *', () => {
        runScanCycle().catch(err => console.error('[SCAN] cycle error', err));
    });
    // First run shortly after boot so dashboards aren't blank (offset from the health monitor).
    setTimeout(() => {
        runScanCycle().catch(err => console.error('[SCAN] initial cycle error', err));
    }, 15_000);
};
