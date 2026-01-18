<script setup lang="ts">
defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'primary';
}>();

const emit = defineEmits<{
    confirm: [];
    cancel: [];
}>();
</script>

<template>
    <Teleport to="body">
        <Transition name="modal">
            <div v-if="open" class="modal-overlay" @click.self="emit('cancel')">
                <div class="modal-dialog" role="alertdialog" aria-modal="true">
                    <div class="modal-icon" :class="`icon-${variant || 'primary'}`">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <template v-if="variant === 'danger'">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="15" y1="9" x2="9" y2="15"/>
                                <line x1="9" y1="9" x2="15" y2="15"/>
                            </template>
                            <template v-else-if="variant === 'warning'">
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
                    <h2 class="modal-title">{{ title }}</h2>
                    <p class="modal-message">{{ message }}</p>
                    <div class="modal-actions">
                        <button class="btn btn-secondary" @click="emit('cancel')">
                            {{ cancelLabel || 'Cancel' }}
                        </button>
                        <button 
                            class="btn" 
                            :class="`btn-${variant || 'primary'}`"
                            @click="emit('confirm')"
                        >
                            {{ confirmLabel || 'Confirm' }}
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
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

.modal-dialog {
    background: var(--bg-elevated);
    border-radius: var(--radius-xl);
    padding: var(--space-8);
    max-width: 400px;
    width: 100%;
    text-align: center;
    box-shadow: var(--shadow-xl);
}

.modal-icon {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto var(--space-4);
}

.modal-icon svg {
    width: 28px;
    height: 28px;
}

.icon-primary {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
}

.icon-danger {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.icon-warning {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
}

.modal-title {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-2);
}

.modal-message {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-bottom: var(--space-6);
    line-height: var(--leading-relaxed);
}

.modal-actions {
    display: flex;
    gap: var(--space-3);
    justify-content: center;
}

.btn {
    padding: var(--space-3) var(--space-6);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    transition: all var(--transition-fast);
    min-width: 100px;
}

.btn-primary {
    background: var(--color-primary);
    color: var(--text-on-primary);
}

.btn-primary:hover {
    background: var(--color-primary-hover);
}

.btn-danger {
    background: var(--color-danger);
    color: var(--text-on-danger);
}

.btn-danger:hover {
    background: var(--color-danger-hover);
}

.btn-warning {
    background: var(--color-warning);
    color: white;
}

.btn-warning:hover {
    background: var(--color-warning-hover);
}

.btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.btn-secondary:hover {
    background: var(--border-secondary);
}

/* Transitions */
.modal-enter-active,
.modal-leave-active {
    transition: opacity var(--transition-normal);
}

.modal-enter-active .modal-dialog,
.modal-leave-active .modal-dialog {
    transition: transform var(--transition-normal), opacity var(--transition-normal);
}

.modal-enter-from,
.modal-leave-to {
    opacity: 0;
}

.modal-enter-from .modal-dialog,
.modal-leave-to .modal-dialog {
    opacity: 0;
    transform: scale(0.95);
}
</style>
