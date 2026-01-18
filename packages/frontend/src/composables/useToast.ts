import { ref, readonly } from 'vue';

export interface Toast {
    id: string;
    type: 'success' | 'error' | 'warning' | 'info';
    title: string;
    message?: string;
    duration?: number;
}

const toasts = ref<Toast[]>([]);

let toastId = 0;

export function useToast() {
    const addToast = (toast: Omit<Toast, 'id'>) => {
        const id = `toast-${++toastId}`;
        const newToast: Toast = {
            id,
            duration: 5000,
            ...toast
        };
        
        toasts.value.push(newToast);

        if (newToast.duration && newToast.duration > 0) {
            setTimeout(() => {
                removeToast(id);
            }, newToast.duration);
        }

        return id;
    };

    const removeToast = (id: string) => {
        const index = toasts.value.findIndex(t => t.id === id);
        if (index !== -1) {
            toasts.value.splice(index, 1);
        }
    };

    const success = (title: string, message?: string) => 
        addToast({ type: 'success', title, message });

    const error = (title: string, message?: string) => 
        addToast({ type: 'error', title, message, duration: 8000 });

    const warning = (title: string, message?: string) => 
        addToast({ type: 'warning', title, message });

    const info = (title: string, message?: string) => 
        addToast({ type: 'info', title, message });

    return {
        toasts: readonly(toasts),
        addToast,
        removeToast,
        success,
        error,
        warning,
        info
    };
}
