<script setup lang="ts">
import { useToast } from '../composables/useToast';

const { toasts, removeToast } = useToast();

const getIcon = (type: string) => {
    switch (type) {
        case 'success': return 'check-circle';
        case 'error': return 'x-circle';
        case 'warning': return 'alert-triangle';
        default: return 'info';
    }
};
</script>

<template>
    <Teleport to="body">
        <div class="toast-container">
            <TransitionGroup name="toast">
                <div 
                    v-for="toast in toasts" 
                    :key="toast.id" 
                    class="toast"
                    :class="`toast-${toast.type}`"
                >
                    <div class="toast-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <template v-if="getIcon(toast.type) === 'check-circle'">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                <polyline points="22 4 12 14.01 9 11.01"/>
                            </template>
                            <template v-else-if="getIcon(toast.type) === 'x-circle'">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="15" y1="9" x2="9" y2="15"/>
                                <line x1="9" y1="9" x2="15" y2="15"/>
                            </template>
                            <template v-else-if="getIcon(toast.type) === 'alert-triangle'">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                <line x1="12" y1="9" x2="12" y2="13"/>
                                <line x1="12" y1="17" x2="12.01" y2="17"/>
                            </template>
                            <template v-else>
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="16" x2="12" y2="12"/>
                                <line x1="12" y1="8" x2="12.01" y2="8"/>
                            </template>
                        </svg>
                    </div>
                    <div class="toast-content">
                        <p class="toast-title">{{ toast.title }}</p>
                        <p v-if="toast.message" class="toast-message">{{ toast.message }}</p>
                    </div>
                    <button class="toast-close" @click="removeToast(toast.id)" aria-label="Close">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
            </TransitionGroup>
        </div>
    </Teleport>
</template>

<style scoped>
.toast-container {
    position: fixed;
    bottom: var(--space-6);
    right: var(--space-6);
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 400px;
    width: 100%;
    pointer-events: none;
}

.toast {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-4);
    background: var(--bg-elevated);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--border-primary);
    pointer-events: auto;
    animation: slideInRight var(--transition-normal);
}

.toast-success {
    border-left: 4px solid var(--color-success);
}

.toast-error {
    border-left: 4px solid var(--color-danger);
}

.toast-warning {
    border-left: 4px solid var(--color-warning);
}

.toast-info {
    border-left: 4px solid var(--color-primary);
}

.toast-icon {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
}

.toast-success .toast-icon {
    color: var(--color-success);
}

.toast-error .toast-icon {
    color: var(--color-danger);
}

.toast-warning .toast-icon {
    color: var(--color-warning);
}

.toast-info .toast-icon {
    color: var(--color-primary);
}

.toast-icon svg {
    width: 100%;
    height: 100%;
}

.toast-content {
    flex: 1;
    min-width: 0;
}

.toast-title {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin: 0;
}

.toast-message {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin: var(--space-1) 0 0;
}

.toast-close {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    color: var(--text-muted);
    transition: color var(--transition-fast);
}

.toast-close:hover {
    color: var(--text-primary);
}

.toast-close svg {
    width: 100%;
    height: 100%;
}

/* Transitions */
.toast-enter-active,
.toast-leave-active {
    transition: all var(--transition-normal);
}

.toast-enter-from {
    opacity: 0;
    transform: translateX(100%);
}

.toast-leave-to {
    opacity: 0;
    transform: translateX(100%);
}

.toast-move {
    transition: transform var(--transition-normal);
}
</style>
