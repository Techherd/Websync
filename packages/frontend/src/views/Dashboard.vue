<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useApi } from '../composables/useApi';
import { useJobUpdates } from '../composables/useWebSocket';
import { useToast } from '../composables/useToast';
import StatusBadge from '../components/StatusBadge.vue';
import SyncProgress from '../components/SyncProgress.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

interface Site {
  id: string;
  label: string;
  localPath: string;
  remotePath: string;
    // Site type
    siteType?: 'wordpress' | 'laravel' | 'static' | 'node' | 'custom';
    // WordPress-specific
    wpContainer?: string;
    wpPath?: string;
    wpAdminUrl?: string;
    // Quick links
    editorUrl?: string;
    siteUrl?: string;
    schedule?: string;
    dbContainer?: string;
    dbType?: string;
    dbUser?: string;
    dbPassword?: string;
    dbName?: string;
    // Remote container management
    remoteContainers?: string;
    autoStartRemote?: boolean;
    // Remote database
    remoteDbContainer?: string;
    remoteDbUser?: string;
    remoteDbPassword?: string;
    remoteDbName?: string;
    jobs?: any[];
    health?: SiteHealth | null;
    latestScan?: SiteScan | null;
}

interface SiteHealth {
    status: 'up' | 'degraded' | 'down' | 'unknown';
    httpStatus?: number | null;
    responseMs?: number | null;
    sslExpiresAt?: string | null;
    error?: string | null;
    lastCheckedAt?: string | null;
}

type ScanStatus = 'clean' | 'warning' | 'compromised' | 'error' | 'unknown';
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface ScanFinding {
    category: string;
    severity: Severity;
    title: string;
    paths: string[];
    detail: string;
    remediation: string;
}

interface SiteScan {
    id?: string;
    status: ScanStatus;
    coreStatus?: string | null;
    pluginStatus?: string | null;
    findings?: ScanFinding[];
    findingsCount?: number;
    critical?: number;
    durationMs?: number;
    error?: string | null;
    createdAt?: string;
}

interface AllowlistEntry {
    id: string;
    category: string;
    path: string;
    note?: string | null;
    builtin?: boolean;
}

interface WpAdminCredentials {
    username: string;
    password: string;
    lastRotated?: string;
    loginUrl?: string;
    reused?: boolean;
    justRotated?: boolean;
}

interface SettingsStatus {
    configured: boolean;
    syncDirection: 'push' | 'pull' | 'bidirectional';
    serverRole: string;
    remoteHealthy: boolean;
    hasRemoteApi: boolean;
}

interface ReceivedSite {
    id: string;
    sourceServerId: string;
    sourceServerName: string;
    sourceServerUrl?: string;
    label: string;
    localPath: string;
    siteType: string;
    siteUrl?: string;
    lastSyncAt?: string;
    lastSyncStatus?: string;
    lastSyncLogs?: string;
    filesCount?: number;
    totalSize?: string;
}

const { getSites, createSite, updateSite, deleteSite, syncSite, scanSite, getScan, getAllowlist, addAllowlist, removeAllowlist, getReceivedSites, deleteReceivedSite, request } = useApi();
const { success, error } = useToast();

const sites = ref<Site[]>([]);
const receivedSites = ref<ReceivedSite[]>([]);
const loading = ref(true);
const settingsStatus = ref<SettingsStatus>({
    configured: false,
    syncDirection: 'push',
    serverRole: 'primary',
    remoteHealthy: false,
    hasRemoteApi: false
});
const configuredRemote = computed(() => settingsStatus.value.configured);
const remoteHealthy = computed(() => settingsStatus.value.remoteHealthy);
const syncDirection = computed(() => settingsStatus.value.syncDirection);

// Health check polling
let healthPollInterval: number | null = null;

// Modal state
const showModal = ref(false);
const editingId = ref<string | null>(null);
const discardConfirm = ref(false);
const formSnapshot = ref<string>('');
const formData = ref({
    label: '',
    localPath: '',
    remotePath: '',
    // Site type
    siteType: 'custom' as 'wordpress' | 'laravel' | 'static' | 'node' | 'custom',
    // WordPress-specific
    wpContainer: '',
    wpPath: '/var/www/html',
    wpAdminUrl: '',
    // Quick links
    editorUrl: '',
    siteUrl: '',
    dockerContainers: '',
    // Schedule
    schedulePreset: 'manual' as 'manual' | '1h' | '6h' | '12h' | '24h' | 'custom',
    scheduleCustom: '',
    // Local database
    dbContainer: '',
    dbType: 'mysql' as 'mysql' | 'postgres',
    dbUser: '',
    dbPassword: '',
    dbName: '',
    // Remote containers
    remoteContainers: '',
    autoStartRemote: false,
    // Remote database
    remoteDbContainer: '',
    remoteDbUser: '',
    remoteDbPassword: '',
    remoteDbName: ''
});

interface MagicSetupStep {
    name: string;
    success: boolean;
    output: string;
    skipped?: boolean;
}

// WordPress admin state
const wpAdminModal = ref<{
    open: boolean;
    site: Site | null;
    loading: boolean;
    credentials: WpAdminCredentials | null;
    error: string | null;
    debug: string | null;
    loadingMessage: string;
    setupResult: { success: boolean; steps: MagicSetupStep[] } | null;
}>({
    open: false,
    site: null,
    loading: false,
    credentials: null,
    error: null,
    debug: null,
    loadingMessage: '',
    setupResult: null
});

const wpQuickLogin = async (site: Site) => {
    try {
        const result = await request<{ success: boolean; url?: string; error?: string; debug?: string }>(
            `/sites/${site.id}/wp-admin/login`,
            'POST'
        );
        if (result?.success && result.url) {
            window.open(result.url, '_blank', 'noopener');
            success('Magic Link Opened', `Logging in to ${site.label}…`);
        } else {
            wpAdminModal.value = {
                open: true, site, loading: false, credentials: null,
                error: result?.error || 'Could not generate magic login link.',
                debug: result?.debug || null,
                loadingMessage: '',
                setupResult: null
            };
        }
    } catch (e: any) {
        wpAdminModal.value = {
            open: true, site, loading: false, credentials: null,
            error: e.message || 'Could not generate magic login link.',
            debug: null,
            loadingMessage: '',
            setupResult: null
        };
    }
};

const openWpCredentialsModal = async (site: Site) => {
    wpAdminModal.value = {
        open: true, site, loading: true, credentials: null,
        error: null, debug: null, loadingMessage: 'Loading credentials…',
        setupResult: null
    };
    try {
        const result = await request<WpAdminCredentials>(`/sites/${site.id}/wp-admin`);
        if (result) {
            wpAdminModal.value.credentials = result;
        } else {
            wpAdminModal.value.error = 'No stored credentials yet.';
        }
    } catch (e: any) {
        // 404 = no creds yet; offer to create one
        if (/no stored credentials|not found/i.test(e.message || '')) {
            wpAdminModal.value.error = 'No stored credentials yet. Create the WebSync admin user to get started.';
        } else {
            wpAdminModal.value.error = e.message || 'Could not load credentials.';
        }
    } finally {
        wpAdminModal.value.loading = false;
    }
};

const wpSetupMagic = async () => {
    const site = wpAdminModal.value.site;
    if (!site) return;
    wpAdminModal.value.loading = true;
    wpAdminModal.value.loadingMessage = 'Setting up magic login…';
    wpAdminModal.value.error = null;
    wpAdminModal.value.debug = null;
    wpAdminModal.value.setupResult = null;
    try {
        const result = await request<{ success: boolean; steps: MagicSetupStep[]; error?: string }>(
            `/sites/${site.id}/wp-admin/setup`,
            'POST'
        );
        if (!result) {
            wpAdminModal.value.error = 'Setup returned no response.';
        } else {
            wpAdminModal.value.setupResult = { success: result.success, steps: result.steps || [] };
            if (result.success) {
                success('Magic login ready', `${site.label} is set up for one-click login.`);
            } else {
                wpAdminModal.value.error = result.error || 'One or more setup steps failed. See details below.';
            }
        }
    } catch (e: any) {
        wpAdminModal.value.error = e.message || 'Setup failed.';
    } finally {
        wpAdminModal.value.loading = false;
        wpAdminModal.value.loadingMessage = '';
    }
};

const wpRotatePassword = async () => {
    const site = wpAdminModal.value.site;
    if (!site) return;
    wpAdminModal.value.loading = true;
    wpAdminModal.value.loadingMessage = wpAdminModal.value.credentials
        ? 'Rotating password…'
        : 'Creating WebSync admin…';
    wpAdminModal.value.error = null;
    wpAdminModal.value.debug = null;
    try {
        const result = await request<WpAdminCredentials & { success: boolean; error?: string; debug?: string }>(
            `/sites/${site.id}/wp-admin`,
            'POST'
        );
        if (result?.success) {
            wpAdminModal.value.credentials = {
                username: result.username,
                password: result.password,
                loginUrl: result.loginUrl,
                reused: result.reused,
                justRotated: true,
                lastRotated: new Date().toISOString()
            };
            success(
                result.reused ? 'Password Rotated' : 'Admin Created',
                result.reused ? 'New password generated and stored.' : 'WebSync admin user is ready.'
            );
        } else {
            wpAdminModal.value.error = result?.error || 'Could not rotate password.';
            wpAdminModal.value.debug = result?.debug || null;
        }
    } catch (e: any) {
        wpAdminModal.value.error = e.message || 'Could not rotate password.';
    } finally {
        wpAdminModal.value.loading = false;
        wpAdminModal.value.loadingMessage = '';
    }
};

// ============================================================
// WordPress integrity / malware scan
// ============================================================

const scanModal = ref<{
    open: boolean;
    site: Site | null;
    loading: boolean;
    loadingMessage: string;
    scan: SiteScan | null;
    error: string | null;
}>({
    open: false,
    site: null,
    loading: false,
    loadingMessage: '',
    scan: null,
    error: null
});

// Global allowlist (loaded when the scan modal opens).
const scanAllowlist = ref<AllowlistEntry[]>([]);

const SCAN_STATUS_LABELS: Record<ScanStatus, string> = {
    clean: 'Clean',
    warning: 'Check',
    compromised: 'At risk',
    error: 'Scan error',
    unknown: 'Not scanned'
};

const scanStatusLabel = (status?: ScanStatus | null) => SCAN_STATUS_LABELS[status || 'unknown'];

// Severity ordering so findings render worst-first.
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const sortedFindings = (scan: SiteScan | null): ScanFinding[] =>
    [...(scan?.findings || [])].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

const scanTooltip = (site: Site): string => {
    const scan = site.latestScan;
    if (!scan) return 'Security scan not run yet — click to scan';
    const when = scan.createdAt ? ` · scanned ${new Date(scan.createdAt).toLocaleString()}` : '';
    if (scan.status === 'clean') return `No issues found${when}`;
    if (scan.status === 'compromised') return `${scan.findingsCount || 0} issue(s), ${scan.critical || 0} critical${when}`;
    if (scan.status === 'error') return `${scan.error || 'Scan could not complete'}${when}`;
    return `${scan.findingsCount || 0} item(s) need review${when}`;
};

// Recompute the modal's scan summary + dashboard badge after findings change locally
// (e.g. a path was allowlisted) without re-scanning the container.
const recomputeScanSummary = () => {
    const scan = scanModal.value.scan;
    if (!scan) return;
    const fs = scan.findings || [];
    scan.findingsCount = fs.length;
    scan.critical = fs.filter(f => f.severity === 'critical').length;
    const has = (s: Severity) => fs.some(f => f.severity === s);
    scan.status = (has('critical') || has('high'))
        ? 'compromised'
        : (has('medium') || has('low'))
            ? 'warning'
            : ((scan.coreStatus === 'unverified' || scan.coreStatus === 'error') ? 'warning' : 'clean');
    const card = sites.value.find(s => s.id === scanModal.value.site?.id);
    if (card && card.latestScan) {
        card.latestScan = { ...card.latestScan, status: scan.status, findingsCount: scan.findingsCount, critical: scan.critical };
    }
};

// Drop currently-allowlisted paths from the displayed scan so an old stored result
// reflects the live allowlist immediately.
const applyAllowlistLocally = () => {
    const scan = scanModal.value.scan;
    if (!scan) return;
    const ignored = new Set(scanAllowlist.value.map(a => `${a.category}::${a.path}`));
    scan.findings = (scan.findings || [])
        .map(f => ({ ...f, paths: f.paths.filter(p => !ignored.has(`${f.category}::${p}`)) }))
        .filter(f => f.category === 'core_unverified' || f.paths.length > 0);
    recomputeScanSummary();
};

const openScanModal = async (site: Site) => {
    scanModal.value = {
        open: true, site, loading: true,
        loadingMessage: 'Loading latest scan…', scan: null, error: null
    };
    try { scanAllowlist.value = await getAllowlist(); } catch { scanAllowlist.value = []; }
    try {
        const result = await getScan(site.id);
        scanModal.value.scan = result;
        applyAllowlistLocally();
    } catch (e: any) {
        // 404 = never scanned yet; that's an empty state, not an error.
        if (/no scan|not found/i.test(e.message || '')) {
            scanModal.value.scan = null;
        } else {
            scanModal.value.error = e.message || 'Could not load scan.';
        }
    } finally {
        scanModal.value.loading = false;
        scanModal.value.loadingMessage = '';
    }
};

// Allowlist a specific flagged path; remove it from the current view immediately.
const ignorePath = async (finding: ScanFinding, path: string) => {
    try {
        await addAllowlist(finding.category, path);
        finding.paths = finding.paths.filter(p => p !== path);
        if (scanModal.value.scan) {
            scanModal.value.scan.findings = (scanModal.value.scan.findings || [])
                .filter(f => f.category === 'core_unverified' || f.paths.length > 0);
            recomputeScanSummary();
        }
        try { scanAllowlist.value = await getAllowlist(); } catch {}
        success('Allowlisted', `${path} will be ignored in future scans on all sites.`);
    } catch (e: any) {
        error('Could not allowlist', e.message || 'Try again');
    }
};

const removeAllowlistEntry = async (entry: AllowlistEntry) => {
    try {
        await removeAllowlist(entry.id);
        scanAllowlist.value = scanAllowlist.value.filter(a => a.id !== entry.id);
        success('Removed', `${entry.path} will be flagged again on the next scan.`);
    } catch (e: any) {
        error('Could not remove', e.message || 'Try again');
    }
};

const runScan = async () => {
    const site = scanModal.value.site;
    if (!site) return;
    scanModal.value.loading = true;
    scanModal.value.loadingMessage = 'Scanning… verifying checksums and inspecting files';
    scanModal.value.error = null;
    try {
        const result = await scanSite(site.id);
        scanModal.value.scan = result;
        // Keep the dashboard badge in sync immediately (WS will also push this).
        const card = sites.value.find(s => s.id === site.id);
        if (card) card.latestScan = result;
        if (result.status === 'clean') {
            success('Scan complete', `${site.label}: no issues found.`);
        } else if (result.status === 'compromised') {
            error('Possible compromise', `${site.label}: ${result.critical || 0} critical, ${result.findingsCount || 0} total.`);
        } else if (result.status === 'error') {
            error('Scan error', result.error || 'Scan could not complete.');
        } else {
            success('Scan complete', `${site.label}: ${result.findingsCount || 0} item(s) to review.`);
        }
    } catch (e: any) {
        scanModal.value.error = e.message || 'Scan failed.';
    } finally {
        scanModal.value.loading = false;
        scanModal.value.loadingMessage = '';
    }
};

const copyToClipboard = async (text: string, label: string) => {
    // navigator.clipboard requires a secure context (HTTPS or localhost).
    // WebSync is usually accessed over plain HTTP on a LAN, so fall back to
    // the legacy textarea + execCommand trick.
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        document.body.removeChild(ta);
        return ok;
    };

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else if (!fallback()) {
            throw new Error('Copy failed');
        }
        success('Copied', `${label} copied to clipboard`);
    } catch {
        error('Copy failed', 'Select the value manually to copy it');
    }
};


// Schedule preset mappings
const schedulePresets = {
    'manual': null,
    '1h': '0 * * * *',      // Every hour
    '6h': '0 */6 * * *',    // Every 6 hours
    '12h': '0 */12 * * *',  // Every 12 hours
    '24h': '0 0 * * *',     // Every day at midnight
    'custom': null
};

const getScheduleFromForm = () => {
    if (formData.value.schedulePreset === 'manual') {
        return undefined;
    }
    if (formData.value.schedulePreset === 'custom') {
        return formData.value.scheduleCustom || undefined;
    }
    return schedulePresets[formData.value.schedulePreset] || undefined;
};

const getPresetFromSchedule = (schedule: string | undefined): 'manual' | '1h' | '6h' | '12h' | '24h' | 'custom' => {
    if (!schedule) return 'manual';
    
    // Check if it matches a preset
    for (const [key, value] of Object.entries(schedulePresets)) {
        if (value === schedule) {
            return key as any;
        }
    }
    // If no match, it's a custom schedule
    return 'custom';
};

const getScheduleLabel = (schedule: string | undefined): string => {
    if (!schedule) return 'Manual';
    
    const presetLabels: Record<string, string> = {
        '0 * * * *': 'Every Hour',
        '0 */6 * * *': 'Every 6 Hours',
        '0 */12 * * *': 'Every 12 Hours',
        '0 0 * * *': 'Every 24 Hours'
    };
    
    return presetLabels[schedule] || schedule;
};

// Remote container status
const containerStatus = ref<Map<string, { loading: boolean; containers: any[] }>>(new Map());

// Delete confirmation
const deleteConfirm = ref({ open: false, siteId: '', siteName: '' });

// Sync progress tracking
const syncingJobs = ref<Map<string, { jobId: string; progress: number; message: string }>>(new Map());

const loadData = async () => {
    loading.value = true;
    try {
        const [sitesData, receivedData, statusData] = await Promise.all([
            getSites(),
            getReceivedSites().catch(() => []), // Don't fail if received sites endpoint fails
            request<SettingsStatus>('/settings/status')
        ]);
        sites.value = sitesData;
        receivedSites.value = receivedData || [];
        if (statusData) {
            settingsStatus.value = statusData;
        }
    } catch (e: any) {
        error('Load Failed', e.message || 'Failed to load sites');
    } finally {
        loading.value = false;
    }
};

const handleDeleteReceivedSite = async (site: ReceivedSite) => {
    try {
        await deleteReceivedSite(site.id);
        receivedSites.value = receivedSites.value.filter(s => s.id !== site.id);
        success('Removed', `Removed "${site.label}" from received sites`);
    } catch (e: any) {
        error('Delete Failed', e.message || 'Failed to remove received site');
    }
};

const formatRelativeTime = (dateString?: string) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
};

const checkHealth = async () => {
    if (!settingsStatus.value.hasRemoteApi) return;
    try {
        const health = await request<{ healthy: boolean }>('/settings/remote-health');
        if (health) {
            settingsStatus.value.remoteHealthy = health.healthy;
        }
    } catch {
        // Silently fail health checks
    }
};

const startHealthPolling = () => {
    if (settingsStatus.value.hasRemoteApi) {
        healthPollInterval = window.setInterval(checkHealth, 30000);
    }
};

const openAddModal = () => {
    editingId.value = null;
    formData.value = {
        label: '',
        localPath: '',
        remotePath: '',
        siteType: 'custom',
        wpContainer: '',
        wpPath: '/var/www/html',
        wpAdminUrl: '',
        editorUrl: '',
        siteUrl: '',
        dockerContainers: '',
        schedulePreset: 'manual',
        scheduleCustom: '',
        dbContainer: '',
        dbType: 'mysql',
        dbUser: '',
        dbPassword: '',
        dbName: '',
        remoteContainers: '',
        autoStartRemote: false,
        remoteDbContainer: '',
        remoteDbUser: '',
        remoteDbPassword: '',
        remoteDbName: ''
    };
    formSnapshot.value = JSON.stringify(formData.value);
    showModal.value = true;
};

const openEditModal = (site: Site) => {
    editingId.value = site.id;
    const preset = getPresetFromSchedule(site.schedule);
    formData.value = {
        label: site.label,
        localPath: site.localPath,
        remotePath: site.remotePath,
        siteType: site.siteType || 'custom',
        wpContainer: site.wpContainer || '',
        wpPath: site.wpPath || '/var/www/html',
        wpAdminUrl: site.wpAdminUrl || '',
        editorUrl: site.editorUrl || '',
        siteUrl: site.siteUrl || '',
        dockerContainers: '',
        schedulePreset: preset,
        scheduleCustom: preset === 'custom' ? (site.schedule || '') : '',
        dbContainer: site.dbContainer || '',
        dbType: (site.dbType as 'mysql' | 'postgres') || 'mysql',
        dbUser: site.dbUser || '',
        dbPassword: site.dbPassword || '',
        dbName: site.dbName || '',
        remoteContainers: site.remoteContainers || '',
        autoStartRemote: site.autoStartRemote || false,
        remoteDbContainer: site.remoteDbContainer || '',
        remoteDbUser: site.remoteDbUser || '',
        remoteDbPassword: site.remoteDbPassword || '',
        remoteDbName: site.remoteDbName || ''
    };
    formSnapshot.value = JSON.stringify(formData.value);
    showModal.value = true;
};

const isFormDirty = () => JSON.stringify(formData.value) !== formSnapshot.value;

const closeModal = () => {
    if (isFormDirty()) {
        discardConfirm.value = true;
    } else {
        showModal.value = false;
    }
};

const confirmDiscard = () => {
    discardConfirm.value = false;
    showModal.value = false;
};

const handleModalKeydown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (discardConfirm.value) {
        discardConfirm.value = false;
        return;
    }
    if (showModal.value) {
        closeModal();
    } else if (wpAdminModal.value.open) {
        wpAdminModal.value.open = false;
    } else if (scanModal.value.open) {
        scanModal.value.open = false;
    }
};

const handleSubmit = async () => {
    try {
        // Helper to convert empty strings to null for updates (to clear values)
        // or undefined for creates (to omit from insert)
        const emptyToNullOrUndefined = (val: string, isUpdate: boolean) => {
            if (!val || val.trim() === '') {
                return isUpdate ? null : undefined;
            }
            return val;
        };
        
        const isUpdate = !!editingId.value;
        
        const data = {
            label: formData.value.label,
            localPath: formData.value.localPath,
            remotePath: formData.value.remotePath,
            // Site type
            siteType: formData.value.siteType,
            // WordPress-specific
            wpContainer: formData.value.siteType === 'wordpress' 
                ? emptyToNullOrUndefined(formData.value.wpContainer, isUpdate) 
                : (isUpdate ? null : undefined),
            wpPath: formData.value.siteType === 'wordpress' 
                ? emptyToNullOrUndefined(formData.value.wpPath, isUpdate) 
                : (isUpdate ? null : undefined),
            wpAdminUrl: formData.value.siteType === 'wordpress' 
                ? emptyToNullOrUndefined(formData.value.wpAdminUrl, isUpdate) 
                : (isUpdate ? null : undefined),
            // Quick links
            editorUrl: emptyToNullOrUndefined(formData.value.editorUrl, isUpdate),
            siteUrl: emptyToNullOrUndefined(formData.value.siteUrl, isUpdate),
            dockerContainers: emptyToNullOrUndefined(formData.value.dockerContainers, isUpdate),
            schedule: getScheduleFromForm(),
            dbContainer: emptyToNullOrUndefined(formData.value.dbContainer, isUpdate),
            dbType: formData.value.dbContainer ? formData.value.dbType : (isUpdate ? null : undefined),
            dbUser: emptyToNullOrUndefined(formData.value.dbUser, isUpdate),
            dbPassword: emptyToNullOrUndefined(formData.value.dbPassword, isUpdate),
            dbName: emptyToNullOrUndefined(formData.value.dbName, isUpdate),
            // Remote containers
            remoteContainers: emptyToNullOrUndefined(formData.value.remoteContainers, isUpdate),
            autoStartRemote: formData.value.autoStartRemote,
            // Remote database
            remoteDbContainer: emptyToNullOrUndefined(formData.value.remoteDbContainer, isUpdate),
            remoteDbUser: emptyToNullOrUndefined(formData.value.remoteDbUser, isUpdate),
            remoteDbPassword: emptyToNullOrUndefined(formData.value.remoteDbPassword, isUpdate),
            remoteDbName: emptyToNullOrUndefined(formData.value.remoteDbName, isUpdate)
        };

        if (isUpdate) {
            await updateSite(editingId.value!, data);
            success('Site Updated', `${data.label} has been updated`);
        } else {
            await createSite(data);
            success('Site Created', `${data.label} has been added`);
        }
        
        formSnapshot.value = JSON.stringify(formData.value);
        showModal.value = false;
        loadData();
    } catch (e: any) {
        error('Save Failed', e.message || 'Failed to save site');
    }
};

const confirmDelete = (site: Site) => {
    deleteConfirm.value = {
        open: true,
        siteId: site.id,
        siteName: site.label
    };
};

const handleDelete = async () => {
    try {
        await deleteSite(deleteConfirm.value.siteId);
        success('Site Deleted', `${deleteConfirm.value.siteName} has been removed`);
        deleteConfirm.value.open = false;
        loadData();
    } catch (e: any) {
        error('Delete Failed', e.message || 'Failed to delete site');
    }
};

const triggerSync = async (site: Site, direction?: 'push' | 'pull' | 'bidirectional', force?: boolean) => {
    if (!configuredRemote.value) {
        error('Not Configured', 'Please configure remote host in Settings first');
        return;
    }

    if (settingsStatus.value.hasRemoteApi && !remoteHealthy.value && !force) {
        error('Remote Unavailable', 'Remote server is not healthy. Use force sync to override.');
        return;
    }

    try {
        const job = await syncSite(site.id, { direction, force });
        syncingJobs.value.set(site.id, {
            jobId: job.id,
            progress: 0,
            message: 'Starting sync...'
        });
        const dirLabel = direction || syncDirection.value;
        success('Sync Started', `${dirLabel.charAt(0).toUpperCase() + dirLabel.slice(1)}ing ${site.label}...`);
    } catch (e: any) {
        error('Sync Failed', e.message || 'Failed to start sync');
    }
};

// Sync menu state
const syncMenuOpen = ref<string | null>(null);
const toggleSyncMenu = (siteId: string) => {
    syncMenuOpen.value = syncMenuOpen.value === siteId ? null : siteId;
};

const closeSyncMenu = () => {
    syncMenuOpen.value = null;
};

// Remote container control
const loadRemoteContainerStatus = async (site: Site) => {
    if (!site.remoteContainers) return;
    
    containerStatus.value.set(site.id, { loading: true, containers: [] });
    
    try {
        const result = await request<{ containers: any[] }>(`/sites/${site.id}/remote-containers`);
        if (result) {
            containerStatus.value.set(site.id, { loading: false, containers: result.containers });
        }
    } catch {
        containerStatus.value.set(site.id, { loading: false, containers: [] });
    }
};

const startRemoteContainers = async (site: Site) => {
    try {
        const result = await request<{ success: boolean; results: any[] }>(`/sites/${site.id}/remote-containers/start`, 'POST');
        if (result?.success) {
            success('Containers Started', `Started containers on remote server`);
            loadRemoteContainerStatus(site);
        } else {
            const failed = result?.results?.filter(r => !r.started).map(r => r.name).join(', ');
            error('Partial Failure', `Failed to start: ${failed}`);
        }
    } catch (e: any) {
        error('Start Failed', e.message || 'Failed to start remote containers');
    }
};

const stopRemoteContainers = async (site: Site) => {
    try {
        const result = await request<{ success: boolean; results: any[] }>(`/sites/${site.id}/remote-containers/stop`, 'POST');
        if (result?.success) {
            success('Containers Stopped', `Stopped containers on remote server`);
            loadRemoteContainerStatus(site);
        } else {
            const failed = result?.results?.filter(r => !r.stopped).map(r => r.name).join(', ');
            error('Partial Failure', `Failed to stop: ${failed}`);
        }
    } catch (e: any) {
        error('Stop Failed', e.message || 'Failed to stop remote containers');
    }
};

const restartRemoteContainers = async (site: Site) => {
    try {
        const result = await request<{ success: boolean; results: any[] }>(`/sites/${site.id}/remote-containers/restart`, 'POST');
        if (result?.success) {
            success('Containers Restarted', `Restarted containers on remote server`);
            loadRemoteContainerStatus(site);
        } else {
            const failed = result?.results?.filter(r => !r.restarted).map(r => r.name).join(', ');
            error('Partial Failure', `Failed to restart: ${failed}`);
        }
    } catch (e: any) {
        error('Restart Failed', e.message || 'Failed to restart remote containers');
    }
};

const getSiteStatus = (site: Site) => {
    if (syncingJobs.value.has(site.id)) return 'syncing';
    const lastJob = site.jobs?.[0];
    if (lastJob?.status === 'FAILED') return 'error';
    return 'idle';
};

// Real-time updates
useJobUpdates((update) => {
    if (update.type === 'job:started' && update.job) {
        const site = sites.value.find(s => s.id === update.job.siteId);
        if (site) {
            syncingJobs.value.set(site.id, {
                jobId: update.job.id,
                progress: 0,
                message: 'Starting sync...'
            });
        }
    } else if (update.type === 'job:progress' && update.jobId) {
        for (const [siteId, jobInfo] of syncingJobs.value.entries()) {
            if (jobInfo.jobId === update.jobId) {
                syncingJobs.value.set(siteId, {
                    ...jobInfo,
                    progress: update.progress || 0,
                    message: update.message || 'Syncing...'
                });
                break;
            }
        }
    } else if ((update.type === 'job:completed' || update.type === 'job:failed') && update.job) {
        const site = sites.value.find(s => s.id === update.job.siteId);
        if (site) {
            syncingJobs.value.delete(site.id);
            if (update.type === 'job:completed') {
                success('Sync Complete', `${site.label} synced successfully`);
            } else {
                error('Sync Failed', update.error || `${site.label} sync failed`);
            }
            loadData();
        }
    } else if (update.type === 'site:health' && update.siteId && update.health) {
        const site = sites.value.find(s => s.id === update.siteId);
        if (site) site.health = update.health as SiteHealth;
    } else if (update.type === 'site:scan' && update.siteId && update.scan) {
        const site = sites.value.find(s => s.id === update.siteId);
        if (site) site.latestScan = update.scan as SiteScan;
    }
});

// SSL expiry warning when fewer than this many days remain
const SSL_WARN_DAYS = 30;

const sslDaysRemaining = (health?: SiteHealth | null): number | null => {
    if (!health?.sslExpiresAt) return null;
    const days = Math.floor((new Date(health.sslExpiresAt).getTime() - Date.now()) / 86_400_000);
    return days;
};

const healthTooltip = (health?: SiteHealth | null): string => {
    if (!health) return 'Health check pending…';
    if (health.status === 'unknown') return 'No siteUrl configured — set one in site settings.';
    const parts: string[] = [];
    if (health.httpStatus) parts.push(`HTTP ${health.httpStatus}`);
    if (typeof health.responseMs === 'number') parts.push(`${health.responseMs}ms`);
    if (health.error) parts.push(health.error);
    if (health.lastCheckedAt) parts.push(`checked ${new Date(health.lastCheckedAt).toLocaleTimeString()}`);
    return parts.length ? parts.join(' · ') : health.status;
};

const recheckHealth = async () => {
    try {
        await request('/sites/health/recheck', 'POST');
        success('Health check started', 'Results will update in a moment');
    } catch (e: any) {
        error('Recheck failed', e.message || 'Try again');
    }
};

onMounted(async () => {
    await loadData();
    startHealthPolling();
    window.addEventListener('keydown', handleModalKeydown);
});

onUnmounted(() => {
    if (healthPollInterval) {
        clearInterval(healthPollInterval);
    }
    window.removeEventListener('keydown', handleModalKeydown);
});
</script>

<template>
    <div class="dashboard-page">
        <!-- Health Status Bar -->
        <div v-if="settingsStatus.hasRemoteApi && !loading" class="health-bar" :class="{ healthy: remoteHealthy, unhealthy: !remoteHealthy }">
            <div class="health-content">
                <div class="health-indicator">
                    <div class="pulse-dot"></div>
                    <span class="health-text">
                        {{ remoteHealthy ? 'Remote Online' : 'Remote Offline' }}
                    </span>
                </div>
                <div class="sync-mode">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    <span>Sync: {{ syncDirection === 'bidirectional' ? 'Bidirectional' : syncDirection === 'pull' ? 'Pull' : 'Push' }}</span>
                </div>
            </div>
        </div>

        <!-- Alert Banner -->
        <div v-if="!configuredRemote && !loading" class="alert-banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <span>Remote host not configured. <router-link to="/settings">Configure settings</router-link> to enable syncing.</span>
        </div>

        <!-- Header -->
        <div class="page-header">
            <div class="header-info">
                <h2 class="section-title">Sites</h2>
                <p class="section-subtitle">{{ sites.length }} site{{ sites.length !== 1 ? 's' : '' }} configured</p>
            </div>
            <div class="header-actions">
                <button class="btn btn-secondary" @click="recheckHealth" title="Run a health check on every site now">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    Recheck health
                </button>
                <button class="btn btn-primary" @click="openAddModal">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Site
                </button>
            </div>
    </div>

        <!-- Loading State -->
        <div v-if="loading" class="loading-state">
            <div class="spinner"></div>
            <span>Loading sites...</span>
        </div>

        <!-- Empty State -->
        <div v-else-if="sites.length === 0" class="empty-state">
            <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
            <h3>No sites configured</h3>
            <p>Add your first site to start syncing files between servers</p>
            <button class="btn btn-primary" @click="openAddModal">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Add Site
          </button>
        </div>

        <!-- Sites Grid -->
        <div v-else class="sites-grid">
            <article v-for="site in sites" :key="site.id" class="site-card">
                <div class="card-header">
                    <div class="card-title-row">
                        <!-- Site Type Icon -->
                        <span :class="['site-type-icon', `site-type-${site.siteType || 'custom'}`]" :title="site.siteType || 'custom'">
                            <!-- WordPress -->
                            <svg v-if="site.siteType === 'wordpress'" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2zM3.5 12c0-1.097.21-2.145.593-3.105l3.268 8.953A8.5 8.5 0 0 1 3.5 12zm8.5 8.5c-.834 0-1.64-.12-2.401-.345l2.55-7.411 2.613 7.157a.799.799 0 0 0 .06.117A8.461 8.461 0 0 1 12 20.5zm1.077-12.457c.511-.027.973-.08.973-.08.458-.054.404-.728-.054-.702 0 0-1.376.108-2.265.108-.835 0-2.238-.108-2.238-.108-.458-.026-.512.675-.054.702 0 0 .434.053.891.08l1.323 3.628-1.858 5.573-3.093-9.201c.512-.027.973-.08.973-.08.458-.054.404-.728-.054-.702 0 0-1.376.108-2.265.108-.159 0-.347-.004-.547-.01A8.491 8.491 0 0 1 12 3.5c2.213 0 4.228.846 5.74 2.232-.037-.002-.072-.007-.11-.007-.835 0-1.427.728-1.427 1.511 0 .702.404 1.295.835 1.997.324.566.702 1.295.702 2.347 0 .728-.28 1.573-.647 2.749l-.848 2.833-3.068-9.119zm4.149 12.5l2.601-7.525c.487-1.214.647-2.185.647-3.049 0-.314-.02-.605-.058-.878A8.477 8.477 0 0 1 20.5 12c0 3.254-1.826 6.08-4.507 7.506z"/>
                            </svg>
                            <!-- Laravel -->
                            <svg v-else-if="site.siteType === 'laravel'" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M23.642 5.43a.364.364 0 01.014.1v5.149c0 .135-.073.26-.189.326l-4.323 2.49v4.934a.378.378 0 01-.188.326L9.93 23.949a.316.316 0 01-.066.027c-.008.002-.016.008-.024.01a.348.348 0 01-.192 0c-.011-.002-.02-.008-.03-.012a.262.262 0 01-.06-.023L.533 18.755a.376.376 0 01-.189-.326V2.974c0-.033.005-.066.014-.098.003-.012.01-.02.014-.032a.369.369 0 01.023-.058c.004-.013.015-.022.023-.033l.033-.045c.012-.01.025-.018.037-.027.014-.012.027-.024.041-.034L4.94.156a.377.377 0 01.377 0l4.409 2.539c.014.01.027.02.04.033l.038.027c.013.014.02.03.033.045.008.01.019.02.023.033a.32.32 0 01.022.058c.005.01.012.02.015.032a.39.39 0 01.014.098v9.652l3.76-2.164V5.527c0-.033.004-.066.013-.098.003-.01.01-.02.013-.032a.487.487 0 01.024-.059c.007-.012.018-.02.025-.033.01-.015.018-.03.032-.043.012-.012.025-.02.037-.028.014-.01.026-.023.041-.032l4.411-2.54a.376.376 0 01.376 0l4.41 2.54c.016.01.028.021.042.032.012.01.025.018.036.028.013.014.023.028.033.043.008.012.019.021.024.033.011.02.018.04.024.06.006.01.012.02.015.03zm-.74 5.032V6.179l-1.578.908-2.182 1.256v4.283l3.76-2.164zm-4.41 7.636v-4.29l-2.147 1.225-6.022 3.44v4.36l8.169-4.735zM1.093 3.624v14.588l8.17 4.736v-4.363L4.933 16.06l-.003-.002-.004-.002c-.014-.01-.025-.021-.04-.032-.012-.009-.024-.016-.035-.027l-.001-.002c-.013-.012-.021-.028-.032-.042-.01-.014-.021-.023-.028-.038v-.001c-.01-.016-.015-.033-.022-.05-.006-.016-.014-.027-.018-.043a.49.49 0 01-.01-.058c-.003-.016-.007-.03-.007-.047V3.624L2.67 2.369l-1.577-.908zm3.472-2.31L1.008 3.152l3.556 2.047 3.557-2.048-3.556-2.037zM5.317 14.66l2.182-1.258V3.624L5.917 4.532l-2.182 1.256v9.777l1.582-.905zm10.4-7.012l-3.556 2.046 3.556 2.048 3.556-2.047-3.556-2.047zm-.189 4.582l-2.183-1.257-1.577-.908v4.283l2.182 1.256 1.578.908v-4.282zm-8.547 6.918l5.454-3.12 2.71-1.55-3.553-2.044-4.322 2.489-3.843 2.213 3.554 2.012z"/>
                            </svg>
                            <!-- Node.js -->
                            <svg v-else-if="site.siteType === 'node'" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M11.998 24c-.321 0-.641-.084-.922-.247l-2.936-1.737c-.438-.245-.224-.332-.08-.383.585-.203.703-.25 1.328-.604.065-.037.151-.023.218.017l2.256 1.339c.082.045.198.045.275 0l8.795-5.076c.082-.047.134-.141.134-.238V6.921c0-.099-.053-.193-.137-.242l-8.791-5.072c-.081-.047-.189-.047-.271 0L3.075 6.68c-.085.049-.139.144-.139.243v10.15c0 .097.054.189.134.235l2.409 1.392c1.307.654 2.108-.116 2.108-.891V7.787c0-.142.114-.253.256-.253h1.115c.139 0 .255.112.255.253v10.021c0 1.745-.95 2.745-2.604 2.745-.508 0-.909 0-2.026-.551l-2.308-1.331A1.852 1.852 0 0 1 1.35 17.07V6.921c0-.678.363-1.312.955-1.651L11.1.194c.574-.323 1.34-.323 1.912 0l8.795 5.076c.592.339.955.973.955 1.651v10.15c0 .678-.363 1.312-.957 1.651l-8.795 5.076a1.848 1.848 0 0 1-.922.247"/>
                            </svg>
                            <!-- Static/HTML -->
                            <svg v-else-if="site.siteType === 'static'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="16 18 22 12 16 6"/>
                                <polyline points="8 6 2 12 8 18"/>
                            </svg>
                            <!-- Custom/Default -->
                            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                            </svg>
                        </span>
                        <h3 class="site-name">{{ site.label }}</h3>
                        <span
                            v-if="site.siteUrl"
                            class="health-dot"
                            :class="`health-${site.health?.status || 'unknown'}`"
                            :title="healthTooltip(site.health)"
                            aria-label="Site health"
                        ></span>
                        <span
                            v-if="sslDaysRemaining(site.health) !== null && (sslDaysRemaining(site.health) as number) <= SSL_WARN_DAYS"
                            class="ssl-warning"
                            :class="{ 'ssl-expired': (sslDaysRemaining(site.health) as number) <= 0 }"
                            :title="`SSL certificate expires ${new Date(site.health!.sslExpiresAt!).toLocaleDateString()}`"
                        >
                            SSL {{ (sslDaysRemaining(site.health) as number) <= 0 ? 'expired' : `${sslDaysRemaining(site.health)}d` }}
                        </span>
                        <StatusBadge :status="getSiteStatus(site)" size="sm" />
                        <!-- WordPress security scan badge -->
                        <button
                            v-if="site.siteType === 'wordpress' && site.wpContainer"
                            class="scan-badge"
                            :class="`scan-${site.latestScan?.status || 'unknown'}`"
                            :title="scanTooltip(site)"
                            aria-label="WordPress integrity scan"
                            @click="openScanModal(site)"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            </svg>
                            <span>{{ scanStatusLabel(site.latestScan?.status) }}</span>
                        </button>
                        <!-- Quick Links -->
                        <div class="quick-links" v-if="site.editorUrl || site.siteUrl || site.siteType === 'wordpress'">
                            <a 
                                v-if="site.editorUrl" 
                                :href="site.editorUrl" 
                                target="_blank" 
                                class="quick-link quick-link-editor"
                                title="Open Editor"
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="16 18 22 12 16 6"/>
                                    <polyline points="8 6 2 12 8 18"/>
                                </svg>
                            </a>
                            <a 
                                v-if="site.siteUrl" 
                                :href="site.siteUrl" 
                                target="_blank" 
                                class="quick-link quick-link-site"
                                title="Open Site"
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="2" y1="12" x2="22" y2="12"/>
                                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                </svg>
                            </a>
                            <!-- WordPress Quick Login (magic link) -->
                            <button
                                v-if="site.siteType === 'wordpress' && site.wpContainer"
                                class="quick-link quick-link-wp-admin"
                                title="One-click login to WP Admin"
                                @click="wpQuickLogin(site)"
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                                </svg>
          </button>
                            <!-- WordPress Credentials -->
                            <button
                                v-if="site.siteType === 'wordpress' && site.wpContainer"
                                class="quick-link"
                                title="Show stored WP admin credentials"
                                @click="openWpCredentialsModal(site)"
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                                </svg>
          </button>
        </div>
      </div>
                    <div class="card-actions">
                        <button class="icon-btn" @click="openEditModal(site)" title="Edit">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="icon-btn icon-btn-danger" @click="confirmDelete(site)" title="Delete">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                <line x1="10" y1="11" x2="10" y2="17"/>
                                <line x1="14" y1="11" x2="14" y2="17"/>
                            </svg>
                        </button>
      </div>
    </div>
    
                <div class="card-body">
                    <div class="path-info">
                        <div class="path-row">
                            <span class="path-label">Local</span>
                            <code class="path-value">{{ site.localPath }}</code>
                        </div>
                        <div class="path-arrow">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="5" y1="12" x2="19" y2="12"/>
                                <polyline points="12 5 19 12 12 19"/>
                            </svg>
                        </div>
                        <div class="path-row">
                            <span class="path-label">Remote</span>
                            <code class="path-value">{{ site.remotePath }}</code>
                        </div>
                    </div>

                    <div class="schedule-info">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </svg>
                        <span>{{ getScheduleLabel(site.schedule) }}</span>
                    </div>

                    <div v-if="site.dbContainer" class="db-info">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <ellipse cx="12" cy="5" rx="9" ry="3"/>
                            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                        </svg>
                        <span>{{ site.dbType?.toUpperCase() }} - {{ site.dbContainer }}</span>
                    </div>

                    <!-- Remote Containers -->
                    <div v-if="site.remoteContainers" class="remote-containers-section">
                        <div class="remote-containers-header">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                                <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                                <line x1="6" y1="6" x2="6.01" y2="6"/>
                                <line x1="6" y1="18" x2="6.01" y2="18"/>
                            </svg>
                            <span>Remote: {{ site.remoteContainers }}</span>
                            <span v-if="site.autoStartRemote" class="auto-start-badge">Auto-start</span>
                        </div>
                        <div class="remote-container-actions">
                            <button class="btn-sm btn-container-action" @click="startRemoteContainers(site)" title="Start containers">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polygon points="5 3 19 12 5 21 5 3"/>
                                </svg>
                            </button>
                            <button class="btn-sm btn-container-action" @click="stopRemoteContainers(site)" title="Stop containers">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="6" y="6" width="12" height="12"/>
                                </svg>
                            </button>
                            <button class="btn-sm btn-container-action" @click="restartRemoteContainers(site)" title="Restart containers">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="23 4 23 10 17 10"/>
                                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="card-footer">
                    <SyncProgress 
                        v-if="syncingJobs.has(site.id)"
                        :progress="syncingJobs.get(site.id)?.progress || 0"
                        :message="syncingJobs.get(site.id)?.message"
                        :animated="true"
                    />
                    <div v-else class="sync-button-group">
                        <button 
                            class="btn btn-sync"
                            :disabled="!configuredRemote"
                            @click="triggerSync(site)"
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"/>
                                <polyline points="1 20 1 14 7 14"/>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                            </svg>
                            <span v-if="syncDirection === 'push'">Push</span>
                            <span v-else-if="syncDirection === 'pull'">Pull</span>
                            <span v-else>Sync</span>
                        </button>
                        <div class="sync-dropdown" v-if="configuredRemote">
                            <button class="btn btn-sync-dropdown" @click="toggleSyncMenu(site.id)">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="6 9 12 15 18 9"/>
                                </svg>
                            </button>
                            <Transition name="dropdown">
                                <div v-if="syncMenuOpen === site.id" class="dropdown-menu" @click="closeSyncMenu">
                                    <button class="dropdown-item" @click.stop="triggerSync(site, 'push'); closeSyncMenu()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <line x1="5" y1="12" x2="19" y2="12"/>
                                            <polyline points="12 5 19 12 12 19"/>
                                        </svg>
                                        Push to Remote
                                    </button>
                                    <button class="dropdown-item" @click.stop="triggerSync(site, 'pull'); closeSyncMenu()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <line x1="19" y1="12" x2="5" y2="12"/>
                                            <polyline points="12 5 5 12 12 19"/>
                                        </svg>
                                        Pull from Remote
                                    </button>
                                    <button class="dropdown-item" @click.stop="triggerSync(site, 'bidirectional'); closeSyncMenu()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="17 1 21 5 17 9"/>
                                            <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                                            <polyline points="7 23 3 19 7 15"/>
                                            <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                                        </svg>
                                        Bidirectional
                                    </button>
                                    <div class="dropdown-divider"></div>
                                    <button class="dropdown-item dropdown-item-warning" @click.stop="triggerSync(site, undefined, true); closeSyncMenu()">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                            <line x1="12" y1="9" x2="12" y2="13"/>
                                            <line x1="12" y1="17" x2="12.01" y2="17"/>
                                        </svg>
                                        Force Sync (Skip Health)
                                    </button>
                                </div>
                            </Transition>
                        </div>
                    </div>
                </div>
            </article>
        </div>

        <!-- Received Sites Section (read-only, synced from remote) -->
        <div v-if="receivedSites.length > 0" class="received-sites-section">
            <div class="section-header">
                <div class="section-title">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="8 6 2 12 8 18"/>
                        <polyline points="16 6 22 12 16 18"/>
                    </svg>
                    <h3>Received Sites</h3>
                    <span class="section-badge">{{ receivedSites.length }} synced from remote</span>
                </div>
            </div>
            
            <div class="received-sites-grid">
                <article v-for="site in receivedSites" :key="site.id" class="received-site-card">
                    <div class="received-card-header">
                        <div class="received-card-title">
                            <span :class="['site-type-icon', `site-type-${site.siteType || 'custom'}`]">
                                <svg v-if="site.siteType === 'wordpress'" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2z"/>
                                </svg>
                                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="16 18 22 12 16 6"/>
                                    <polyline points="8 6 2 12 8 18"/>
                                </svg>
                            </span>
                            <h4>{{ site.label }}</h4>
                        </div>
                        <div class="received-card-badges">
                            <span class="source-badge">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                                    <line x1="6" y1="6" x2="6.01" y2="6"/>
                                    <line x1="6" y1="18" x2="6.01" y2="18"/>
                                </svg>
                                {{ site.sourceServerName }}
                            </span>
                            <span :class="['sync-status-badge', site.lastSyncStatus === 'COMPLETED' ? 'success' : 'failed']">
                                {{ site.lastSyncStatus === 'COMPLETED' ? 'Synced' : 'Failed' }}
                            </span>
                        </div>
                    </div>
                    
                    <div class="received-card-body">
                        <div class="received-info-row">
                            <span class="info-label">Local Path</span>
                            <code class="info-value">{{ site.localPath }}</code>
                        </div>
                        <div class="received-info-row">
                            <span class="info-label">Last Sync</span>
                            <span class="info-value">{{ formatRelativeTime(site.lastSyncAt) }}</span>
                        </div>
                        <div v-if="site.siteUrl" class="received-info-row">
                            <span class="info-label">Site URL</span>
                            <a :href="site.siteUrl" target="_blank" class="info-link">{{ site.siteUrl }}</a>
                        </div>
                    </div>
                    
                    <div class="received-card-footer">
                        <span class="read-only-label">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                <circle cx="12" cy="12" r="3"/>
                            </svg>
                            Read-only (synced from {{ site.sourceServerName }})
                        </span>
                        <button class="btn-icon btn-danger-icon" @click="handleDeleteReceivedSite(site)" title="Remove from list">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </button>
                    </div>
                </article>
            </div>
        </div>

        <!-- Add/Edit Modal -->
        <Teleport to="body">
            <Transition name="modal">
                <div v-if="showModal" class="modal-overlay">
        <div class="modal-content">
                        <div class="modal-header">
                            <h2>{{ editingId ? 'Edit Site' : 'Add New Site' }}</h2>
                            <button class="modal-close" @click="closeModal">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>

                        <form @submit.prevent="handleSubmit" class="modal-form">
                            <div class="form-group">
                                <label class="form-label">Label <span class="required">*</span></label>
                                <input v-model="formData.label" type="text" class="form-input" placeholder="My Website" required />
                            </div>

                            <div class="form-row">
                                <div class="form-group">
                                    <label class="form-label">Local Path <span class="required">*</span></label>
                                    <input v-model="formData.localPath" type="text" class="form-input" placeholder="/mnt/user/appdata/website" required />
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Remote Path <span class="required">*</span></label>
                                    <input v-model="formData.remotePath" type="text" class="form-input" placeholder="/mnt/user/appdata/website" required />
                                </div>
                            </div>

                            <div class="form-group">
                                <label class="form-label">Site Type</label>
                                <div class="site-type-selector">
                                    <label :class="['site-type-option', { active: formData.siteType === 'wordpress' }]">
                                        <input type="radio" v-model="formData.siteType" value="wordpress" />
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M12 2C6.486 2 2 6.486 2 12s4.486 10 10 10 10-4.486 10-10S17.514 2 12 2z"/>
                                        </svg>
                                        <span>WordPress</span>
                                    </label>
                                    <label :class="['site-type-option', { active: formData.siteType === 'laravel' }]">
                                        <input type="radio" v-model="formData.siteType" value="laravel" />
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M23.642 5.43a.364.364 0 01.014.1v5.149c0 .135-.073.26-.189.326l-4.323 2.49v4.934"/>
                                        </svg>
                                        <span>Laravel</span>
                                    </label>
                                    <label :class="['site-type-option', { active: formData.siteType === 'node' }]">
                                        <input type="radio" v-model="formData.siteType" value="node" />
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            <path d="M11.998 24c-.321 0-.641-.084-.922-.247l-2.936-1.737"/>
                                        </svg>
                                        <span>Node.js</span>
                                    </label>
                                    <label :class="['site-type-option', { active: formData.siteType === 'static' }]">
                                        <input type="radio" v-model="formData.siteType" value="static" />
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <polyline points="16 18 22 12 16 6"/>
                                            <polyline points="8 6 2 12 8 18"/>
                                        </svg>
                                        <span>Static</span>
                                    </label>
                                    <label :class="['site-type-option', { active: formData.siteType === 'custom' }]">
                                        <input type="radio" v-model="formData.siteType" value="custom" />
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                                        </svg>
                                        <span>Custom</span>
                                    </label>
                                </div>
                            </div>

                            <!-- WordPress Settings -->
                            <div v-if="formData.siteType === 'wordpress'" class="form-section wordpress-section">
                                <div class="form-divider">
                                    <span>WordPress Settings</span>
                                </div>
                                <div class="form-row">
                                    <div class="form-group">
                                        <label class="form-label">WP Container</label>
                                        <input v-model="formData.wpContainer" type="text" class="form-input" placeholder="wordpress" />
                                        <span class="form-hint">Docker container running WordPress (for WP-CLI)</span>
                                    </div>
                                    <div class="form-group">
                                        <label class="form-label">WP Path</label>
                                        <input v-model="formData.wpPath" type="text" class="form-input" placeholder="/var/www/html" />
                                        <span class="form-hint">WordPress installation path inside container</span>
                                    </div>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">WP Admin URL</label>
                                    <input v-model="formData.wpAdminUrl" type="url" class="form-input" placeholder="https://example.com/wp-admin" />
                                    <span class="form-hint">URL to WordPress admin (for quick access)</span>
                                </div>
                            </div>

                            <div class="form-divider">
                                <span>Quick Links (Optional)</span>
                            </div>

                            <div class="form-row">
                                <div class="form-group">
                                    <label class="form-label">Editor URL</label>
                                    <input v-model="formData.editorUrl" type="url" class="form-input" placeholder="https://edit.domain.com" />
                                    <p class="form-hint">VSCodium or code editor URL</p>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Site URL</label>
                                    <input v-model="formData.siteUrl" type="url" class="form-input" placeholder="https://domain.com" />
                                    <p class="form-hint">Live website URL</p>
                                </div>
                            </div>

                            <div class="form-group">
                                <label class="form-label">Sync Schedule</label>
                                <select v-model="formData.schedulePreset" class="form-input">
                                    <option value="manual">Manual Only</option>
                                    <option value="1h">Every Hour</option>
                                    <option value="6h">Every 6 Hours</option>
                                    <option value="12h">Every 12 Hours</option>
                                    <option value="24h">Every 24 Hours (Midnight)</option>
                                    <option value="custom">Custom Schedule...</option>
                </select>
                            </div>

                            <div class="form-group" v-if="formData.schedulePreset === 'custom'">
                                <label class="form-label">Custom Cron Expression</label>
                                <input v-model="formData.scheduleCustom" type="text" class="form-input" placeholder="*/30 * * * * (every 30 minutes)" />
                                <p class="form-hint">
                                    <a href="https://crontab.guru/" target="_blank" class="form-link">Use crontab.guru</a> 
                                    to build your expression
                                </p>
                            </div>

                            <div class="form-divider">
                                <span>Database Sync (Optional)</span>
                            </div>

                            <div class="form-row">
                                <div class="form-group">
                                    <label class="form-label">DB Container</label>
                                    <input v-model="formData.dbContainer" type="text" class="form-input" placeholder="mariadb" />
                                </div>
                                <div class="form-group">
                                    <label class="form-label">DB Type</label>
                                    <select v-model="formData.dbType" class="form-input">
                                        <option value="mysql">MySQL/MariaDB</option>
                                        <option value="postgres">PostgreSQL</option>
                                    </select>
                                </div>
                            </div>

                            <div class="form-row" v-if="formData.dbContainer">
                                <div class="form-group">
                                    <label class="form-label">DB User</label>
                                    <input v-model="formData.dbUser" type="text" class="form-input" placeholder="root" />
                                </div>
                                <div class="form-group">
                                    <label class="form-label">DB Name</label>
                                    <input v-model="formData.dbName" type="text" class="form-input" placeholder="wordpress" />
                                </div>
                            </div>

                            <div class="form-group" v-if="formData.dbContainer">
                                <label class="form-label">DB Password</label>
                                <input v-model="formData.dbPassword" type="password" class="form-input" />
                            </div>

                            <div class="form-divider">
                                <span>Remote Container Management</span>
                            </div>

                            <div class="form-group">
                                <label class="form-label">Remote Containers</label>
                                <input v-model="formData.remoteContainers" type="text" class="form-input" placeholder="nginx, wordpress, mariadb" />
                                <p class="form-hint">Comma-separated container names on the remote server</p>
                            </div>

                            <label class="toggle-option" v-if="formData.remoteContainers">
                                <input type="checkbox" v-model="formData.autoStartRemote" />
                                <span class="toggle-switch"></span>
                                <span class="toggle-label">Auto-start containers after successful sync</span>
                            </label>

                            <div class="form-divider" v-if="formData.dbContainer">
                                <span>Remote Database Import</span>
                            </div>

                            <div class="form-row" v-if="formData.dbContainer">
                                <div class="form-group">
                                    <label class="form-label">Remote DB Container</label>
                                    <input v-model="formData.remoteDbContainer" type="text" class="form-input" :placeholder="formData.dbContainer || 'mariadb'" />
                                    <p class="form-hint">Leave blank to use same as local</p>
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Remote DB Name</label>
                                    <input v-model="formData.remoteDbName" type="text" class="form-input" :placeholder="formData.dbName || 'database'" />
                                </div>
                            </div>

                            <div class="form-row" v-if="formData.dbContainer && formData.remoteDbContainer">
                                <div class="form-group">
                                    <label class="form-label">Remote DB User</label>
                                    <input v-model="formData.remoteDbUser" type="text" class="form-input" :placeholder="formData.dbUser || 'root'" />
                                </div>
                                <div class="form-group">
                                    <label class="form-label">Remote DB Password</label>
                                    <input v-model="formData.remoteDbPassword" type="password" class="form-input" />
                                </div>
                            </div>

                <div class="modal-actions">
                                <button type="button" class="btn btn-secondary" @click="closeModal">Cancel</button>
                                <button type="submit" class="btn btn-primary">
                                    {{ editingId ? 'Save Changes' : 'Create Site' }}
                                </button>
                </div>
            </form>
        </div>
    </div>
            </Transition>
        </Teleport>

        <!-- Delete Confirmation -->
        <ConfirmDialog
            :open="deleteConfirm.open"
            title="Delete Site?"
            :message="`Are you sure you want to delete '${deleteConfirm.siteName}'? This action cannot be undone.`"
            variant="danger"
            confirmLabel="Delete"
            @confirm="handleDelete"
            @cancel="deleteConfirm.open = false"
        />

        <!-- Discard Changes Confirmation -->
        <ConfirmDialog
            :open="discardConfirm"
            title="Discard changes?"
            message="You have unsaved changes. Are you sure you want to close this form? Your edits will be lost."
            variant="warning"
            confirmLabel="Discard"
            cancelLabel="Keep editing"
            @confirm="confirmDiscard"
            @cancel="discardConfirm = false"
        />

        <!-- WordPress Admin Modal -->
        <Teleport to="body">
            <Transition name="modal">
                <div v-if="wpAdminModal.open" class="modal-overlay">
                    <div class="modal-content modal-sm">
                        <div class="modal-header">
                            <h2>WordPress Admin Access</h2>
                            <button class="modal-close" @click="wpAdminModal.open = false">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>

                        <div class="modal-body">
                            <div v-if="wpAdminModal.loading" class="loading-state-sm">
                                <div class="spinner"></div>
                                <span>{{ wpAdminModal.loadingMessage || 'Working…' }}</span>
                            </div>

                            <!-- Error / empty state -->
                            <div v-else-if="wpAdminModal.error" class="wp-admin-error">
                                <div class="error-header">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <line x1="12" y1="8" x2="12" y2="12"/>
                                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                                    </svg>
                                    <span>{{ wpAdminModal.credentials || wpAdminModal.setupResult ? 'Something went wrong' : 'No stored credentials' }}</span>
                                </div>
                                <p class="error-message">{{ wpAdminModal.error }}</p>

                                <details v-if="wpAdminModal.debug" class="debug-details">
                                    <summary>Debug Info</summary>
                                    <pre class="debug-output">{{ wpAdminModal.debug }}</pre>
                                </details>

                                <!-- Per-step setup output, if a setup attempt happened -->
                                <div v-if="wpAdminModal.setupResult" class="setup-results">
                                    <div class="setup-results-header" :class="{ ok: wpAdminModal.setupResult.success, fail: !wpAdminModal.setupResult.success }">
                                        {{ wpAdminModal.setupResult.success ? 'Setup complete' : 'Setup finished with errors' }}
                                    </div>
                                    <ul class="setup-steps">
                                        <li v-for="step in wpAdminModal.setupResult.steps" :key="step.name" :class="{ ok: step.success, fail: !step.success, skipped: step.skipped }">
                                            <span class="step-dot">{{ step.skipped ? '○' : (step.success ? '✓' : '✕') }}</span>
                                            <div class="step-body">
                                                <div class="step-name">{{ step.name }}<span v-if="step.skipped" class="step-tag">already done</span></div>
                                                <details v-if="step.output" class="step-details" :open="!step.success && !step.skipped">
                                                    <summary>output</summary>
                                                    <pre>{{ step.output }}</pre>
                                                </details>
                                            </div>
                                        </li>
                                    </ul>
                                </div>

                                <div class="modal-actions">
                                    <button class="btn btn-secondary" @click="wpAdminModal.open = false">Close</button>
                                    <button class="btn btn-secondary" @click="wpSetupMagic" :disabled="wpAdminModal.loading">
                                        {{ wpAdminModal.setupResult ? 'Retry setup' : 'Set up magic login' }}
                                    </button>
                                    <button class="btn btn-primary" @click="wpRotatePassword" :disabled="wpAdminModal.loading">
                                        Create WebSync admin
                                    </button>
                                </div>
                            </div>

                            <div v-else-if="wpAdminModal.credentials" class="wp-admin-credentials">
                                <div class="credentials-header">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                        <polyline points="22 4 12 14.01 9 11.01"/>
                                    </svg>
                                    <span v-if="wpAdminModal.credentials.justRotated">
                                        {{ wpAdminModal.credentials.reused ? 'Password rotated' : 'Admin created' }}
                                    </span>
                                    <span v-else>Stored credentials</span>
                                </div>

                                <div class="credential-row">
                                    <label>Username</label>
                                    <div class="credential-value">
                                        <code>{{ wpAdminModal.credentials.username }}</code>
                                        <button class="copy-btn" @click="copyToClipboard(wpAdminModal.credentials.username, 'Username')">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                            </svg>
                                        </button>
                                    </div>
                                </div>

                                <div class="credential-row">
                                    <label>Password</label>
                                    <div class="credential-value">
                                        <code>{{ wpAdminModal.credentials.password }}</code>
                                        <button class="copy-btn" @click="copyToClipboard(wpAdminModal.credentials.password, 'Password')">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                                            </svg>
                                        </button>
                                    </div>
                                </div>

                                <div v-if="wpAdminModal.credentials.lastRotated" class="credential-expiry">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <polyline points="12 6 12 12 16 14"/>
                                    </svg>
                                    <span>Last rotated: {{ new Date(wpAdminModal.credentials.lastRotated).toLocaleString() }}</span>
                                </div>

                                <div class="modal-actions">
                                    <button
                                        class="btn btn-secondary"
                                        @click="wpSetupMagic"
                                        :disabled="wpAdminModal.loading"
                                        title="Install + configure the magic-login plugin in this site's WordPress container"
                                    >
                                        Set up magic login
                                    </button>
                                    <button
                                        class="btn btn-secondary"
                                        @click="wpRotatePassword"
                                        :disabled="wpAdminModal.loading"
                                    >
                                        Rotate password
                                    </button>
                                    <button
                                        v-if="wpAdminModal.site"
                                        class="btn btn-primary"
                                        @click="wpQuickLogin(wpAdminModal.site!)"
                                    >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                                        </svg>
                                        One-click login
                                    </button>
                                </div>

                                <!-- Magic login setup results -->
                                <div v-if="wpAdminModal.setupResult" class="setup-results">
                                    <div class="setup-results-header" :class="{ ok: wpAdminModal.setupResult.success, fail: !wpAdminModal.setupResult.success }">
                                        {{ wpAdminModal.setupResult.success ? 'Setup complete' : 'Setup finished with errors' }}
                                    </div>
                                    <ul class="setup-steps">
                                        <li v-for="step in wpAdminModal.setupResult.steps" :key="step.name" :class="{ ok: step.success, fail: !step.success, skipped: step.skipped }">
                                            <span class="step-dot">{{ step.skipped ? '○' : (step.success ? '✓' : '✕') }}</span>
                                            <div class="step-body">
                                                <div class="step-name">{{ step.name }}<span v-if="step.skipped" class="step-tag">already done</span></div>
                                                <details v-if="step.output" class="step-details">
                                                    <summary>output</summary>
                                                    <pre>{{ step.output }}</pre>
                                                </details>
                                            </div>
                                        </li>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </Transition>
        </Teleport>

        <!-- WordPress Integrity Scan Modal -->
        <Teleport to="body">
            <Transition name="modal">
                <div v-if="scanModal.open" class="modal-overlay">
                    <div class="modal-content modal-sm scan-modal">
                        <div class="modal-header">
                            <h2>Integrity Scan<span v-if="scanModal.site" class="scan-site-name"> · {{ scanModal.site.label }}</span></h2>
                            <button class="modal-close" @click="scanModal.open = false">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>

                        <div class="modal-body">
                            <div v-if="scanModal.loading" class="loading-state-sm">
                                <div class="spinner"></div>
                                <span>{{ scanModal.loadingMessage || 'Working…' }}</span>
                            </div>

                            <!-- Error state -->
                            <div v-else-if="scanModal.error" class="wp-admin-error">
                                <div class="error-header">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <circle cx="12" cy="12" r="10"/>
                                        <line x1="12" y1="8" x2="12" y2="12"/>
                                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                                    </svg>
                                    <span>Scan error</span>
                                </div>
                                <p class="error-message">{{ scanModal.error }}</p>
                                <div class="modal-actions">
                                    <button class="btn btn-secondary" @click="scanModal.open = false">Close</button>
                                    <button class="btn btn-primary" @click="runScan">Try again</button>
                                </div>
                            </div>

                            <!-- Never scanned -->
                            <div v-else-if="!scanModal.scan" class="scan-empty">
                                <p>
                                    This site hasn’t been scanned yet. A scan verifies WordPress core &amp; plugin
                                    files against the official WordPress.org checksums, and looks for malware
                                    signatures, executable PHP in your uploads folder, and recently-changed files.
                                </p>
                                <div class="modal-actions">
                                    <button class="btn btn-secondary" @click="scanModal.open = false">Close</button>
                                    <button class="btn btn-primary" @click="runScan">Scan now</button>
                                </div>
                            </div>

                            <!-- Results -->
                            <div v-else class="scan-results">
                                <div class="scan-summary" :class="`scan-${scanModal.scan.status}`">
                                    <div class="scan-summary-status">{{ scanStatusLabel(scanModal.scan.status) }}</div>
                                    <div class="scan-summary-detail">
                                        <template v-if="scanModal.scan.status === 'clean'">
                                            No issues found. Core &amp; plugin files verify against official checksums.
                                        </template>
                                        <template v-else-if="scanModal.scan.status === 'error'">
                                            {{ scanModal.scan.error || 'Scan could not complete.' }}
                                        </template>
                                        <template v-else>
                                            {{ scanModal.scan.findingsCount || 0 }} finding(s)<span v-if="scanModal.scan.critical">, {{ scanModal.scan.critical }} critical</span>.
                                        </template>
                                    </div>
                                </div>

                                <div class="scan-meta">
                                    <span v-if="scanModal.scan.coreStatus">Core: {{ scanModal.scan.coreStatus }}</span>
                                    <span v-if="scanModal.scan.pluginStatus">Plugins: {{ scanModal.scan.pluginStatus }}</span>
                                    <span v-if="scanModal.scan.createdAt">Scanned {{ new Date(scanModal.scan.createdAt).toLocaleString() }}</span>
                                </div>

                                <ul class="findings-list" v-if="sortedFindings(scanModal.scan).length">
                                    <li
                                        v-for="(f, i) in sortedFindings(scanModal.scan)"
                                        :key="i"
                                        class="finding"
                                        :class="`sev-${f.severity}`"
                                    >
                                        <div class="finding-head">
                                            <span class="sev-tag">{{ f.severity }}</span>
                                            <span class="finding-title">{{ f.title }}</span>
                                            <span class="finding-count" v-if="f.paths.length">{{ f.paths.length }}</span>
                                        </div>
                                        <p class="finding-detail">{{ f.detail }}</p>
                                        <details v-if="f.paths.length" class="finding-paths" :open="f.severity === 'critical' || f.severity === 'high'">
                                            <summary>Affected files ({{ f.paths.length }})</summary>
                                            <ul class="path-list">
                                                <li v-for="p in f.paths" :key="p">
                                                    <code>{{ p }}</code>
                                                    <button
                                                        class="path-ignore"
                                                        title="Allowlist this file — ignore it in future scans on all sites"
                                                        @click="ignorePath(f, p)"
                                                    >Ignore</button>
                                                </li>
                                            </ul>
                                        </details>
                                        <p class="finding-fix"><strong>Fix:</strong> {{ f.remediation }}</p>
                                    </li>
                                </ul>

                                <!-- Allowlist management -->
                                <details v-if="scanAllowlist.length" class="allowlist-section">
                                    <summary>Allowlisted items ({{ scanAllowlist.length }})</summary>
                                    <p class="allowlist-hint">These are ignored in scans across all your sites.</p>
                                    <ul class="allowlist-list">
                                        <li v-for="a in scanAllowlist" :key="a.id">
                                            <span class="sev-tag">{{ a.category }}</span>
                                            <code>{{ a.path }}</code>
                                            <span v-if="a.builtin" class="builtin-tag" title="Managed by WebSync — cannot be removed">built-in</span>
                                            <button v-else class="path-ignore" title="Remove from allowlist" @click="removeAllowlistEntry(a)">Remove</button>
                                        </li>
                                    </ul>
                                </details>

                                <div class="modal-actions">
                                    <button class="btn btn-secondary" @click="scanModal.open = false">Close</button>
                                    <button class="btn btn-primary" @click="runScan" :disabled="scanModal.loading">Scan again</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </Transition>
        </Teleport>
  </div>
</template>

<style scoped>
.dashboard-page {
    animation: fadeIn var(--transition-normal);
}

/* Health Status Bar */
.health-bar {
  display: flex;
    align-items: center;
  justify-content: space-between;
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-lg);
    margin-bottom: var(--space-4);
    font-size: var(--text-sm);
}

.health-bar.healthy {
    background: var(--color-success-subtle);
    border: 1px solid var(--color-success);
}

.health-bar.unhealthy {
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
}

.health-content {
    display: flex;
  align-items: center;
    gap: var(--space-6);
    width: 100%;
    justify-content: space-between;
}

.health-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    animation: pulse 2s infinite;
}

.health-bar.healthy .pulse-dot {
    background: var(--color-success);
}

.health-bar.unhealthy .pulse-dot {
    background: var(--color-danger);
}

@keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(0.9); }
}

.health-text {
    font-weight: var(--font-medium);
}

.health-bar.healthy .health-text {
    color: var(--color-success);
}

.health-bar.unhealthy .health-text {
    color: var(--color-danger);
}

.sync-mode {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-secondary);
}

.sync-mode svg {
    width: 16px;
    height: 16px;
}

.alert-banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    background: var(--color-warning-subtle);
    border: 1px solid var(--color-warning);
    border-radius: var(--radius-lg);
    margin-bottom: var(--space-6);
    font-size: var(--text-sm);
    color: var(--text-primary);
}

.alert-banner svg {
    width: 20px;
    height: 20px;
    color: var(--color-warning);
    flex-shrink: 0;
}

.alert-banner a {
    color: var(--color-primary);
    font-weight: var(--font-medium);
}

.page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-6);
}

.section-title {
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-1);
}

.section-subtitle {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    transition: all var(--transition-fast);
}

.btn svg {
    width: 18px;
    height: 18px;
}

.btn-primary {
    background: var(--color-primary);
    color: var(--text-on-primary);
}

.btn-primary:hover {
    background: var(--color-primary-hover);
}

.btn-primary svg {
    color: var(--text-on-primary);
}

.btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.btn-secondary:hover {
    background: var(--border-secondary);
}

.btn-sync {
    width: 100%;
    background: var(--color-success);
    color: var(--text-on-success);
    justify-content: center;
}

.btn-sync:hover:not(:disabled) {
    background: var(--color-success-hover);
}

.btn-sync svg {
    color: var(--text-on-success);
}

.btn-sync:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

/* Sync Button Group */
.sync-button-group {
    display: flex;
    width: 100%;
}

.sync-button-group .btn-sync {
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
    flex: 1;
}

.sync-dropdown {
    position: relative;
}

.btn-sync-dropdown {
    background: var(--color-success);
    color: var(--text-on-success);
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
    padding: var(--space-3) var(--space-2);
    border-left: 1px solid rgba(0, 0, 0, 0.1);
    transition: all var(--transition-fast);
}

.btn-sync-dropdown:hover {
    background: var(--color-success-hover);
}

.btn-sync-dropdown svg {
    width: 16px;
    height: 16px;
    color: var(--text-on-success);
}

.dropdown-menu {
    position: absolute;
    bottom: calc(100% + var(--space-2));
    right: 0;
    background: var(--bg-elevated);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    min-width: 200px;
    box-shadow: var(--shadow-lg);
    z-index: 50;
    overflow: hidden;
}

.dropdown-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-primary);
    text-align: left;
    transition: all var(--transition-fast);
}

.dropdown-item:hover {
    background: var(--bg-tertiary);
}

.dropdown-item svg {
    width: 16px;
    height: 16px;
    color: var(--text-muted);
}

.dropdown-item-warning {
    color: var(--color-warning);
}

.dropdown-item-warning svg {
    color: var(--color-warning);
}

.dropdown-divider {
    height: 1px;
    background: var(--border-primary);
    margin: var(--space-1) 0;
}

/* Dropdown Transition */
.dropdown-enter-active,
.dropdown-leave-active {
    transition: all var(--transition-fast);
}

.dropdown-enter-from,
.dropdown-leave-to {
    opacity: 0;
    transform: translateY(8px);
}

/* Loading & Empty States */
.loading-state,
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-16);
    background: var(--bg-primary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--border-primary);
    text-align: center;
}

.spinner {
    width: 40px;
    height: 40px;
    border: 3px solid var(--border-primary);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: var(--space-4);
}

.loading-state span {
    color: var(--text-muted);
}

.empty-icon {
    width: 80px;
    height: 80px;
    color: var(--text-muted);
    margin-bottom: var(--space-4);
}

.empty-state h3 {
    font-size: var(--text-lg);
    color: var(--text-primary);
    margin-bottom: var(--space-2);
}

.empty-state p {
    color: var(--text-muted);
    margin-bottom: var(--space-6);
}

/* Sites Grid */
.sites-grid {
  display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: var(--space-6);
}

.site-card {
    background: var(--bg-primary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--border-primary);
    overflow: hidden;
    transition: all var(--transition-fast);
    animation: slideInUp var(--transition-normal);
}

.site-card:hover {
    box-shadow: var(--shadow-md);
    border-color: var(--border-secondary);
}

.card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-5);
    border-bottom: 1px solid var(--border-primary);
}

.card-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex: 1;
    min-width: 0;
    flex-wrap: wrap;
}

.site-name {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    min-width: 0;
    flex: 1 1 auto;
    overflow-wrap: anywhere;
}

/* Health indicators */
.health-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 2px var(--bg-elevated);
    cursor: help;
}
.health-up { background: var(--color-success); box-shadow: 0 0 0 2px var(--bg-elevated), 0 0 6px var(--color-success); }
.health-degraded { background: var(--color-warning); box-shadow: 0 0 0 2px var(--bg-elevated), 0 0 6px var(--color-warning); }
.health-down { background: var(--color-danger); box-shadow: 0 0 0 2px var(--bg-elevated), 0 0 8px var(--color-danger); animation: pulse-down 2s ease-in-out infinite; }
.health-unknown { background: var(--text-muted); }

@keyframes pulse-down {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
}

.ssl-warning {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-md);
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    font-weight: var(--font-medium);
    cursor: help;
}
.ssl-warning.ssl-expired {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.header-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

/* Magic-login setup results */
.setup-results {
    margin-top: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    background: var(--bg-secondary);
}
.setup-results-header {
    font-weight: var(--font-semibold);
    margin-bottom: var(--space-3);
    font-size: var(--text-sm);
}
.setup-results-header.ok { color: var(--color-success); }
.setup-results-header.fail { color: var(--color-danger); }

.setup-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}
.setup-steps li {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-sm);
}
.setup-steps .step-dot {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: bold;
    font-size: 12px;
    line-height: 1;
}
.setup-steps li.ok .step-dot { background: var(--color-success-subtle); color: var(--color-success); }
.setup-steps li.fail .step-dot { background: var(--color-danger-subtle); color: var(--color-danger); }
.setup-steps li.skipped .step-dot { background: var(--bg-tertiary); color: var(--text-muted); }

.setup-steps .step-body { flex: 1; min-width: 0; }
.setup-steps .step-name { color: var(--text-primary); }
.setup-steps .step-tag {
    margin-left: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: 1px var(--space-2);
    border-radius: var(--radius-sm);
}
.setup-steps .step-details {
    margin-top: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
}
.setup-steps .step-details pre {
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    padding: var(--space-2);
    overflow-x: auto;
    margin-top: var(--space-1);
    max-height: 160px;
}

/* Quick Links */
.quick-links {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
}

.quick-link {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    transition: all var(--transition-fast);
}

.quick-link svg {
    width: 16px;
    height: 16px;
}

.quick-link-editor {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
}

.quick-link-editor:hover {
    background: var(--color-primary);
  color: white;
}

.quick-link-site {
    background: var(--color-success-subtle);
    color: var(--color-success);
}

.quick-link-site:hover {
    background: var(--color-success);
  color: white;
}

.card-actions {
    display: flex;
    gap: var(--space-1);
    flex-shrink: 0;
}

.icon-btn {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    transition: all var(--transition-fast);
}

.icon-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.icon-btn-danger:hover {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.icon-btn svg {
    width: 16px;
    height: 16px;
}

.card-body {
    padding: var(--space-5);
}

.path-info {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
}

.path-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}

.path-label {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-muted);
    width: 50px;
    flex-shrink: 0;
}

.path-value {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--bg-secondary);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.path-arrow {
    display: flex;
    justify-content: center;
    padding-left: 60px;
    color: var(--text-muted);
}

.path-arrow svg {
    width: 16px;
    height: 16px;
}

.schedule-info,
.db-info {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: var(--space-3);
}

.schedule-info svg,
.db-info svg {
    width: 14px;
    height: 14px;
}

/* Remote Containers Section */
.remote-containers-section {
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-primary);
}

.remote-containers-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-bottom: var(--space-2);
}

.remote-containers-header svg {
    width: 14px;
    height: 14px;
    color: var(--color-primary);
}

.auto-start-badge {
    background: var(--color-success-subtle);
    color: var(--color-success);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
}

.remote-container-actions {
    display: flex;
    gap: var(--space-2);
}

.btn-sm {
    padding: var(--space-2);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
}

.btn-container-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    transition: all var(--transition-fast);
}

.btn-container-action:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-secondary);
}

.btn-container-action svg {
    width: 14px;
    height: 14px;
}

.card-footer {
    padding: var(--space-4) var(--space-5);
    background: var(--bg-secondary);
}

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
    background: var(--bg-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
    z-index: 100;
    padding: var(--space-4);
}

.modal-content {
    background: var(--bg-elevated);
    border-radius: var(--radius-xl);
  width: 100%;
    max-width: 560px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-xl);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--border-primary);
}

.modal-header h2 {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
}

.modal-close {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    transition: all var(--transition-fast);
}

.modal-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.modal-close svg {
    width: 20px;
    height: 20px;
}

.modal-form {
    padding: var(--space-6);
  display: flex;
  flex-direction: column;
    gap: var(--space-5);
}

.modal-body {
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-4);
}

.form-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
}

.required {
    color: var(--color-danger);
}

.form-input {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    color: var(--text-primary);
    transition: all var(--transition-fast);
}

.form-input::placeholder {
    color: var(--text-muted);
}

.form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
}

.form-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
}

.form-link {
    color: var(--color-primary);
    text-decoration: none;
}

.form-link:hover {
    text-decoration: underline;
}

/* Toggle Option */
.toggle-option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    cursor: pointer;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border-radius: var(--radius-lg);
    margin-top: var(--space-3);
}

.toggle-option input {
    position: absolute;
    opacity: 0;
}

.toggle-switch {
    width: 40px;
    height: 22px;
    background: var(--border-primary);
    border-radius: var(--radius-full);
    position: relative;
    transition: all var(--transition-fast);
    flex-shrink: 0;
}

.toggle-switch::after {
    content: '';
    position: absolute;
    width: 18px;
    height: 18px;
    background: white;
    border-radius: 50%;
    top: 2px;
    left: 2px;
    transition: all var(--transition-fast);
}

.toggle-option input:checked + .toggle-switch {
    background: var(--color-primary);
}

.toggle-option input:checked + .toggle-switch::after {
    left: 20px;
}

.toggle-label {
    font-size: var(--text-sm);
    color: var(--text-primary);
}

.form-divider {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.form-divider::before,
.form-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border-primary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-primary);
}

/* Modal Transitions */
.modal-enter-active,
.modal-leave-active {
    transition: opacity var(--transition-normal);
}

.modal-enter-active .modal-content,
.modal-leave-active .modal-content {
    transition: transform var(--transition-normal), opacity var(--transition-normal);
}

.modal-enter-from,
.modal-leave-to {
    opacity: 0;
}

.modal-enter-from .modal-content,
.modal-leave-to .modal-content {
    opacity: 0;
    transform: scale(0.95) translateY(20px);
}

@media (max-width: 600px) {
    .sites-grid {
        grid-template-columns: 1fr;
    }
    
    .form-row {
        grid-template-columns: 1fr;
    }
}

/* Site Type Icons */
.site-type-icon {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    flex-shrink: 0;
}

.site-type-icon svg {
    width: 16px;
    height: 16px;
}

.site-type-wordpress {
    background: #21759b20;
    color: #21759b;
}

.site-type-laravel {
    background: #ff2d2020;
    color: #ff2d20;
}

.site-type-node {
    background: #68a06320;
    color: #68a063;
}

.site-type-static {
    background: #f1680220;
    color: #f16802;
}

.site-type-custom {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
}

/* Site Type Selector in Form */
.site-type-selector {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
}

.site-type-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-3);
    border: 2px solid var(--border-primary);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: all var(--transition-fast);
    flex: 1;
    min-width: 70px;
}

.site-type-option input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
}

.site-type-option svg {
    width: 20px;
    height: 20px;
    color: var(--text-muted);
}

.site-type-option span {
    font-size: var(--text-xs);
    color: var(--text-secondary);
}

.site-type-option.active {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
}

.site-type-option.active svg {
    color: var(--color-primary);
}

.site-type-option.active span {
    color: var(--color-primary);
}

.site-type-option:hover:not(.active) {
    border-color: var(--border-secondary);
    background: var(--bg-tertiary);
}

/* WordPress Section */
.wordpress-section {
    background: var(--bg-secondary);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    margin-top: var(--space-2);
}

.wordpress-section .form-divider {
    margin-top: 0;
    margin-bottom: var(--space-4);
}

/* WP Admin Quick Link */
.quick-link-wp-admin {
    background: #21759b20;
    color: #21759b;
}

.quick-link-wp-admin:hover {
    background: #21759b;
    color: white;
}

/* WordPress Admin Modal */
.modal-sm {
    max-width: 400px;
}

.loading-state-sm {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
    gap: var(--space-4);
    color: var(--text-muted);
}

.wp-admin-credentials {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
}

.credentials-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-success);
    font-weight: var(--font-medium);
}

.credentials-header svg {
    width: 20px;
    height: 20px;
}

.credential-row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
}

.credential-row label {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
}

.credential-value {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--bg-tertiary);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
}

.credential-value code {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-primary);
}

.copy-btn {
    padding: var(--space-1);
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: all var(--transition-fast);
}

.copy-btn:hover {
    background: var(--bg-secondary);
    color: var(--color-primary);
}

.copy-btn svg {
    width: 16px;
    height: 16px;
}

.credential-expiry {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
    padding: var(--space-3);
    background: var(--color-warning-subtle);
    border-radius: var(--radius-md);
}

.credential-expiry svg {
    width: 16px;
    height: 16px;
    color: var(--color-warning);
}

.btn-block {
    width: 100%;
    margin-top: var(--space-2);
}

/* WP Admin Error State */
.wp-admin-error {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
}

.error-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--color-danger);
    font-weight: var(--font-medium);
}

.error-header svg {
    width: 20px;
    height: 20px;
}

.error-message {
    padding: var(--space-3);
    background: var(--color-danger-subtle);
    border-radius: var(--radius-md);
    color: var(--color-danger);
    font-size: var(--text-sm);
    margin: 0;
}

.debug-details {
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    overflow: hidden;
}

.debug-details summary {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    cursor: pointer;
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.debug-details summary:hover {
    background: var(--bg-secondary);
}

.debug-output {
    padding: var(--space-3);
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    background: var(--bg-primary);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
}

.error-help {
    font-size: var(--text-sm);
    color: var(--text-secondary);
}

.error-help strong {
    display: block;
    margin-bottom: var(--space-2);
}

.error-help ul {
    margin: 0;
    padding-left: var(--space-4);
}

.error-help li {
    margin-bottom: var(--space-1);
}

.reused-notice {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--color-info-subtle, var(--bg-tertiary));
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
}

/* Received Sites Section */
.received-sites-section {
    margin-top: var(--space-8);
    padding-top: var(--space-6);
    border-top: 1px solid var(--border-primary);
}

.section-header {
    margin-bottom: var(--space-6);
}

.section-title {
    display: flex;
    align-items: center;
    gap: var(--space-3);
}

.section-title svg {
    width: 24px;
    height: 24px;
    color: var(--color-info);
}

.section-title h3 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    color: var(--text-primary);
}

.section-badge {
    font-size: var(--text-sm);
    color: var(--text-muted);
    background: var(--bg-tertiary);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
}

.received-sites-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: var(--space-5);
}

.received-site-card {
    background: var(--bg-primary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--border-primary);
    overflow: hidden;
    position: relative;
}

.received-site-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: linear-gradient(90deg, var(--color-info), var(--color-info-subtle));
}

.received-card-header {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-secondary);
}

.received-card-title {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
}

.received-card-title h4 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text-primary);
}

.received-card-badges {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
}

.source-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-secondary);
    background: var(--bg-secondary);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
}

.source-badge svg {
    width: 12px;
    height: 12px;
}

.sync-status-badge {
    font-size: var(--text-xs);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-weight: 500;
}

.sync-status-badge.success {
    background: var(--color-success-subtle);
    color: var(--color-success);
}

.sync-status-badge.failed {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.received-card-body {
    padding: var(--space-4) var(--space-5);
}

.received-info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-2) 0;
}

.received-info-row:not(:last-child) {
    border-bottom: 1px solid var(--border-secondary);
}

.info-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.info-value {
    font-size: var(--text-sm);
    color: var(--text-secondary);
}

code.info-value {
    font-family: var(--font-mono);
    background: var(--bg-tertiary);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.info-link {
    color: var(--color-primary);
    text-decoration: none;
    font-size: var(--text-sm);
}

.info-link:hover {
    text-decoration: underline;
}

.received-card-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-5);
    background: var(--bg-secondary);
}

.read-only-label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--text-muted);
}

.read-only-label svg {
    width: 14px;
    height: 14px;
}

.btn-danger-icon {
    background: transparent;
    border: none;
    padding: var(--space-2);
    cursor: pointer;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    transition: all 0.2s ease;
}

.btn-danger-icon:hover {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.btn-danger-icon svg {
    width: 16px;
    height: 16px;
}

@media (max-width: 600px) {
    .received-sites-grid {
        grid-template-columns: 1fr;
    }
}

/* ===== Integrity scan badge (site card) ===== */
.scan-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-2);
    border: none;
    border-radius: var(--radius-full);
    font-size: 0.625rem;
    font-weight: var(--font-medium);
    cursor: pointer;
    transition: opacity var(--transition-fast, 0.15s);
}
.scan-badge:hover { opacity: 0.85; }
.scan-badge svg { width: 12px; height: 12px; }
.scan-clean { background: var(--color-success-subtle); color: var(--color-success); }
.scan-warning { background: var(--color-warning-subtle); color: var(--color-warning); }
.scan-compromised { background: var(--color-danger-subtle); color: var(--color-danger); }
.scan-error,
.scan-unknown { background: var(--bg-tertiary); color: var(--text-muted); }

/* ===== Scan modal ===== */
.scan-site-name { color: var(--text-muted); font-weight: var(--font-medium); }
.scan-modal .modal-body { max-height: 70vh; overflow-y: auto; }
.scan-empty p { color: var(--text-secondary); font-size: var(--text-sm); line-height: 1.5; }

.scan-summary {
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-3);
}
.scan-summary.scan-clean { background: var(--color-success-subtle); }
.scan-summary.scan-warning { background: var(--color-warning-subtle); }
.scan-summary.scan-compromised { background: var(--color-danger-subtle); }
.scan-summary.scan-error,
.scan-summary.scan-unknown { background: var(--bg-tertiary); }
.scan-summary-status { font-weight: var(--font-semibold); font-size: var(--text-sm); }
.scan-summary.scan-clean .scan-summary-status { color: var(--color-success); }
.scan-summary.scan-warning .scan-summary-status { color: var(--color-warning); }
.scan-summary.scan-compromised .scan-summary-status { color: var(--color-danger); }
.scan-summary-detail { color: var(--text-secondary); font-size: var(--text-xs); margin-top: 2px; }

.scan-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-xs);
    margin-bottom: var(--space-4);
}

.findings-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.finding {
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: var(--radius-sm);
    padding: var(--space-3);
    background: var(--bg-secondary);
}
.finding.sev-critical { border-left-color: var(--color-danger); }
.finding.sev-high { border-left-color: var(--color-danger); }
.finding.sev-medium { border-left-color: var(--color-warning); }
.finding.sev-low { border-left-color: var(--color-warning); }
.finding.sev-info { border-left-color: var(--text-muted); }

.finding-head { display: flex; align-items: center; gap: var(--space-2); }
.sev-tag {
    text-transform: uppercase;
    font-size: 0.5625rem;
    font-weight: var(--font-semibold);
    letter-spacing: 0.04em;
    padding: 2px var(--space-2);
    border-radius: var(--radius-full);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
}
.sev-critical .sev-tag,
.sev-high .sev-tag { background: var(--color-danger-subtle); color: var(--color-danger); }
.sev-medium .sev-tag,
.sev-low .sev-tag { background: var(--color-warning-subtle); color: var(--color-warning); }
.finding-title { font-weight: var(--font-medium); font-size: var(--text-sm); color: var(--text-primary); }
.finding-count {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
}
.finding-detail { color: var(--text-secondary); font-size: var(--text-xs); margin: var(--space-2) 0; line-height: 1.5; }
.finding-paths { margin: var(--space-2) 0; }
.finding-paths summary { cursor: pointer; font-size: var(--text-xs); color: var(--text-muted); }
.finding-paths pre {
    margin-top: var(--space-2);
    padding: var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    max-height: 180px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
}
.finding-fix { font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.5; margin: var(--space-2) 0 0; }
.finding-fix strong { color: var(--text-primary); }

/* Per-path list with allowlist buttons */
.path-list { list-style: none; padding: 0; margin: var(--space-2) 0 0; display: flex; flex-direction: column; gap: var(--space-1); }
.path-list li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    padding: var(--space-1) var(--space-2);
}
.path-list code {
    flex: 1;
    font-size: var(--text-xs);
    word-break: break-all;
}
.path-ignore {
    flex-shrink: 0;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: 0.625rem;
    font-weight: var(--font-medium);
    padding: 2px var(--space-2);
    cursor: pointer;
}
.path-ignore:hover { color: var(--text-primary); border-color: var(--text-muted); }

/* Allowlist management section */
.allowlist-section { margin-top: var(--space-4); border-top: 1px solid var(--border); padding-top: var(--space-3); }
.allowlist-section summary { cursor: pointer; font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--text-secondary); }
.allowlist-hint { font-size: var(--text-xs); color: var(--text-muted); margin: var(--space-2) 0; }
.allowlist-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: var(--space-1); }
.allowlist-list li { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-1) 0; }
.allowlist-list code { flex: 1; font-size: var(--text-xs); word-break: break-all; }
.builtin-tag {
    flex-shrink: 0;
    font-size: 0.5625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    background: var(--bg-tertiary);
    border-radius: var(--radius-full);
    padding: 2px var(--space-2);
}
</style>
