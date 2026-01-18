import { ref, readonly } from 'vue';

// Shared reactive state for app-wide settings
const hideBranding = ref(false);
const settingsLoaded = ref(false);

export function useAppSettings() {
    const loadSettings = async () => {
        try {
            const token = localStorage.getItem('websync-token');
            if (!token) return;
            
            const response = await fetch('/settings', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                const settings = await response.json();
                hideBranding.value = settings.hideBranding ?? false;
                settingsLoaded.value = true;
            }
        } catch {
            // Ignore errors - default to showing branding
        }
    };

    const setHideBranding = (value: boolean) => {
        hideBranding.value = value;
    };

    return {
        hideBranding: readonly(hideBranding),
        settingsLoaded: readonly(settingsLoaded),
        loadSettings,
        setHideBranding
    };
}
