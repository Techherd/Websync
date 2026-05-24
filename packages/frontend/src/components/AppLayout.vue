<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useApi } from '../composables/useApi';
import { useWebSocket } from '../composables/useWebSocket';
import { useAppSettings } from '../composables/useAppSettings';
import ThemeToggle from './ThemeToggle.vue';
import ToastContainer from './ToastContainer.vue';

const route = useRoute();
const router = useRouter();
const { logout } = useApi();
const { isConnected } = useWebSocket();
const { hideBranding, loadSettings } = useAppSettings();

const sidebarCollapsed = ref(false);

onMounted(() => {
    loadSettings();
});

const navItems = [
    { path: '/', label: 'Dashboard', icon: 'dashboard' },
    { path: '/jobs', label: 'Jobs', icon: 'history' },
    { path: '/activity', label: 'Activity', icon: 'activity' },
    { path: '/users', label: 'Users', icon: 'users' },
    { path: '/settings', label: 'Settings', icon: 'settings' }
];

const isActive = (path: string) => route.path === path;

const handleLogout = async () => {
    await logout();
    router.push('/login');
};

const toggleSidebar = () => {
    sidebarCollapsed.value = !sidebarCollapsed.value;
};
</script>

<template>
    <div class="app-layout" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
        <!-- Sidebar -->
        <aside class="sidebar">
            <div class="sidebar-header">
                <div class="logo">
                    <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                    </svg>
                    <span class="logo-text" v-if="!sidebarCollapsed">WebSync</span>
                </div>
                <button class="sidebar-toggle" @click="toggleSidebar" aria-label="Toggle sidebar">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path v-if="sidebarCollapsed" d="M9 18l6-6-6-6"/>
                        <path v-else d="M15 18l-6-6 6-6"/>
                    </svg>
                </button>
            </div>

            <nav class="sidebar-nav">
                <router-link
                    v-for="item in navItems"
                    :key="item.path"
                    :to="item.path"
                    class="nav-item"
                    :class="{ active: isActive(item.path) }"
                >
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <template v-if="item.icon === 'dashboard'">
                            <rect x="3" y="3" width="7" height="7" rx="1"/>
                            <rect x="14" y="3" width="7" height="7" rx="1"/>
                            <rect x="14" y="14" width="7" height="7" rx="1"/>
                            <rect x="3" y="14" width="7" height="7" rx="1"/>
                        </template>
                        <template v-else-if="item.icon === 'history'">
                            <circle cx="12" cy="12" r="10"/>
                            <polyline points="12 6 12 12 16 14"/>
                        </template>
                        <template v-else-if="item.icon === 'activity'">
                            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                        </template>
                        <template v-else-if="item.icon === 'users'">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                        </template>
                        <template v-else-if="item.icon === 'settings'">
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                        </template>
                    </svg>
                    <span class="nav-label" v-if="!sidebarCollapsed">{{ item.label }}</span>
                </router-link>
            </nav>

            <div class="sidebar-footer">
                <div class="connection-status" :class="{ connected: isConnected }">
                    <span class="status-dot"></span>
                    <span class="status-text" v-if="!sidebarCollapsed">
                        {{ isConnected ? 'Connected' : 'Disconnected' }}
                    </span>
                </div>
            </div>
        </aside>

        <!-- Main Content -->
        <div class="main-wrapper">
            <header class="app-header">
                <div class="header-left">
                    <h1 class="page-title">{{ route.meta.title || 'Dashboard' }}</h1>
                </div>
                <div class="header-right">
                    <ThemeToggle />
                    <button class="logout-button" @click="handleLogout">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                            <polyline points="16 17 21 12 16 7"/>
                            <line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                        <span>Logout</span>
                    </button>
                </div>
            </header>

            <main class="main-content">
                <slot></slot>
            </main>

            <footer v-if="!hideBranding" class="app-footer">
                <span>Powered by</span>
                <a href="https://techherd.net" target="_blank" rel="noopener noreferrer" class="techherd-link">
                    Techherd
                </a>
            </footer>
        </div>

        <ToastContainer />
    </div>
</template>

<style scoped>
.app-layout {
    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    min-height: 100vh;
    transition: grid-template-columns var(--transition-normal);
}

.app-layout.sidebar-collapsed {
    grid-template-columns: 72px 1fr;
}

/* Sidebar */
.sidebar {
    background: var(--bg-primary);
    border-right: 1px solid var(--border-primary);
    display: flex;
    flex-direction: column;
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: hidden;
    transition: width var(--transition-normal);
}

.sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-primary);
    min-height: var(--header-height);
}

.logo {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--color-primary);
}

.logo-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
}

.logo-text {
    font-size: var(--text-xl);
    font-weight: var(--font-bold);
    white-space: nowrap;
}

.sidebar-toggle {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
    flex-shrink: 0;
}

.sidebar-toggle:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.sidebar-toggle svg {
    width: 16px;
    height: 16px;
}

.sidebar-nav {
    flex: 1;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
}

.nav-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    color: var(--text-secondary);
    text-decoration: none;
    transition: all var(--transition-fast);
    white-space: nowrap;
}

.nav-item:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.nav-item.active {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
}

.nav-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
}

.nav-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
}

.sidebar-footer {
    padding: var(--space-4);
    border-top: 1px solid var(--border-primary);
}

.connection-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
}

.connection-status.connected {
    background: var(--color-success-subtle);
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-danger);
    flex-shrink: 0;
}

.connection-status.connected .status-dot {
    background: var(--color-success);
}

.status-text {
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
}

/* Main Content */
.main-wrapper {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--bg-secondary);
}

.app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--space-8);
    height: var(--header-height);
    background: var(--bg-primary);
    border-bottom: 1px solid var(--border-primary);
    position: sticky;
    top: 0;
    z-index: 10;
}

.header-left {
    display: flex;
    align-items: center;
}

.page-title {
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
}

.header-right {
    display: flex;
    align-items: center;
    gap: var(--space-4);
}

.logout-button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    transition: all var(--transition-fast);
}

.logout-button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.logout-button svg {
    width: 18px;
    height: 18px;
}

.main-content {
    flex: 1;
    padding: var(--space-8);
    animation: fadeIn var(--transition-normal);
}

.app-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1);
    padding: var(--space-4) var(--space-8);
    font-size: var(--text-xs);
    color: var(--text-muted);
    border-top: 1px solid var(--border-primary);
    background: var(--bg-primary);
}

.techherd-link {
    color: var(--color-primary);
    text-decoration: none;
    font-weight: var(--font-medium);
    transition: color var(--transition-fast);
}

.techherd-link:hover {
    color: var(--color-primary-hover);
    text-decoration: underline;
}

/* Collapsed state adjustments */
.sidebar-collapsed .logo-text,
.sidebar-collapsed .nav-label,
.sidebar-collapsed .status-text {
    display: none;
}

.sidebar-collapsed .sidebar-header {
    justify-content: center;
    padding: var(--space-4) var(--space-2);
    flex-direction: column;
    gap: var(--space-3);
}

.sidebar-collapsed .logo {
    justify-content: center;
}

.sidebar-collapsed .sidebar-toggle {
    width: 36px;
    height: 36px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-lg);
}

.sidebar-collapsed .sidebar-toggle svg {
    width: 20px;
    height: 20px;
}

.sidebar-collapsed .nav-item {
    justify-content: center;
    padding: var(--space-3);
}

.sidebar-collapsed .connection-status {
    justify-content: center;
    padding: var(--space-2);
}
</style>
