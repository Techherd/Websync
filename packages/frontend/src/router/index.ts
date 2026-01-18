import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/login',
            name: 'Login',
            component: () => import('../views/Login.vue'),
            meta: { requiresAuth: false, title: 'Sign In' }
        },
        {
            path: '/',
            name: 'Dashboard',
            component: () => import('../views/Dashboard.vue'),
            meta: { requiresAuth: true, title: 'Dashboard' }
        },
        {
            path: '/jobs',
            name: 'Jobs',
            component: () => import('../views/Jobs.vue'),
            meta: { requiresAuth: true, title: 'Job History' }
        },
        {
            path: '/settings',
            name: 'Settings',
            component: () => import('../views/Settings.vue'),
            meta: { requiresAuth: true, title: 'Settings' }
        }
    ]
});

// Auth guard
router.beforeEach(async (to, _from, next) => {
    const token = localStorage.getItem('websync-token');
    const requiresAuth = to.meta.requiresAuth !== false;

    if (requiresAuth && !token) {
        next('/login');
    } else if (to.path === '/login' && token) {
        // Verify token is still valid before redirecting away from login
        try {
            const response = await fetch('/auth/status', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await response.json();
            if (data.authenticated) {
                next('/');
            } else {
                // Token is invalid, clear it and stay on login
                localStorage.removeItem('websync-token');
                next();
            }
        } catch {
            // Can't verify, stay on login
            localStorage.removeItem('websync-token');
            next();
        }
    } else {
        next();
    }
});

export default router;
