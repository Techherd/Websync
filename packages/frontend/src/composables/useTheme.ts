import { ref, watch, onMounted } from 'vue';

type Theme = 'light' | 'dark' | 'system';

const theme = ref<Theme>('system');
const resolvedTheme = ref<'light' | 'dark'>('light');

const getSystemTheme = (): 'light' | 'dark' => {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const updateResolvedTheme = () => {
    resolvedTheme.value = theme.value === 'system' ? getSystemTheme() : theme.value;
    document.documentElement.setAttribute('data-theme', resolvedTheme.value);
};

export function useTheme() {
    onMounted(() => {
        // Load saved preference
        const saved = localStorage.getItem('websync-theme') as Theme | null;
        if (saved) {
            theme.value = saved;
        }
        updateResolvedTheme();

        // Listen for system theme changes
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        mediaQuery.addEventListener('change', () => {
            if (theme.value === 'system') {
                updateResolvedTheme();
            }
        });
    });

    watch(theme, (newTheme) => {
        localStorage.setItem('websync-theme', newTheme);
        updateResolvedTheme();
    });

    const setTheme = (newTheme: Theme) => {
        theme.value = newTheme;
    };

    const toggleTheme = () => {
        if (theme.value === 'system') {
            theme.value = resolvedTheme.value === 'dark' ? 'light' : 'dark';
        } else {
            theme.value = theme.value === 'dark' ? 'light' : 'dark';
        }
    };

    return {
        theme,
        resolvedTheme,
        setTheme,
        toggleTheme
    };
}
