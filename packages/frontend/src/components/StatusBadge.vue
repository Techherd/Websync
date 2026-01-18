<script setup lang="ts">
defineProps<{
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'idle' | 'syncing' | 'error';
    size?: 'sm' | 'md';
}>();

const statusConfig: Record<string, { label: string; class: string }> = {
    PENDING: { label: 'Pending', class: 'status-pending' },
    RUNNING: { label: 'Running', class: 'status-running' },
    COMPLETED: { label: 'Completed', class: 'status-success' },
    FAILED: { label: 'Failed', class: 'status-error' },
    idle: { label: 'Idle', class: 'status-idle' },
    syncing: { label: 'Syncing', class: 'status-running' },
    error: { label: 'Error', class: 'status-error' }
};
</script>

<template>
    <span class="status-badge" :class="[statusConfig[status]?.class, size === 'sm' ? 'size-sm' : '']">
        <span class="status-dot" :class="{ 'animate-pulse': status === 'RUNNING' || status === 'syncing' }"></span>
        <span class="status-label">{{ statusConfig[status]?.label || status }}</span>
    </span>
</template>

<style scoped>
.status-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
}

.status-badge.size-sm {
    padding: var(--space-1) var(--space-2);
    font-size: 0.625rem;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.size-sm .status-dot {
    width: 6px;
    height: 6px;
}

.animate-pulse {
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

/* Status variants */
.status-pending {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
}

.status-pending .status-dot {
    background: var(--color-warning);
}

.status-running {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
}

.status-running .status-dot {
    background: var(--color-primary);
}

.status-success {
    background: var(--color-success-subtle);
    color: var(--color-success);
}

.status-success .status-dot {
    background: var(--color-success);
}

.status-error {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.status-error .status-dot {
    background: var(--color-danger);
}

.status-idle {
    background: var(--bg-tertiary);
    color: var(--text-muted);
}

.status-idle .status-dot {
    background: var(--text-muted);
}
</style>
