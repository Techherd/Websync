<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{
    progress: number;
    message?: string;
    animated?: boolean;
}>();
const value = computed(() => Number.isFinite(props.progress) ? Math.min(100, Math.max(0, props.progress)) : 0);
</script>

<template>
    <div class="sync-progress">
        <div class="progress-header">
            <span class="progress-label" role="status">{{ message || 'Syncing...' }}</span>
            <span class="progress-value">{{ value }}%</span>
        </div>
        <div class="progress-bar" role="progressbar" aria-label="Sync progress" :aria-valuenow="value" aria-valuemin="0" aria-valuemax="100">
            <div 
                class="progress-fill" 
                :class="{ animated }"
                :style="{ width: `${value}%` }"
            ></div>
        </div>
    </div>
</template>

<style scoped>
.sync-progress {
    width: 100%;
}

.progress-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
}

.progress-label {
    font-size: var(--text-sm);
    color: var(--text-secondary);
}

.progress-value {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--color-primary);
}

.progress-bar {
    height: 8px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-full);
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--color-primary), var(--color-primary-light));
    border-radius: var(--radius-full);
    transition: width var(--transition-normal);
}

.progress-fill.animated {
    background-image: 
        linear-gradient(90deg, var(--color-primary), var(--color-primary-light)),
        repeating-linear-gradient(
            45deg,
            transparent,
            transparent 10px,
            rgba(255, 255, 255, 0.1) 10px,
            rgba(255, 255, 255, 0.1) 20px
        );
    background-size: 100% 100%, 40px 40px;
    animation: progressStripes 1s linear infinite;
}
</style>
