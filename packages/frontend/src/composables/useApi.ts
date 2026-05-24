import { ref } from 'vue';

// In production (served from same origin), use empty string for relative URLs
// In development, use localhost:3000
const API_BASE = import.meta.env.VITE_API_URL || 
    (import.meta.env.PROD ? '' : 'http://localhost:3000');

// Auth token management
const token = ref<string | null>(localStorage.getItem('websync-token'));

export function useApi() {
    const isAuthenticated = () => !!token.value;

    const setToken = (newToken: string | null) => {
        token.value = newToken;
        if (newToken) {
            localStorage.setItem('websync-token', newToken);
        } else {
            localStorage.removeItem('websync-token');
        }
    };

    const getToken = () => token.value;

    const request = async <T>(
        endpoint: string,
        methodOrOptions?: string | RequestInit,
        body?: any
    ): Promise<T> => {
        // Support both calling conventions:
        // request('/endpoint', { method: 'POST', body: JSON.stringify(data) })
        // request('/endpoint', 'POST', data)
        let options: RequestInit = {};
        
        if (typeof methodOrOptions === 'string') {
            options = {
                method: methodOrOptions,
                body: body ? JSON.stringify(body) : undefined
            };
        } else if (methodOrOptions) {
            options = methodOrOptions;
        }
        
        const headers: Record<string, string> = {
            ...(options.headers as Record<string, string> || {})
        };
        // Only declare JSON content-type when there is actually a body — otherwise
        // Fastify tries to parse an empty body as JSON and rejects with 400.
        if (options.body != null) {
            headers['Content-Type'] = 'application/json';
        }

        if (token.value) {
            headers['Authorization'] = `Bearer ${token.value}`;
        }

        const response = await fetch(`${API_BASE}${endpoint}`, {
            ...options,
            headers
        });

        if (response.status === 401) {
            setToken(null);
            // Only redirect if not already on login page to prevent loops
            if (!window.location.pathname.includes('/login')) {
                window.location.href = '/login';
            }
            throw new Error('Unauthorized');
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
            const errorMessage = errorData.detail || errorData.error || errorData.message || 'Request failed';
            throw new Error(errorMessage);
        }

        return response.json();
    };

    // Auth
    const login = async (email: string, password: string) => {
        const data = await request<{ token: string; user?: { id: string; email: string; name: string; role: string } }>(
            '/auth/login',
            { method: 'POST', body: JSON.stringify({ email, password }) }
        );
        setToken(data.token);
        return data;
    };

    const logout = async () => {
        try {
            await request('/auth/logout', { method: 'POST' });
        } finally {
            setToken(null);
        }
    };

    const checkAuth = async () => {
        if (!token.value) return false;
        try {
            const data = await request<{ authenticated: boolean }>('/auth/status');
            return data.authenticated;
        } catch {
            return false;
        }
    };

    // Sites
    const getSites = () => request<any[]>('/sites');
    
    const getSite = (id: string) => request<any>(`/sites/${id}`);
    
    const createSite = (data: any) => request<any>('/sites', {
        method: 'POST',
        body: JSON.stringify(data)
    });
    
    const updateSite = (id: string, data: any) => request<any>(`/sites/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data)
    });
    
    const deleteSite = (id: string) => request<{ success: boolean }>(`/sites/${id}`, {
        method: 'DELETE'
    });
    
    const syncSite = (id: string, options?: { direction?: 'push' | 'pull' | 'bidirectional'; force?: boolean }) => 
        request<any>(`/sites/${id}/sync`, {
            method: 'POST',
            body: options ? JSON.stringify(options) : undefined
        });

    // Jobs
    const getJobs = (params?: { siteId?: string; status?: string; limit?: number; offset?: number }) => {
        const query = new URLSearchParams();
        if (params?.siteId) query.set('siteId', params.siteId);
        if (params?.status) query.set('status', params.status);
        if (params?.limit) query.set('limit', String(params.limit));
        if (params?.offset) query.set('offset', String(params.offset));
        const queryString = query.toString();
        return request<{ jobs: any[]; total: number }>(`/jobs${queryString ? `?${queryString}` : ''}`);
    };
    
    const getJob = (id: string) => request<any>(`/jobs/${id}`);
    
    const getRunningJobsCount = () => request<{ count: number }>('/jobs/running/count');

    // Settings
    const getSettings = () => request<any>('/settings');
    
    const updateSettings = (data: any) => request<any>('/settings', {
        method: 'PUT',
        body: JSON.stringify(data)
    });
    
    const getSettingsStatus = () => request<{ configured: boolean }>('/settings/status');

    // Received Sites (read-only synced sites from remote)
    const getReceivedSites = () => request<any[]>('/received-sites');

    const deleteReceivedSite = (id: string) => request<{ success: boolean }>(`/received-sites/${id}`, {
        method: 'DELETE'
    });

    // Users
    const getMe = () => request<{
        id: string; email: string; name: string; role: string;
        createdAt: string; lastLoginAt: string | null;
    }>('/users/me');
    const getUsers = () => request<any[]>('/users');
    const createUser = (data: { email: string; name: string; password: string; role?: string }) =>
        request<any>('/users', { method: 'POST', body: JSON.stringify(data) });
    const updateUser = (id: string, data: { name?: string; role?: string; password?: string }) =>
        request<any>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
    const deleteUser = (id: string) =>
        request<{ success: boolean }>(`/users/${id}`, { method: 'DELETE' });
    const changeOwnPassword = (currentPassword: string, newPassword: string) =>
        request<{ success: boolean }>('/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({ currentPassword, newPassword })
        });

    // Audit
    const getAudit = (params?: { siteId?: string; userId?: string; limit?: number; offset?: number }) => {
        const query = new URLSearchParams();
        if (params?.siteId) query.set('siteId', params.siteId);
        if (params?.userId) query.set('userId', params.userId);
        if (params?.limit) query.set('limit', String(params.limit));
        if (params?.offset) query.set('offset', String(params.offset));
        const qs = query.toString();
        return request<{ total: number; events: any[] }>(`/audit${qs ? `?${qs}` : ''}`);
    };

    return {
        // Auth
        isAuthenticated,
        setToken,
        getToken,
        login,
        logout,
        checkAuth,
        
        // Sites
        getSites,
        getSite,
        createSite,
        updateSite,
        deleteSite,
        syncSite,
        
        // Jobs
        getJobs,
        getJob,
        getRunningJobsCount,
        
        // Settings
        getSettings,
        updateSettings,
        getSettingsStatus,
        
        // Received Sites
        getReceivedSites,
        deleteReceivedSite,

        // Users
        getMe,
        getUsers,
        createUser,
        updateUser,
        deleteUser,
        changeOwnPassword,

        // Audit
        getAudit,

        // Generic
        request
    };
}
