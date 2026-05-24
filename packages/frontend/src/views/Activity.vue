<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useApi } from '../composables/useApi';
import { useToast } from '../composables/useToast';

interface AuditEvent {
    id: string;
    action: string;
    siteId: string | null;
    createdAt: string;
    metadata: Record<string, any> | null;
    user: { id: string; name: string; email: string } | null;
}

const { getAudit, getSites, getUsers } = useApi();
const { error } = useToast();

const events = ref<AuditEvent[]>([]);
const total = ref(0);
const loading = ref(true);
const sites = ref<{ id: string; label: string }[]>([]);
const users = ref<{ id: string; name: string; email: string }[]>([]);
const siteFilter = ref<string>('');
const userFilter = ref<string>('');
const page = ref(1);
const limit = 50;

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit)));

const siteLabel = (id: string | null) => {
    if (!id) return null;
    return sites.value.find(s => s.id === id)?.label || id.slice(0, 8);
};

const load = async () => {
    loading.value = true;
    try {
        const params: any = { limit, offset: (page.value - 1) * limit };
        if (siteFilter.value) params.siteId = siteFilter.value;
        if (userFilter.value) params.userId = userFilter.value;
        const data = await getAudit(params);
        events.value = data.events;
        total.value = data.total;
    } catch (e: any) {
        error('Failed to load activity', e.message || 'Try again');
    } finally {
        loading.value = false;
    }
};

const loadFilters = async () => {
    try {
        const [s, u] = await Promise.all([getSites(), getUsers()]);
        sites.value = (s as any[]).map(x => ({ id: x.id, label: x.label }));
        users.value = u || [];
    } catch {
        // non-fatal
    }
};

const setSiteFilter = (id: string) => { siteFilter.value = id; page.value = 1; load(); };
const setUserFilter = (id: string) => { userFilter.value = id; page.value = 1; load(); };

const formatTime = (s: string) => {
    const d = new Date(s);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleString();
};

const actionIcon = (action: string): string => {
    if (action.startsWith('site.sync')) return 'sync';
    if (action.startsWith('site.')) return 'edit';
    if (action.startsWith('wp.login')) return 'bolt';
    if (action.startsWith('wp.')) return 'key';
    if (action.startsWith('user.')) return 'user';
    return 'dot';
};

const actionLabel = (action: string): string => {
    const map: Record<string, string> = {
        'site.create': 'Created site',
        'site.update': 'Updated site',
        'site.delete': 'Deleted site',
        'site.sync': 'Started sync',
        'wp.rotatePassword': 'Rotated WP admin password',
        'wp.login': 'Generated WP magic login link',
        'user.create': 'Added user',
        'user.update': 'Updated user',
        'user.delete': 'Removed user'
    };
    return map[action] || action;
};

onMounted(async () => {
    await loadFilters();
    await load();
});
</script>

<template>
    <div class="activity-page">
        <div class="page-header">
            <div>
                <h2 class="section-title">Activity</h2>
                <p class="section-subtitle">{{ total }} event{{ total === 1 ? '' : 's' }}</p>
            </div>
            <div class="filters">
                <select v-model="siteFilter" @change="setSiteFilter(siteFilter)" class="filter-select">
                    <option value="">All sites</option>
                    <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.label }}</option>
                </select>
                <select v-model="userFilter" @change="setUserFilter(userFilter)" class="filter-select">
                    <option value="">All users</option>
                    <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
                </select>
            </div>
        </div>

        <div v-if="loading" class="loading-state"><div class="spinner"></div><span>Loading…</span></div>

        <div v-else-if="events.length === 0" class="empty-state">
            <p>No events yet. Trigger a sync or create a site to see activity here.</p>
        </div>

        <ul v-else class="timeline">
            <li v-for="e in events" :key="e.id" class="event">
                <div class="event-icon" :class="`icon-${actionIcon(e.action)}`">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <template v-if="actionIcon(e.action) === 'sync'">
                            <polyline points="23 4 23 10 17 10"/>
                            <polyline points="1 20 1 14 7 14"/>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                        </template>
                        <template v-else-if="actionIcon(e.action) === 'edit'">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </template>
                        <template v-else-if="actionIcon(e.action) === 'bolt'">
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                        </template>
                        <template v-else-if="actionIcon(e.action) === 'key'">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </template>
                        <template v-else-if="actionIcon(e.action) === 'user'">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </template>
                        <template v-else>
                            <circle cx="12" cy="12" r="4"/>
                        </template>
                    </svg>
                </div>
                <div class="event-body">
                    <div class="event-line">
                        <strong>{{ e.user?.name || 'System' }}</strong>
                        <span class="event-action">{{ actionLabel(e.action) }}</span>
                        <span v-if="siteLabel(e.siteId)" class="event-site">on {{ siteLabel(e.siteId) }}</span>
                    </div>
                    <div class="event-meta">
                        <span>{{ formatTime(e.createdAt) }}</span>
                        <span v-if="e.user?.email">· {{ e.user.email }}</span>
                    </div>
                    <details v-if="e.metadata && Object.keys(e.metadata).length" class="event-details">
                        <summary>details</summary>
                        <pre>{{ JSON.stringify(e.metadata, null, 2) }}</pre>
                    </details>
                </div>
            </li>
        </ul>

        <div v-if="!loading && totalPages > 1" class="pagination">
            <button class="btn-sm" :disabled="page === 1" @click="page--; load()">Previous</button>
            <span>Page {{ page }} of {{ totalPages }}</span>
            <button class="btn-sm" :disabled="page === totalPages" @click="page++; load()">Next</button>
        </div>
    </div>
</template>

<style scoped>
.activity-page { animation: fadeIn var(--transition-normal); max-width: 900px; }

.page-header {
    display: flex; align-items: flex-end; justify-content: space-between;
    gap: var(--space-4); margin-bottom: var(--space-6); flex-wrap: wrap;
}
.section-title { font-size: var(--text-2xl); font-weight: var(--font-bold); color: var(--text-primary); }
.section-subtitle { font-size: var(--text-sm); color: var(--text-muted); margin-top: var(--space-1); }
.filters { display: flex; gap: var(--space-2); }
.filter-select {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-elevated);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-primary);
}

.timeline { list-style: none; display: flex; flex-direction: column; gap: var(--space-3); padding: 0; }
.event {
    display: flex; gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elevated);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
}
.event-icon {
    width: 36px; height: 36px; flex-shrink: 0;
    border-radius: var(--radius-md);
    display: flex; align-items: center; justify-content: center;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
}
.event-icon svg { width: 18px; height: 18px; }
.event-icon.icon-sync { background: var(--color-primary-subtle); color: var(--color-primary); }
.event-icon.icon-bolt { background: var(--color-warning-subtle); color: var(--color-warning); }
.event-icon.icon-key { background: var(--color-success-subtle); color: var(--color-success); }
.event-icon.icon-user { background: var(--color-primary-subtle); color: var(--color-primary); }

.event-body { flex: 1; min-width: 0; }
.event-line { font-size: var(--text-sm); color: var(--text-primary); }
.event-line strong { font-weight: var(--font-semibold); }
.event-action { margin-left: var(--space-1); color: var(--text-secondary); }
.event-site { margin-left: var(--space-1); color: var(--text-muted); }
.event-meta { font-size: var(--text-xs); color: var(--text-muted); margin-top: var(--space-1); }
.event-details { margin-top: var(--space-2); font-size: var(--text-xs); color: var(--text-muted); }
.event-details pre {
    background: var(--bg-secondary);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    overflow-x: auto;
    margin-top: var(--space-1);
}

.loading-state {
    display: flex; align-items: center; gap: var(--space-3);
    padding: var(--space-6); color: var(--text-muted);
}
.spinner {
    width: 20px; height: 20px;
    border: 2px solid var(--border-primary);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
}
.empty-state {
    padding: var(--space-8);
    text-align: center;
    color: var(--text-muted);
    background: var(--bg-elevated);
    border: 1px dashed var(--border-primary);
    border-radius: var(--radius-lg);
}

.pagination {
    display: flex; align-items: center; justify-content: center;
    gap: var(--space-3); margin-top: var(--space-5);
    font-size: var(--text-sm); color: var(--text-muted);
}
.btn-sm {
    padding: var(--space-2) var(--space-3);
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
}
.btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
