<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useApi } from '../composables/useApi';
import { useJobUpdates } from '../composables/useWebSocket';

interface SiteRef {
    id: string;
    label: string;
    siteType?: string;
    siteUrl?: string | null;
}

interface Check {
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'fail';
    detail?: string;
    fix?: string;
}

interface Plan {
    oldUrl: string | null;
    newUrl: string;
    wordpress: boolean;
    replacements: number;
    cloudflare: { newHost: string; oldHost: string | null; service: string; zone: string; createDns: boolean } | null;
}

const props = defineProps<{ open: boolean; site: SiteRef | null }>();
const emit = defineEmits<{ close: []; changed: [siteId: string, newUrl: string] }>();

const { request } = useApi();

const step = ref<'form' | 'review' | 'progress'>('form');
const form = ref({ newUrl: '', cloudflare: false, keepOld: true, service: '' });
const cloudflareReady = ref(false);
const formError = ref('');
const preflight = ref<{ loading: boolean; ok: boolean; checks: Check[]; plan: Plan | null; error: string }>({
    loading: false, ok: false, checks: [], plan: null, error: ''
});
const run = ref<{ jobId: string | null; status: 'starting' | 'running' | 'done' | 'failed'; progress: number; steps: string[]; error: string; logs: string }>({
    jobId: null, status: 'starting', progress: 0, steps: [], error: '', logs: ''
});
let pollTimer: ReturnType<typeof setInterval> | null = null;

const isWordPress = computed(() => props.site?.siteType === 'wordpress');
const running = computed(() => step.value === 'progress' && (run.value.status === 'starting' || run.value.status === 'running'));
const looksLikeDomain = computed(() => {
    const v = form.value.newUrl.trim().replace(/^https?:\/\//i, '').split('/')[0] ?? '';
    return !!v && !v.includes(':') && !/^\d+(\.\d+){3}$/.test(v) && v.includes('.');
});

const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
};
onUnmounted(stopPolling);

const reset = async () => {
    step.value = 'form';
    form.value = { newUrl: '', cloudflare: false, keepOld: true, service: '' };
    formError.value = '';
    preflight.value = { loading: false, ok: false, checks: [], plan: null, error: '' };
    run.value = { jobId: null, status: 'starting', progress: 0, steps: [], error: '', logs: '' };
    stopPolling();
    try {
        const s = await request<any>('/settings');
        cloudflareReady.value = !!(s?.cloudflareApiTokenSet && s?.cloudflareAccountId && s?.cloudflareTunnelId);
        form.value.cloudflare = cloudflareReady.value;
    } catch {
        cloudflareReady.value = false;
    }
};

watch(() => props.open, open => {
    if (open) reset();
});

const payload = () => ({
    newUrl: form.value.newUrl.trim(),
    cloudflare: form.value.cloudflare && looksLikeDomain.value,
    keepOld: form.value.keepOld,
    service: form.value.service.trim() || null
});

const runPreflight = async () => {
    if (!props.site) return;
    preflight.value = { ...preflight.value, loading: true, error: '' };
    try {
        const r = await request<{ ok: boolean; checks: Check[]; plan: Plan | null }>(`/sites/${props.site.id}/change-url/preflight`, 'POST', payload());
        preflight.value = { loading: false, ok: r.ok, checks: r.checks, plan: r.plan, error: '' };
        if (r.plan?.cloudflare && !form.value.service) form.value.service = r.plan.cloudflare.service;
    } catch (e: any) {
        preflight.value = { loading: false, ok: false, checks: [], plan: null, error: e.message || 'Check failed' };
    }
};

const goToReview = async () => {
    formError.value = '';
    if (!form.value.newUrl.trim()) {
        formError.value = 'Enter the new address.';
        return;
    }
    step.value = 'review';
    await runPreflight();
};

const sortedChecks = computed(() => {
    const order = { fail: 0, warn: 1, ok: 2 } as const;
    return [...preflight.value.checks].sort((a, b) => order[a.status] - order[b.status]);
});

const recordStep = (message?: string) => {
    if (message && run.value.steps[run.value.steps.length - 1] !== message) run.value.steps.push(message);
};

const finish = async (status: 'COMPLETED' | 'FAILED', error?: string) => {
    if (run.value.status === 'done' || run.value.status === 'failed' || !run.value.jobId) return;
    stopPolling();
    const job = await request<any>(`/jobs/${run.value.jobId}`).catch(() => null);
    run.value.logs = job?.logs || '';
    if (status === 'COMPLETED') {
        run.value.status = 'done';
        run.value.progress = 100;
        if (props.site && preflight.value.plan) emit('changed', props.site.id, preflight.value.plan.newUrl);
    } else {
        run.value.status = 'failed';
        run.value.error = error || run.value.logs.split('\n').reverse().find(l => l.includes('✖'))?.replace(/^.*✖\s*/, '') || 'The address change failed';
    }
};

useJobUpdates(update => {
    if (!run.value.jobId) return;
    const id = update.jobId || update.job?.id;
    if (id !== run.value.jobId) return;
    if (update.type === 'job:progress') {
        run.value.status = 'running';
        run.value.progress = update.progress || 0;
        recordStep(update.message);
    } else if (update.type === 'job:completed') {
        finish('COMPLETED');
    } else if (update.type === 'job:failed') {
        finish('FAILED', update.error);
    }
});

const startPolling = () => {
    stopPolling();
    pollTimer = setInterval(async () => {
        const job = await request<any>(`/jobs/${run.value.jobId}`).catch(() => null);
        if (!job) return;
        if (job.status === 'COMPLETED' || job.status === 'FAILED') return finish(job.status);
        run.value.progress = Math.max(run.value.progress, job.progress || 0);
        const logged = String(job.logs || '').split('\n').filter(l => l.includes('▶ ')).map(l => l.split('▶ ')[1] ?? '');
        if (logged.length > run.value.steps.length) run.value.steps = logged;
    }, 3000);
};

const start = async () => {
    if (!props.site) return;
    step.value = 'progress';
    try {
        const { jobId } = await request<{ jobId: string }>(`/sites/${props.site.id}/change-url`, 'POST', payload());
        run.value.jobId = jobId;
        run.value.status = 'running';
        startPolling();
    } catch (e: any) {
        run.value.status = 'failed';
        run.value.error = e.message || 'Could not start';
    }
};

const close = () => {
    if (running.value) return;
    emit('close');
};
</script>

<template>
    <Teleport to="body">
        <Transition name="modal">
            <div v-if="open && site" class="modal-overlay" @click.self="close">
                <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="change-url-title">
                    <div class="modal-header">
                        <h2 id="change-url-title">Change address<span class="site-name"> · {{ site.label }}</span></h2>
                        <button class="modal-close" @click="close" :disabled="running" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>

                    <!-- Step 1: new address -->
                    <form v-if="step === 'form'" class="modal-body" @submit.prevent="goToReview">
                        <p class="lead">
                            Currently <code>{{ site.siteUrl || 'no address set' }}</code>.
                            <template v-if="isWordPress"> WebSync backs up the database, then rewrites every link to the old address, including serialized plugin data.</template>
                        </p>
                        <div class="form-group">
                            <label class="form-label" for="cu-url">New address <span class="required">*</span></label>
                            <input id="cu-url" v-model="form.newUrl" class="form-input" placeholder="https://example.com" required autofocus />
                            <span class="form-hint">A domain, like <code>example.com</code> (https is assumed), or a LAN address like <code>http://192.168.1.161:8105</code>.</span>
                        </div>

                        <label class="toggle-row" :class="{ disabled: !cloudflareReady || !looksLikeDomain }">
                            <input type="checkbox" v-model="form.cloudflare" :disabled="!cloudflareReady || !looksLikeDomain" />
                            <span>
                                <strong>Route through Cloudflare Tunnel</strong>
                                <span v-if="!cloudflareReady" class="form-hint">Set up Cloudflare in Settings to have WebSync add the tunnel route and DNS record.</span>
                                <span v-else-if="!looksLikeDomain" class="form-hint">Only for domain names.</span>
                                <span v-else class="form-hint">Adds the hostname to your tunnel and creates its DNS record.</span>
                            </span>
                        </label>
                        <label v-if="form.cloudflare && cloudflareReady && looksLikeDomain" class="toggle-row">
                            <input type="checkbox" v-model="form.keepOld" />
                            <span>
                                <strong>Keep the old hostname working</strong>
                                <span class="form-hint">Visitors to the old address are redirected to the new one{{ isWordPress ? ' by WordPress' : '' }}. Turn off to remove its tunnel route and DNS record.</span>
                            </span>
                        </label>

                        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
                        <div class="modal-actions">
                            <button type="button" class="btn btn-secondary" @click="close">Cancel</button>
                            <button type="submit" class="btn btn-primary">Review</button>
                        </div>
                    </form>

                    <!-- Step 2: review -->
                    <div v-else-if="step === 'review'" class="modal-body">
                        <div v-if="preflight.loading" class="center-state">
                            <div class="spinner"></div>
                            <span>Checking WordPress and Cloudflare…</span>
                        </div>
                        <template v-else>
                            <p v-if="preflight.error" class="form-error" role="alert">{{ preflight.error }}</p>

                            <section v-if="preflight.plan">
                                <h3 class="section-label">WebSync will</h3>
                                <ul class="plan-list">
                                    <li v-if="preflight.plan.wordpress">Back up the WordPress database</li>
                                    <li v-if="preflight.plan.cloudflare">
                                        Route <code>{{ preflight.plan.cloudflare.newHost }}</code> to <code>{{ preflight.plan.cloudflare.service }}</code> on the tunnel{{ preflight.plan.cloudflare.createDns ? `, and add its DNS record in ${preflight.plan.cloudflare.zone}` : '' }}
                                    </li>
                                    <li v-if="preflight.plan.wordpress">
                                        Replace <code>{{ preflight.plan.oldUrl }}</code> with <code>{{ preflight.plan.newUrl }}</code> throughout the database, and update the Home and Site URL settings
                                    </li>
                                    <li>Set this site's address in WebSync to <code>{{ preflight.plan.newUrl }}</code></li>
                                    <li v-if="preflight.plan.cloudflare?.oldHost && !form.keepOld">
                                        Remove <code>{{ preflight.plan.cloudflare.oldHost }}</code> from the tunnel and DNS
                                    </li>
                                </ul>
                                <p class="form-hint">If a step fails, everything before it is undone. Sync the database to the remote server afterwards to carry the change over.</p>
                            </section>

                            <section>
                                <h3 class="section-label">Checks</h3>
                                <ul class="check-list">
                                    <li v-for="c in sortedChecks" :key="c.id" :class="['check', c.status]">
                                        <span class="check-icon" :aria-label="c.status">{{ c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✕' }}</span>
                                        <div>
                                            <div class="check-label">{{ c.label }}</div>
                                            <div v-if="c.detail" class="check-detail">{{ c.detail }}</div>
                                            <div v-if="c.fix && c.status !== 'ok'" class="check-fix">{{ c.fix }}</div>
                                        </div>
                                    </li>
                                </ul>
                            </section>

                            <div v-if="payload().cloudflare" class="form-group">
                                <label class="form-label" for="cu-service">Tunnel origin</label>
                                <div class="inline-row">
                                    <input id="cu-service" v-model="form.service" class="form-input mono" placeholder="http://192.168.1.161:8105" />
                                    <button class="btn btn-secondary" @click="runPreflight">Re-check</button>
                                </div>
                                <span class="form-hint">Where cloudflared sends this hostname's traffic. Taken from the old route or the container's port.</span>
                            </div>
                        </template>

                        <div class="modal-actions">
                            <button class="btn btn-secondary" @click="step = 'form'">Back</button>
                            <button class="btn btn-primary" @click="start" :disabled="preflight.loading || !preflight.ok">Change address</button>
                        </div>
                    </div>

                    <!-- Step 3: progress -->
                    <div v-else class="modal-body">
                        <div class="progress-track" role="progressbar" :aria-valuenow="run.progress" aria-valuemin="0" aria-valuemax="100">
                            <div class="progress-fill" :class="run.status" :style="{ width: `${run.status === 'failed' ? 100 : run.progress}%` }"></div>
                        </div>

                        <ul class="check-list" aria-live="polite">
                            <li v-for="(s, i) in run.steps" :key="s"
                                :class="['check', i < run.steps.length - 1 || run.status === 'done' ? 'ok' : run.status === 'failed' ? 'fail' : 'running']">
                                <span class="check-icon">
                                    <template v-if="i < run.steps.length - 1 || run.status === 'done'">✓</template>
                                    <template v-else-if="run.status === 'failed'">✕</template>
                                    <span v-else class="spinner spinner-xs"></span>
                                </span>
                                <div class="check-label">{{ s }}</div>
                            </li>
                            <li v-if="!run.steps.length && run.status !== 'failed'" class="check running">
                                <span class="check-icon"><span class="spinner spinner-xs"></span></span>
                                <div class="check-label">Starting…</div>
                            </li>
                        </ul>

                        <div v-if="run.status === 'done'" class="result ok">
                            <strong>{{ site.label }} is now at <code>{{ preflight.plan?.newUrl }}</code>.</strong>
                            <span v-if="preflight.plan?.cloudflare?.createDns">New DNS records can take a minute to work everywhere.</span>
                        </div>
                        <div v-if="run.status === 'failed'" class="result fail" role="alert">
                            <strong>The address wasn't changed.</strong>
                            <span>{{ run.error }}</span>
                            <span>Anything already changed has been put back. See Details for each step.</span>
                        </div>
                        <details v-if="run.logs" class="logs">
                            <summary>Details</summary>
                            <pre>{{ run.logs }}</pre>
                        </details>

                        <div class="modal-actions">
                            <template v-if="run.status === 'done'">
                                <button class="btn btn-secondary" @click="close">Done</button>
                                <a v-if="preflight.plan" class="btn btn-primary" :href="preflight.plan.newUrl" target="_blank" rel="noopener">Open site</a>
                            </template>
                            <template v-else-if="run.status === 'failed'">
                                <button class="btn btn-secondary" @click="close">Close</button>
                                <button class="btn btn-primary" @click="step = 'review'; runPreflight()">Back to review</button>
                            </template>
                            <span v-else class="form-hint">Keep this window open until it finishes.</span>
                        </div>
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

.modal-content {
    background: var(--bg-elevated);
    border-radius: var(--radius-xl);
    width: 100%;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: var(--shadow-xl);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-5) var(--space-6);
    border-bottom: 1px solid var(--border-primary);
}

.modal-header h2 {
    font-size: var(--text-lg);
    font-weight: var(--font-semibold);
}

.modal-close {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    transition: all var(--transition-fast);
}

.modal-close:hover:not(:disabled) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.modal-close:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.modal-close svg {
    width: 20px;
    height: 20px;
}

.modal-body {
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-primary);
}

.btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-5);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    font-weight: var(--font-medium);
    text-decoration: none;
    transition: all var(--transition-fast);
}

.btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.btn-primary {
    background: var(--color-primary);
    color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
    background: var(--color-primary-hover);
}

.btn-secondary {
    background: var(--bg-tertiary);
    color: var(--text-primary);
}

.btn-secondary:hover:not(:disabled) {
    background: var(--border-secondary);
}







.lead {
    color: var(--text-secondary);
    font-size: var(--text-sm);
}









.form-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
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
    font-size: var(--text-sm);
    color: var(--text-primary);
    transition: all var(--transition-fast);
}

.form-input.mono,
code {
    font-family: var(--font-mono);
}

.form-input::placeholder {
    color: var(--text-muted);
}

.form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
}

.form-hint {
    font-size: var(--text-xs);
    color: var(--text-muted);
    line-height: var(--leading-normal);
}

.form-error {
    font-size: var(--text-sm);
    color: var(--color-danger);
}

code {
    font-size: 0.85em;
    background: var(--bg-tertiary);
    padding: 0 var(--space-1);
    border-radius: var(--radius-sm);
    word-break: break-all;
}

.section-label {
    font-size: var(--text-xs);
    font-weight: var(--font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
}

.plan-list {
    margin: 0 0 var(--space-2);
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    line-height: var(--leading-normal);
}

.check-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
}

.check {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-sm);
}

.check-icon {
    flex: none;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-full);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--text-xs);
    font-weight: var(--font-bold);
}

.check.ok .check-icon {
    background: var(--color-success-subtle);
    color: var(--color-success);
}

.check.warn .check-icon {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
}

.check.fail .check-icon {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
}

.check-label {
    color: var(--text-primary);
}

.check-detail {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
}

.check-fix {
    margin-top: var(--space-1);
    color: var(--text-primary);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
}

.center-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6) 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
}

.spinner {
    width: 28px;
    height: 28px;
    border: 3px solid var(--border-primary);
    border-top-color: var(--color-primary);
    border-radius: var(--radius-full);
    animation: spin 0.8s linear infinite;
}

.spinner-xs {
    width: 14px;
    height: 14px;
    border-width: 2px;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

.progress-track {
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: var(--radius-full);
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: var(--color-primary);
    transition: width var(--transition-slow);
}

.progress-fill.done {
    background: var(--color-success);
}

.progress-fill.failed {
    background: var(--color-danger);
}

.result {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
}

.result.ok {
    background: var(--color-success-subtle);
    color: var(--text-primary);
}

.result.fail {
    background: var(--color-danger-subtle);
    color: var(--text-primary);
}

.logs summary {
    cursor: pointer;
    font-size: var(--text-xs);
    color: var(--text-secondary);
}

.logs pre {
    margin-top: var(--space-2);
    max-height: 220px;
    overflow: auto;
    padding: var(--space-3);
    background: var(--bg-secondary);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: pre-wrap;
    word-break: break-word;
}

.modal-enter-active,
.modal-leave-active {
    transition: opacity var(--transition-normal);
}

.modal-enter-active .modal-content,
.modal-leave-active .modal-content {
    transition: transform var(--transition-normal), opacity var(--transition-normal);
}

.modal-enter-from,
.modal-leave-to {
    opacity: 0;
}

.modal-enter-from .modal-content,
.modal-leave-to .modal-content {
    opacity: 0;
    transform: scale(0.95) translateY(20px);
}

@media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 2.4s; }
    .progress-fill,
    .modal-enter-active,
    .modal-leave-active,
    .modal-enter-active .modal-content,
    .modal-leave-active .modal-content { transition: none; }
}

.site-name {
    color: var(--text-muted);
    font-weight: var(--font-normal);
}

.toggle-row {
    display: flex;
    gap: var(--space-3);
    align-items: flex-start;
    font-size: var(--text-sm);
    cursor: pointer;
}

.toggle-row > span {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
}

.toggle-row input {
    margin-top: 3px;
    accent-color: var(--color-primary);
}

.toggle-row.disabled {
    cursor: not-allowed;
    opacity: 0.7;
}

.inline-row {
    display: flex;
    gap: var(--space-2);
}

.inline-row .form-input {
    flex: 1;
    min-width: 0;
}

.check.running .check-icon {
    color: var(--color-primary);
}
</style>

