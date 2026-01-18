<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useApi } from '../composables/useApi';
import { useJobUpdates } from '../composables/useWebSocket';
import StatusBadge from '../components/StatusBadge.vue';
import SyncProgress from '../components/SyncProgress.vue';

const { getJobs } = useApi();

const jobs = ref<any[]>([]);
const total = ref(0);
const loading = ref(true);
const filter = ref<'all' | 'RUNNING' | 'COMPLETED' | 'FAILED'>('all');
const page = ref(1);
const limit = 20;

const runningJobs = ref<Map<string, { progress: number; message: string }>>(new Map());

const loadJobs = async () => {
    loading.value = true;
    try {
        const params: any = { limit, offset: (page.value - 1) * limit };
        if (filter.value !== 'all') {
            params.status = filter.value;
        }
        const data = await getJobs(params);
        jobs.value = data.jobs;
        total.value = data.total;
    } catch (e) {
        console.error('Failed to load jobs:', e);
    } finally {
        loading.value = false;
    }
};

const totalPages = computed(() => Math.ceil(total.value / limit));

const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
};

const formatDuration = (start: string, end?: string) => {
    if (!end) return 'In progress';
    const duration = new Date(end).getTime() - new Date(start).getTime();
    const seconds = Math.floor(duration / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
};

// Real-time updates
useJobUpdates((update) => {
    if (update.type === 'job:started' && update.job) {
        // Add new job to list if viewing all or running
        if (filter.value === 'all' || filter.value === 'RUNNING') {
            jobs.value.unshift(update.job);
            total.value++;
        }
        runningJobs.value.set(update.job.id, { progress: 0, message: 'Starting...' });
    } else if (update.type === 'job:progress' && update.jobId) {
        runningJobs.value.set(update.jobId, {
            progress: update.progress || 0,
            message: update.message || 'Syncing...'
        });
    } else if ((update.type === 'job:completed' || update.type === 'job:failed') && update.job) {
        runningJobs.value.delete(update.job.id);
        // Update job in list
        const index = jobs.value.findIndex(j => j.id === update.job.id);
        if (index !== -1) {
            jobs.value[index] = update.job;
        }
    }
});

onMounted(loadJobs);
</script>

<template>
    <div class="jobs-page">
        <!-- Header -->
        <div class="page-header">
            <div class="header-info">
                <h2 class="section-title">Job History</h2>
                <p class="section-subtitle">{{ total }} total jobs</p>
            </div>
            <div class="header-actions">
                <div class="filter-group">
                    <button 
                        class="filter-btn" 
                        :class="{ active: filter === 'all' }"
                        @click="filter = 'all'; page = 1; loadJobs()"
                    >All</button>
                    <button 
                        class="filter-btn" 
                        :class="{ active: filter === 'RUNNING' }"
                        @click="filter = 'RUNNING'; page = 1; loadJobs()"
                    >Running</button>
                    <button 
                        class="filter-btn" 
                        :class="{ active: filter === 'COMPLETED' }"
                        @click="filter = 'COMPLETED'; page = 1; loadJobs()"
                    >Completed</button>
                    <button 
                        class="filter-btn" 
                        :class="{ active: filter === 'FAILED' }"
                        @click="filter = 'FAILED'; page = 1; loadJobs()"
                    >Failed</button>
                </div>
            </div>
        </div>

        <!-- Jobs Table -->
        <div class="jobs-table-container">
            <div v-if="loading" class="loading-state">
                <div class="spinner"></div>
                <span>Loading jobs...</span>
            </div>

            <table v-else-if="jobs.length > 0" class="jobs-table">
                <thead>
                    <tr>
                        <th>Site</th>
                        <th>Type</th>
                        <th>Status</th>
                        <th>Started</th>
                        <th>Duration</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="job in jobs" :key="job.id">
                        <td class="site-cell">
                            <span class="site-name">{{ job.site?.label || 'Unknown' }}</span>
                        </td>
                        <td>
                            <span class="job-type">{{ job.type.replace('_', ' ') }}</span>
                        </td>
                        <td>
                            <StatusBadge :status="job.status" />
                            <SyncProgress 
                                v-if="job.status === 'RUNNING' && runningJobs.has(job.id)"
                                :progress="runningJobs.get(job.id)?.progress || 0"
                                :message="runningJobs.get(job.id)?.message"
                                :animated="true"
                                class="inline-progress"
                            />
                        </td>
                        <td class="date-cell">{{ formatDate(job.startedAt) }}</td>
                        <td class="duration-cell">{{ formatDuration(job.startedAt, job.endedAt) }}</td>
                    </tr>
                </tbody>
            </table>

            <div v-else class="empty-state">
                <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                </svg>
                <h3>No jobs found</h3>
                <p>Jobs will appear here when you trigger syncs</p>
            </div>
        </div>

        <!-- Pagination -->
        <div v-if="totalPages > 1" class="pagination">
            <button 
                class="page-btn" 
                :disabled="page === 1"
                @click="page--; loadJobs()"
            >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"/>
                </svg>
                Previous
            </button>
            <span class="page-info">Page {{ page }} of {{ totalPages }}</span>
            <button 
                class="page-btn" 
                :disabled="page === totalPages"
                @click="page++; loadJobs()"
            >
                Next
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"/>
                </svg>
            </button>
        </div>
    </div>
</template>

<style scoped>
.jobs-page {
    animation: fadeIn var(--transition-normal);
}

.page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--space-6);
    gap: var(--space-4);
    flex-wrap: wrap;
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

.filter-group {
    display: flex;
    background: var(--bg-primary);
    border-radius: var(--radius-lg);
    padding: var(--space-1);
    border: 1px solid var(--border-primary);
}

.filter-btn {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
    transition: all var(--transition-fast);
}

.filter-btn:hover {
    color: var(--text-primary);
}

.filter-btn.active {
    background: var(--color-primary);
    color: white;
}

.jobs-table-container {
    background: var(--bg-primary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--border-primary);
    overflow: hidden;
}

.loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-16);
    gap: var(--space-4);
    color: var(--text-muted);
}

.spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-primary);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

.jobs-table {
    width: 100%;
    border-collapse: collapse;
}

.jobs-table th {
    text-align: left;
    padding: var(--space-4) var(--space-5);
    background: var(--bg-secondary);
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border-primary);
}

.jobs-table td {
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border-primary);
    font-size: var(--text-sm);
    color: var(--text-primary);
}

.jobs-table tbody tr:last-child td {
    border-bottom: none;
}

.jobs-table tbody tr:hover {
    background: var(--bg-secondary);
}

.site-name {
    font-weight: var(--font-medium);
}

.job-type {
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-transform: capitalize;
}

.date-cell {
    color: var(--text-secondary);
}

.duration-cell {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
}

.inline-progress {
    margin-top: var(--space-2);
    max-width: 200px;
}

.empty-state {
    text-align: center;
    padding: var(--space-16);
}

.empty-icon {
    width: 64px;
    height: 64px;
    color: var(--text-muted);
    margin-bottom: var(--space-4);
}

.empty-state h3 {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-2);
}

.empty-state p {
    color: var(--text-muted);
    font-size: var(--text-sm);
}

.pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-4);
    margin-top: var(--space-6);
}

.page-btn {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
    transition: all var(--transition-fast);
}

.page-btn:hover:not(:disabled) {
    background: var(--bg-secondary);
    border-color: var(--border-secondary);
}

.page-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.page-btn svg {
    width: 16px;
    height: 16px;
}

.page-info {
    font-size: var(--text-sm);
    color: var(--text-muted);
}
</style>
