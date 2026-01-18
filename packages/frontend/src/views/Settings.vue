<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useApi } from '../composables/useApi';
import { useToast } from '../composables/useToast';
import { useAppSettings } from '../composables/useAppSettings';

interface Settings {
    serverName: string;
    serverRole: 'primary' | 'secondary' | 'peer';
    remoteHost: string;
    remotePort: number;
    sshKeyPath: string;
    remoteApiUrl: string;
    remoteApiToken: string;
    syncDirection: 'push' | 'pull' | 'bidirectional';
    syncOnlyWhenHealthy: boolean;
    healthCheckInterval: number;
    remoteHealthy: boolean;
    lastHealthCheck: string | null;
    hideBranding: boolean;
}

interface HealthStatus {
    healthy: boolean;
    serverName?: string;
    serverRole?: string;
    error?: string;
    lastCheck: string | null;
}

const { request } = useApi();
const { success, error } = useToast();
const { setHideBranding } = useAppSettings();

const loading = ref(true);
const saving = ref(false);
const testingSsh = ref(false);
const checkingHealth = ref(false);
const settings = ref<Settings>({
    serverName: 'Primary',
    serverRole: 'primary',
    remoteHost: '',
    remotePort: 22,
    sshKeyPath: '',
    remoteApiUrl: '',
    remoteApiToken: '',
    syncDirection: 'push',
    syncOnlyWhenHealthy: true,
    healthCheckInterval: 30,
    remoteHealthy: false,
    lastHealthCheck: null,
    hideBranding: false
});
const configured = ref(false);
const remoteHealth = ref<HealthStatus>({
    healthy: false,
    error: undefined,
    lastCheck: null
});

let healthPollInterval: number | null = null;

const syncDirectionDescription = computed(() => {
    const descriptions: Record<string, string> = {
        'push': 'Files and database are synced FROM this server TO the remote server.',
        'pull': 'Files and database are synced FROM the remote server TO this server.',
        'bidirectional': 'Files are synced both ways. Database is push-only for safety.'
    };
    return descriptions[settings.value.syncDirection] || '';
});

const loadSettings = async () => {
    loading.value = true;
    try {
        const data = await request<Settings>('/settings');
        if (data) {
            settings.value = {
                serverName: data.serverName || 'Primary',
                serverRole: data.serverRole || 'primary',
                remoteHost: data.remoteHost || '',
                remotePort: data.remotePort || 22,
                sshKeyPath: data.sshKeyPath || '',
                remoteApiUrl: data.remoteApiUrl || '',
                remoteApiToken: data.remoteApiToken || '',
                syncDirection: data.syncDirection || 'push',
                syncOnlyWhenHealthy: data.syncOnlyWhenHealthy ?? true,
                healthCheckInterval: data.healthCheckInterval || 30,
                remoteHealthy: data.remoteHealthy || false,
                lastHealthCheck: data.lastHealthCheck || null,
                hideBranding: data.hideBranding ?? false
            };
            configured.value = !!data.remoteHost;
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
    } finally {
        loading.value = false;
    }
};

const checkRemoteHealth = async () => {
    if (!settings.value.remoteApiUrl) return;
    
    checkingHealth.value = true;
    try {
        const data = await request<HealthStatus>('/settings/remote-health');
        if (data) {
            remoteHealth.value = data;
            settings.value.remoteHealthy = data.healthy;
        }
    } catch (e) {
        console.error('Failed to check health:', e);
    } finally {
        checkingHealth.value = false;
    }
};

const testSshConnection = async () => {
    testingSsh.value = true;
    try {
        const result = await request<{ success: boolean; message?: string; error?: string }>('/settings/test-ssh');
        if (result?.success) {
            success('SSH Test', result.message || 'SSH connection successful');
        } else {
            error('SSH Test Failed', result?.error || 'Could not connect via SSH');
        }
    } catch (e: any) {
        error('SSH Test Failed', e.message || 'Could not connect via SSH');
    } finally {
        testingSsh.value = false;
    }
};

const generateToken = async () => {
    try {
        const result = await request<{ token: string }>('/settings/generate-token', 'POST');
        if (result?.token) {
            settings.value.remoteApiToken = result.token;
            success('Token Generated', 'New API token generated. Make sure to update the remote server.');
        }
    } catch (e: any) {
        error('Token Generation Failed', e.message);
    }
};

const copyToken = () => {
    if (settings.value.remoteApiToken) {
        navigator.clipboard.writeText(settings.value.remoteApiToken);
        success('Copied', 'API token copied to clipboard');
    }
};

const handleSubmit = async () => {
    saving.value = true;
    try {
        await request('/settings', 'PUT', {
            serverName: settings.value.serverName,
            serverRole: settings.value.serverRole,
            remoteHost: settings.value.remoteHost,
            remotePort: settings.value.remotePort,
            sshKeyPath: settings.value.sshKeyPath || undefined,
            remoteApiUrl: settings.value.remoteApiUrl || undefined,
            remoteApiToken: settings.value.remoteApiToken || undefined,
            syncDirection: settings.value.syncDirection,
            syncOnlyWhenHealthy: settings.value.syncOnlyWhenHealthy,
            healthCheckInterval: settings.value.healthCheckInterval,
            hideBranding: settings.value.hideBranding
        });
        configured.value = true;
        success('Settings Saved', 'Configuration updated successfully');
        
        // Update shared app settings (for reactive UI updates like branding)
        setHideBranding(settings.value.hideBranding);
        
        // Trigger health check if API URL is configured
        if (settings.value.remoteApiUrl) {
            checkRemoteHealth();
        }
    } catch (e: any) {
        error('Save Failed', e.message || 'Failed to save settings');
    } finally {
        saving.value = false;
    }
};

const startHealthPoll = () => {
    if (healthPollInterval) clearInterval(healthPollInterval);
    
    if (settings.value.remoteApiUrl) {
        checkRemoteHealth();
        healthPollInterval = window.setInterval(() => {
            checkRemoteHealth();
        }, settings.value.healthCheckInterval * 1000);
    }
};

onMounted(async () => {
    await loadSettings();
    startHealthPoll();
});

onUnmounted(() => {
    if (healthPollInterval) {
        clearInterval(healthPollInterval);
    }
});
</script>

<template>
    <div class="settings-page">
        <div class="settings-header">
            <div class="header-info">
                <h2 class="section-title">Settings</h2>
                <p class="section-subtitle">Configure bidirectional sync between servers</p>
            </div>
            <div class="header-status-group">
                <div v-if="settings.remoteApiUrl" :class="['health-status', { 'healthy': remoteHealth.healthy, 'unhealthy': !remoteHealth.healthy }]">
                    <div class="pulse-dot"></div>
                    <span>{{ remoteHealth.healthy ? 'Remote Online' : 'Remote Offline' }}</span>
                </div>
                <div v-if="configured" class="config-status configured">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    <span>Configured</span>
                </div>
                <div v-else class="config-status not-configured">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="16" x2="12" y2="12"/>
                        <line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    <span>Not Configured</span>
                </div>
            </div>
        </div>

        <div v-if="loading" class="loading-state">
            <div class="spinner"></div>
            <span>Loading settings...</span>
        </div>

        <form v-else @submit.prevent="handleSubmit" class="settings-form">
            <!-- Server Identity Section -->
            <div class="form-section">
                <div class="section-header">
                    <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"/>
                        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
                    </svg>
                    <div>
                        <h3>This Server</h3>
                        <p>Identity and role of this WebSync instance</p>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group">
                        <label class="form-label" for="serverName">Server Name</label>
                        <input 
                            id="serverName"
                            v-model="settings.serverName"
                            type="text"
                            class="form-input"
                            placeholder="Primary Server"
                        />
                        <p class="form-hint">A friendly name for this server</p>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="serverRole">Server Role</label>
                        <select id="serverRole" v-model="settings.serverRole" class="form-input">
                            <option value="primary">Primary (main server)</option>
                            <option value="secondary">Secondary (backup server)</option>
                            <option value="peer">Peer (equal servers)</option>
                        </select>
                        <p class="form-hint">Defines this server's role in the sync</p>
                    </div>
                </div>
            </div>

            <!-- SSH Connection Section -->
            <div class="form-section">
                <div class="section-header">
                    <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
                        <line x1="6" y1="6" x2="6.01" y2="6"/>
                        <line x1="6" y1="18" x2="6.01" y2="18"/>
                    </svg>
                    <div>
                        <h3>Remote Server (SSH)</h3>
                        <p>SSH connection for file and database sync</p>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group full-width">
                        <label class="form-label" for="remoteHost">
                            Remote Host
                        </label>
                        <div class="input-with-button">
                            <input 
                                id="remoteHost"
                                v-model="settings.remoteHost"
                                type="text"
                                class="form-input"
                                placeholder="user@192.168.1.100"
                            />
                            <button 
                                type="button" 
                                class="btn btn-secondary btn-sm"
                                @click="testSshConnection"
                                :disabled="testingSsh || !settings.remoteHost"
                            >
                                <span v-if="testingSsh" class="spinner-sm"></span>
                                <span v-else>Test SSH</span>
                            </button>
                        </div>
                        <p class="form-hint">SSH user and host (e.g., root@192.168.1.100)</p>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="remotePort">SSH Port</label>
                        <input 
                            id="remotePort"
                            v-model.number="settings.remotePort"
                            type="number"
                            class="form-input"
                            min="1"
                            max="65535"
                        />
                        <p class="form-hint">Default: 22</p>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="sshKeyPath">SSH Key Path</label>
                        <input 
                            id="sshKeyPath"
                            v-model="settings.sshKeyPath"
                            type="text"
                            class="form-input"
                            placeholder="/root/.ssh/id_rsa"
                        />
                        <p class="form-hint">Leave blank for default SSH key</p>
                    </div>
                </div>
            </div>

            <!-- Remote API Section -->
            <div class="form-section">
                <div class="section-header">
                    <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                        <polyline points="16 5 21 5 21 10"/>
                        <line x1="3" y1="12" x2="9" y2="12"/>
                    </svg>
                    <div>
                        <h3>Remote WebSync API</h3>
                        <p>Enable health checks and bidirectional coordination</p>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group full-width">
                        <label class="form-label" for="remoteApiUrl">Remote API URL</label>
                        <div class="input-with-button">
                            <input 
                                id="remoteApiUrl"
                                v-model="settings.remoteApiUrl"
                                type="url"
                                class="form-input"
                                placeholder="http://192.168.1.100:3000"
                            />
                            <button 
                                type="button" 
                                class="btn btn-secondary btn-sm"
                                @click="checkRemoteHealth"
                                :disabled="checkingHealth || !settings.remoteApiUrl"
                            >
                                <span v-if="checkingHealth" class="spinner-sm"></span>
                                <span v-else>Check Health</span>
                            </button>
                        </div>
                        <p class="form-hint">WebSync API URL on the remote server (enables health checks)</p>
                    </div>

                    <div class="form-group full-width">
                        <label class="form-label" for="remoteApiToken">Shared API Token</label>
                        <div class="input-with-button">
                            <input 
                                id="remoteApiToken"
                                v-model="settings.remoteApiToken"
                                type="text"
                                class="form-input token-input"
                                placeholder="Paste token from other server or generate new"
                            />
                            <button type="button" class="btn btn-secondary btn-sm" @click="copyToken" :disabled="!settings.remoteApiToken">
                                Copy
                            </button>
                            <button type="button" class="btn btn-secondary btn-sm" @click="generateToken">
                                Generate
                            </button>
                        </div>
                        <p class="form-hint">This token must match on both servers for secure communication</p>
                    </div>
                </div>

                <!-- Health Status Display -->
                <div v-if="settings.remoteApiUrl" class="health-card" :class="{ 'healthy': remoteHealth.healthy, 'unhealthy': !remoteHealth.healthy }">
                    <div class="health-indicator">
                        <div class="pulse-dot"></div>
                    </div>
                    <div class="health-info">
                        <div class="health-title">
                            {{ remoteHealth.healthy ? `Connected to ${remoteHealth.serverName || 'Remote'}` : 'Remote Unavailable' }}
                        </div>
                        <div class="health-detail">
                            <span v-if="remoteHealth.healthy">Role: {{ remoteHealth.serverRole }}</span>
                            <span v-else>{{ remoteHealth.error || 'Connection failed' }}</span>
                        </div>
                        <div v-if="remoteHealth.lastCheck" class="health-time">
                            Last check: {{ new Date(remoteHealth.lastCheck).toLocaleTimeString() }}
                        </div>
                    </div>
                </div>
            </div>

            <!-- Sync Configuration Section -->
            <div class="form-section">
                <div class="section-header">
                    <svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"/>
                        <polyline points="1 20 1 14 7 14"/>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                    </svg>
                    <div>
                        <h3>Sync Configuration</h3>
                        <p>Control how data flows between servers</p>
                    </div>
                </div>

                <div class="form-grid">
                    <div class="form-group full-width">
                        <label class="form-label" for="syncDirection">Sync Direction</label>
                        <div class="direction-selector">
                            <label class="direction-option" :class="{ active: settings.syncDirection === 'push' }">
                                <input type="radio" v-model="settings.syncDirection" value="push" />
                                <div class="direction-visual">
                                    <div class="server-box">This</div>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <line x1="5" y1="12" x2="19" y2="12"/>
                                        <polyline points="12 5 19 12 12 19"/>
                                    </svg>
                                    <div class="server-box">Remote</div>
                                </div>
                                <span class="direction-label">Push</span>
                            </label>
                            <label class="direction-option" :class="{ active: settings.syncDirection === 'pull' }">
                                <input type="radio" v-model="settings.syncDirection" value="pull" />
                                <div class="direction-visual">
                                    <div class="server-box">This</div>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <line x1="19" y1="12" x2="5" y2="12"/>
                                        <polyline points="12 5 5 12 12 19"/>
                                    </svg>
                                    <div class="server-box">Remote</div>
                                </div>
                                <span class="direction-label">Pull</span>
                            </label>
                            <label class="direction-option" :class="{ active: settings.syncDirection === 'bidirectional' }">
                                <input type="radio" v-model="settings.syncDirection" value="bidirectional" />
                                <div class="direction-visual">
                                    <div class="server-box">This</div>
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="17 1 21 5 17 9"/>
                                        <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                                        <polyline points="7 23 3 19 7 15"/>
                                        <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                                    </svg>
                                    <div class="server-box">Remote</div>
                                </div>
                                <span class="direction-label">Bidirectional</span>
                            </label>
                        </div>
                        <p class="form-hint direction-hint">{{ syncDirectionDescription }}</p>
                    </div>

                    <div class="form-group">
                        <label class="form-label" for="healthCheckInterval">Health Check Interval</label>
                        <div class="input-with-suffix">
                            <input 
                                id="healthCheckInterval"
                                v-model.number="settings.healthCheckInterval"
                                type="number"
                                class="form-input"
                                min="10"
                                max="300"
                            />
                            <span class="input-suffix">seconds</span>
                        </div>
                        <p class="form-hint">How often to check remote server health (10-300s)</p>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Safety Options</label>
                        <label class="toggle-option">
                            <input type="checkbox" v-model="settings.syncOnlyWhenHealthy" />
                            <span class="toggle-switch"></span>
                            <span class="toggle-label">Only sync when remote is healthy</span>
                        </label>
                        <p class="form-hint">Prevents sync attempts when remote is unreachable</p>
                    </div>
                </div>
            </div>

            <!-- Info Box -->
            <div class="form-section info-section">
                <div class="info-box">
                    <svg class="info-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="16" x2="12" y2="12"/>
                        <line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    <div class="info-content">
                        <h4>Bidirectional Sync Setup</h4>
                        <p>
                            For bidirectional sync, WebSync should be running on both servers with matching API tokens.
                            Configure the remote server as "Secondary" and set its sync direction to match.
                            Health checks ensure sync only happens when both servers are available.
                        </p>
                    </div>
                </div>
            </div>

            <!-- UI Preferences -->
            <div class="form-section">
                <div class="section-header">
                    <h3 class="section-title">UI Preferences</h3>
                </div>
                <div class="section-body">
                    <div class="form-group">
                        <label class="toggle-option">
                            <input type="checkbox" v-model="settings.hideBranding" />
                            <span class="toggle-switch"></span>
                            <span class="toggle-label">Hide "Powered by Techherd" footer</span>
                        </label>
                    </div>
                </div>
            </div>

            <div class="form-actions">
                <button type="submit" class="btn btn-primary" :disabled="saving">
                    <span v-if="saving" class="spinner-sm"></span>
                    <span>{{ saving ? 'Saving...' : 'Save Settings' }}</span>
                </button>
            </div>
        </form>
    </div>
</template>

<style scoped>
.settings-page {
    max-width: 900px;
    animation: fadeIn var(--transition-normal);
}

.settings-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: var(--space-6);
    gap: var(--space-4);
    flex-wrap: wrap;
}

.header-status-group {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
}

.section-title {
    font-size: var(--text-xl);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-1);
}

.section-subtitle {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.health-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
}

.health-status.healthy {
    background: var(--color-success-subtle);
    color: var(--color-success);
}

.health-status.unhealthy {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 2s infinite;
}

@keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
}

.config-status {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
}

.config-status svg {
    width: 18px;
    height: 18px;
}

.config-status.configured {
    background: var(--color-success-subtle);
    color: var(--color-success);
}

.config-status.not-configured {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
}

.loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-16);
    gap: var(--space-4);
    color: var(--text-muted);
    background: var(--bg-primary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--border-primary);
}

.spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-primary);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

.settings-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
}

.form-section {
    background: var(--bg-primary);
    border-radius: var(--radius-xl);
    border: 1px solid var(--border-primary);
    padding: var(--space-6);
}

.section-header {
    display: flex;
    gap: var(--space-4);
    margin-bottom: var(--space-6);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--border-primary);
}

.section-icon {
    width: 24px;
    height: 24px;
    color: var(--color-primary);
    flex-shrink: 0;
    margin-top: var(--space-1);
}

.section-header h3 {
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-1);
}

.section-header p {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.form-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-5);
}

.form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.form-group.full-width {
    grid-column: span 2;
}

.form-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
}

.required {
    color: var(--color-danger);
}

.form-input {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    font-size: var(--text-base);
    color: var(--text-primary);
    transition: all var(--transition-fast);
}

.form-input::placeholder {
    color: var(--text-muted);
}

.form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
}

.form-input:read-only {
    opacity: 0.8;
}

.token-input {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
}

.form-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
}

.input-with-button {
    display: flex;
    gap: var(--space-2);
}

.input-with-button .form-input {
    flex: 1;
}

.input-with-suffix {
    display: flex;
    align-items: center;
}

.input-with-suffix .form-input {
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
    flex: 1;
}

.input-suffix {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-tertiary);
    border: 1px solid var(--border-primary);
    border-left: none;
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
}

/* Direction Selector */
.direction-selector {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-4);
}

.direction-option {
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-5);
    background: var(--bg-secondary);
    border: 2px solid var(--border-primary);
    border-radius: var(--radius-xl);
    transition: all var(--transition-fast);
}

.direction-option input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
}

.direction-option.active {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
}

.direction-option:hover:not(.active) {
    border-color: var(--border-hover);
    background: var(--bg-tertiary);
}

.direction-visual {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.direction-visual svg {
    width: 24px;
    height: 24px;
    color: var(--color-primary);
}

.server-box {
    padding: var(--space-1) var(--space-2);
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
    color: var(--text-secondary);
}

.direction-label {
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    color: var(--text-primary);
}

.direction-hint {
    text-align: center;
    margin-top: var(--space-2);
}

/* Toggle */
.toggle-option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    cursor: pointer;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border-radius: var(--radius-lg);
}

.toggle-option input {
    position: absolute;
    opacity: 0;
}

.toggle-switch {
    width: 44px;
    height: 24px;
    background: var(--border-primary);
    border-radius: var(--radius-full);
    position: relative;
    transition: all var(--transition-fast);
    flex-shrink: 0;
}

.toggle-switch::after {
    content: '';
    position: absolute;
    width: 20px;
    height: 20px;
    background: white;
    border-radius: 50%;
    top: 2px;
    left: 2px;
    transition: all var(--transition-fast);
}

.toggle-option input:checked + .toggle-switch {
    background: var(--color-primary);
}

.toggle-option input:checked + .toggle-switch::after {
    left: 22px;
}

.toggle-label {
    font-size: var(--text-sm);
    color: var(--text-primary);
}

/* Health Card */
.health-card {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
    border-radius: var(--radius-lg);
    margin-top: var(--space-5);
}

.health-card.healthy {
    background: var(--color-success-subtle);
    border: 1px solid var(--color-success);
}

.health-card.unhealthy {
    background: var(--color-danger-subtle);
    border: 1px solid var(--color-danger);
}

.health-indicator {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.health-card.healthy .health-indicator {
    background: var(--color-success);
}

.health-card.unhealthy .health-indicator {
    background: var(--color-danger);
}

.health-indicator .pulse-dot {
    width: 16px;
    height: 16px;
    background: white;
}

.health-info {
    flex: 1;
}

.health-title {
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-1);
}

.health-detail {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-bottom: var(--space-1);
}

.health-time {
    font-size: var(--text-xs);
    color: var(--text-muted);
}

/* Info Box */
.info-section {
    padding: 0;
}

.info-box {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-5);
    background: var(--color-primary-subtle);
    border-radius: var(--radius-xl);
}

.info-icon {
    width: 24px;
    height: 24px;
    color: var(--color-primary);
    flex-shrink: 0;
}

.info-content h4 {
    font-size: var(--text-sm);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    margin-bottom: var(--space-1);
}

.info-content p {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-relaxed);
}

.form-actions {
    display: flex;
    justify-content: flex-end;
}

/* Buttons */
.btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-6);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    transition: all var(--transition-fast);
    border: none;
    cursor: pointer;
}

.btn-sm {
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-xs);
}

.btn-primary {
    background: var(--color-primary);
    color: var(--text-on-primary);
}

.btn-primary svg {
    color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
}

.btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border-primary);
}

.btn-secondary:hover:not(:disabled) {
    background: var(--bg-hover);
    border-color: var(--border-hover);
}

.btn:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.spinner-sm {
    width: 16px;
    height: 16px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 768px) {
    .form-grid {
        grid-template-columns: 1fr;
    }
    
    .form-group.full-width {
        grid-column: span 1;
    }
    
    .direction-selector {
        grid-template-columns: 1fr;
    }
    
    .input-with-button {
        flex-direction: column;
    }
    
    .settings-header {
        flex-direction: column;
    }
}
</style>
