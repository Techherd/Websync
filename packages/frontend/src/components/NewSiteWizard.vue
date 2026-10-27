<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue';
import { useApi } from '../composables/useApi';
import { useJobUpdates } from '../composables/useWebSocket';

type SiteKind = 'wordpress' | 'static';
type Step = 'type' | 'details' | 'review' | 'progress';

interface PreflightCheck {
    id: string;
    label: string;
    status: 'ok' | 'warn' | 'fail';
    detail?: string;
    fix?: string;
}

interface PreflightPlan {
    siteDir: string;
    dbDir: string | null;
    webContainer: string;
    dbContainer: string | null;
    webImage: string;
    webPort: number;
    siteUrl: string | null;
}

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; created: [siteId: string] }>();

const { request } = useApi();

const step = ref<Step>('type');
const form = ref({ type: 'wordpress' as SiteKind, name: '', slug: '', domain: '', adminEmail: '' });
const slugEdited = ref(false);
const formError = ref('');

const preflight = ref<{ loading: boolean; ok: boolean; checks: PreflightCheck[]; plan: PreflightPlan | null; error: string }>({
    loading: false, ok: false, checks: [], plan: null, error: ''
});

const run = ref<{
    jobId: string | null;
    status: 'starting' | 'running' | 'done' | 'failed';
    progress: number;
    steps: string[];
    error: string;
    logs: string;
    siteId: string | null;
    loggingIn: boolean;
}>({ jobId: null, status: 'starting', progress: 0, steps: [], error: '', logs: '', siteId: null, loggingIn: false });

const toSlug = (name: string) =>
    name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 32).replace(/-+$/, '');

watch(() => form.value.name, name => {
    if (!slugEdited.value) form.value.slug = toSlug(name);
});

watch(() => props.open, open => {
    if (open) reset();
});

const reset = () => {
    step.value = 'type';
    form.value = { type: 'wordpress', name: '', slug: '', domain: '', adminEmail: '' };
    slugEdited.value = false;
    formError.value = '';
    preflight.value = { loading: false, ok: false, checks: [], plan: null, error: '' };
    run.value = { jobId: null, status: 'starting', progress: 0, steps: [], error: '', logs: '', siteId: null, loggingIn: false };
    stopPolling();
};

const isWordPress = computed(() => form.value.type === 'wordpress');
const running = computed(() => step.value === 'progress' && (run.value.status === 'starting' || run.value.status === 'running'));

const payload = () => ({
    type: form.value.type,
    name: form.value.name.trim(),
    slug: form.value.slug,
    domain: form.value.domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null,
    adminEmail: isWordPress.value ? form.value.adminEmail.trim() || null : null
});

const goToReview = async () => {
    formError.value = '';
    if (!form.value.name.trim()) return void (formError.value = 'Give the site a name.');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(form.value.slug)) {
        return void (formError.value = 'The short name can only use lowercase letters, numbers and dashes.');
    }
    step.value = 'review';
    await runPreflight();
};

const runPreflight = async () => {
    preflight.value = { loading: true, ok: false, checks: [], plan: null, error: '' };
    try {
        const result = await request<{ ok: boolean; checks: PreflightCheck[]; plan: PreflightPlan | null }>(
            '/provision/preflight', 'POST', payload()
        );
        preflight.value = { loading: false, ...result, error: '' };
    } catch (e: any) {
        preflight.value = { loading: false, ok: false, checks: [], plan: null, error: e.message || 'Check failed' };
    }
};

// --- Running the job -------------------------------------------------------

let pollTimer: ReturnType<typeof setInterval> | null = null;
const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
};
onUnmounted(stopPolling);

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
        run.value.siteId = job?.siteId || null;
        if (run.value.siteId) emit('created', run.value.siteId);
    } else {
        run.value.status = 'failed';
        run.value.error = error || run.value.logs.split('\n').reverse().find(l => l.includes('✖'))?.replace(/^.*✖\s*/, '') || 'Provisioning failed';
    }
};

// WebSocket gives live progress; polling covers missed messages and reconnects.
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
        // Step starts are logged as "▶ <name>"; rebuild from them in case live updates were missed.
        const logged = String(job.logs || '').split('\n').filter(l => l.includes('▶ ')).map(l => l.split('▶ ')[1] ?? '');
        if (logged.length > run.value.steps.length) run.value.steps = logged;
    }, 4000);
};

const create = async () => {
    step.value = 'progress';
    try {
        const { jobId } = await request<{ jobId: string }>('/provision', 'POST', payload());
        run.value.jobId = jobId;
        run.value.status = 'running';
        startPolling();
    } catch (e: any) {
        run.value.status = 'failed';
        run.value.error = e.message || 'Could not start';
    }
};

const openWpAdmin = async () => {
    if (!run.value.siteId) return;
    run.value.loggingIn = true;
    // Open the tab synchronously so pop-up blockers allow it, then point it at the magic link.
    const tab = window.open('about:blank', '_blank');
    try {
        const { url } = await request<{ url: string }>(`/sites/${run.value.siteId}/wp-admin/login`, 'POST', {});
        if (tab) tab.location.href = url;
        else window.location.href = url;
    } catch (e: any) {
        tab?.close();
        run.value.error = e.message || 'Could not log in';
    } finally {
        run.value.loggingIn = false;
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
            <div v-if="open" class="modal-overlay" @click.self="close">
                <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="new-site-title">
                    <div class="modal-header">
                        <h2 id="new-site-title">New site</h2>
                        <button class="modal-close" @click="close" :disabled="running" aria-label="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>

                    <ol class="stepper" aria-label="Progress">
                        <li v-for="(label, i) in ['Type', 'Details', 'Review', 'Create']" :key="label"
                            :class="{ active: ['type', 'details', 'review', 'progress'].indexOf(step) === i,
                                      done: ['type', 'details', 'review', 'progress'].indexOf(step) > i }">
                            <span class="stepper-dot">{{ i + 1 }}</span>{{ label }}
                        </li>
                    </ol>

                    <!-- Step 1: type -->
                    <div v-if="step === 'type'" class="modal-body">
                        <p class="lead">What kind of site are you creating?</p>
                        <div class="kind-grid">
                            <label :class="['kind-option', { active: form.type === 'wordpress' }]">
                                <input type="radio" v-model="form.type" value="wordpress" />
                                <strong>WordPress</strong>
                                <span>A WordPress site with its own database, ready to log in to.</span>
                            </label>
                            <label :class="['kind-option', { active: form.type === 'static' }]">
                                <input type="radio" v-model="form.type" value="static" />
                                <strong>Static HTML</strong>
                                <span>A simple web server for HTML, CSS and image files.</span>
                            </label>
                        </div>
                        <div class="modal-actions">
                            <button class="btn btn-secondary" @click="close">Cancel</button>
                            <button class="btn btn-primary" @click="step = 'details'">Next</button>
                        </div>
                    </div>

                    <!-- Step 2: details -->
                    <form v-else-if="step === 'details'" class="modal-body" @submit.prevent="goToReview">
                        <div class="form-group">
                            <label class="form-label" for="ns-name">Site name <span class="required">*</span></label>
                            <input id="ns-name" v-model="form.name" class="form-input" placeholder="Acme Plumbing" required autofocus />
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ns-slug">Short name</label>
                            <input id="ns-slug" v-model="form.slug" class="form-input mono" placeholder="acme-plumbing"
                                @input="slugEdited = true" pattern="[a-z0-9-]+" maxlength="32" />
                            <span class="form-hint">Used for folder and container names, like <code>Website-{{ form.slug || 'acme-plumbing' }}</code>.</span>
                        </div>
                        <div class="form-group">
                            <label class="form-label" for="ns-domain">Domain</label>
                            <input id="ns-domain" v-model="form.domain" class="form-input" placeholder="acmeplumbing.com" />
                            <span class="form-hint">Optional. Leave blank to use the server's address for now.</span>
                        </div>
                        <div v-if="isWordPress" class="form-group">
                            <label class="form-label" for="ns-email">Admin email</label>
                            <input id="ns-email" v-model="form.adminEmail" type="email" class="form-input" placeholder="you@example.com" />
                            <span class="form-hint">Optional. WordPress sends site notices here.</span>
                        </div>
                        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
                        <div class="modal-actions">
                            <button type="button" class="btn btn-secondary" @click="step = 'type'">Back</button>
                            <button type="submit" class="btn btn-primary">Review</button>
                        </div>
                    </form>

                    <!-- Step 3: review -->
                    <div v-else-if="step === 'review'" class="modal-body">
                        <div v-if="preflight.loading" class="center-state">
                            <div class="spinner"></div>
                            <span>Checking the server…</span>
                        </div>
                        <template v-else>
                            <p v-if="preflight.error" class="form-error" role="alert">{{ preflight.error }}</p>

                            <section v-if="preflight.plan">
                                <h3 class="section-label">WebSync will create</h3>
                                <ul class="plan-list">
                                    <li>A folder for the site's files: <code>{{ preflight.plan.siteDir }}/www</code></li>
                                    <li v-if="preflight.plan.dbContainer">
                                        A database, <code>{{ preflight.plan.dbContainer }}</code>, stored in <code>{{ preflight.plan.dbDir }}</code>. Only this site can reach it.
                                    </li>
                                    <li>
                                        {{ isWordPress ? 'A WordPress container' : 'A web server' }}, <code>{{ preflight.plan.webContainer }}</code>, on port {{ preflight.plan.webPort }}
                                    </li>
                                    <li>Unraid templates, so these show up in the Docker tab with Edit and Update</li>
                                    <li>This site in WebSync{{ isWordPress ? ', with a WebSync admin login ready to use' : '' }}</li>
                                </ul>
                                <p v-if="preflight.plan.siteUrl" class="form-hint">
                                    Address: <code>{{ preflight.plan.siteUrl }}</code>
                                    <template v-if="form.domain"> · point this domain at port {{ preflight.plan.webPort }} on the server in your proxy or tunnel.</template>
                                </p>
                            </section>

                            <section>
                                <h3 class="section-label">Checks</h3>
                                <ul class="check-list">
                                    <li v-for="c in preflight.checks" :key="c.id" :class="['check', c.status]">
                                        <span class="check-icon" :aria-label="c.status">{{ c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✕' }}</span>
                                        <div>
                                            <div class="check-label">{{ c.label }}<span v-if="c.detail && c.status === 'ok'" class="check-detail"> · {{ c.detail }}</span></div>
                                            <div v-if="c.detail && c.status !== 'ok'" class="check-detail">{{ c.detail }}</div>
                                            <div v-if="c.fix && c.status !== 'ok'" class="check-fix">{{ c.fix }}</div>
                                        </div>
                                    </li>
                                </ul>
                            </section>
                        </template>
                        <div class="modal-actions">
                            <button class="btn btn-secondary" @click="step = 'details'">Back</button>
                            <button class="btn btn-secondary" @click="runPreflight" :disabled="preflight.loading">Check again</button>
                            <button class="btn btn-primary" @click="create" :disabled="preflight.loading || !preflight.ok">Create site</button>
                        </div>
                    </div>

                    <!-- Step 4: progress -->
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
                            <strong>{{ form.name }} is ready.</strong>
                            <span v-if="preflight.plan?.siteUrl">It's at <code>{{ preflight.plan.siteUrl }}</code>.</span>
                        </div>
                        <div v-if="run.status === 'failed' || run.error" class="result fail" role="alert">
                            <strong>{{ run.status === 'failed' ? "The site couldn't be created." : 'Something went wrong.' }}</strong>
                            <span>{{ run.error }}</span>
                            <span v-if="run.status === 'failed'">Anything WebSync created for it has been removed.</span>
                        </div>
                        <details v-if="run.logs" class="logs">
                            <summary>Details</summary>
                            <pre>{{ run.logs }}</pre>
                        </details>

                        <div class="modal-actions">
                            <template v-if="run.status === 'done'">
                                <button class="btn btn-secondary" @click="close">Done</button>
                                <a v-if="preflight.plan?.siteUrl" class="btn btn-secondary" :href="preflight.plan.siteUrl" target="_blank" rel="noopener">Open site</a>
                                <button v-if="isWordPress" class="btn btn-primary" @click="openWpAdmin" :disabled="run.loggingIn">
                                    {{ run.loggingIn ? 'Logging in…' : 'Log in to WP admin' }}
                                </button>
                            </template>
                            <template v-else-if="run.status === 'failed'">
                                <button class="btn btn-secondary" @click="close">Close</button>
                                <button class="btn btn-primary" @click="step = 'review'; runPreflight()">Back to review</button>
                            </template>
                            <span v-else class="form-hint">This usually takes a minute or two. Keep this window open.</span>
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

.stepper {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4) var(--space-6) 0;
    list-style: none;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    flex-wrap: wrap;
}

.stepper li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.stepper-dot {
    width: 20px;
    height: 20px;
    border-radius: var(--radius-full);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-secondary);
    font-weight: var(--font-semibold);
}

.stepper li.active {
    color: var(--color-primary);
    font-weight: var(--font-medium);
}

.stepper li.active .stepper-dot {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
}

.stepper li.done .stepper-dot {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--text-on-primary);
}

.lead {
    color: var(--text-secondary);
    font-size: var(--text-sm);
}

.kind-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
}

.kind-option {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4);
    border: 2px solid var(--border-primary);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: all var(--transition-fast);
}

.kind-option input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
}

.kind-option:focus-within {
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
}

.kind-option strong {
    font-size: var(--text-sm);
    color: var(--text-primary);
}

.kind-option span {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    line-height: var(--leading-normal);
}

.kind-option.active {
    border-color: var(--color-primary);
    background: var(--color-primary-subtle);
}

.kind-option:hover:not(.active) {
    border-color: var(--border-secondary);
    background: var(--bg-tertiary);
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
</style>
