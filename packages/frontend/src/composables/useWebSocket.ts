import { ref, onMounted, onUnmounted } from 'vue';

// In production, auto-detect WebSocket URL from current page location
// In development, use localhost:3000
const getWsBase = () => {
    if (import.meta.env.VITE_WS_URL) {
        return import.meta.env.VITE_WS_URL;
    }
    if (import.meta.env.PROD) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}`;
    }
    return 'ws://localhost:3000';
};

const WS_BASE = getWsBase();

export interface SiteHealthPayload {
    status: 'up' | 'degraded' | 'down' | 'unknown';
    httpStatus: number | null;
    responseMs: number | null;
    sslExpiresAt: string | null;
    error: string | null;
    lastCheckedAt: string | null;
}

export interface SiteScanPayload {
    id: string;
    status: 'clean' | 'warning' | 'compromised' | 'error' | 'unknown';
    coreStatus: string | null;
    pluginStatus: string | null;
    findingsCount: number;
    critical: number;
    createdAt: string;
}

export interface JobUpdate {
    type: 'connected' | 'pong' | 'job:started' | 'job:progress' | 'job:completed' | 'job:failed' | 'site:health' | 'site:scan';
    job?: any;
    jobId?: string;
    progress?: number;
    message?: string;
    error?: string;
    siteId?: string;
    health?: SiteHealthPayload;
    scan?: SiteScanPayload;
}

type JobUpdateHandler = (update: JobUpdate) => void;

// Singleton WebSocket instance
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
const handlers: Set<JobUpdateHandler> = new Set();
const isConnected = ref(false);

const connect = () => {
    if (socket?.readyState === WebSocket.OPEN) return;

    socket = new WebSocket(`${WS_BASE}/ws`);

    socket.onopen = () => {
        console.log('WebSocket connected');
        isConnected.value = true;
        
        // Start ping interval
        pingInterval = setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    };

    socket.onmessage = (event) => {
        try {
            const update: JobUpdate = JSON.parse(event.data);
            handlers.forEach(handler => handler(update));
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
        }
    };

    socket.onclose = () => {
        console.log('WebSocket disconnected');
        isConnected.value = false;
        
        if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
        }

        // Reconnect after delay
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                connect();
            }, 3000);
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
};

const disconnect = () => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (socket) {
        socket.close();
        socket = null;
    }
    isConnected.value = false;
};

export function useWebSocket() {
    const addHandler = (handler: JobUpdateHandler) => {
        handlers.add(handler);
    };

    const removeHandler = (handler: JobUpdateHandler) => {
        handlers.delete(handler);
    };

    onMounted(() => {
        connect();
    });

    return {
        isConnected,
        connect,
        disconnect,
        addHandler,
        removeHandler
    };
}

// Hook for subscribing to job updates in components
export function useJobUpdates(handler: JobUpdateHandler) {
    onMounted(() => {
        handlers.add(handler);
        connect();
    });

    onUnmounted(() => {
        handlers.delete(handler);
    });

    return { isConnected };
}
