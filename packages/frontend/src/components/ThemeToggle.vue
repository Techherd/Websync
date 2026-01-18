<script setup lang="ts">
import { useTheme } from '../composables/useTheme';

const { resolvedTheme, toggleTheme } = useTheme();
</script>

<template>
    <button class="theme-toggle" @click="toggleTheme" :aria-label="`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`">
        <!-- Sun icon for dark mode (click to go light) -->
        <svg v-if="resolvedTheme === 'dark'" class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
        </svg>
        <!-- Moon icon for light mode (click to go dark) -->
        <svg v-else class="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
        </svg>
    </button>
</template>

<style scoped>
.theme-toggle {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    transition: all var(--transition-fast);
}

.theme-toggle:hover {
    background: var(--bg-tertiary);
    color: var(--color-primary);
}

.theme-icon {
    width: 20px;
    height: 20px;
}
</style>
