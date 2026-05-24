<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useApi } from '../composables/useApi';
import { useToast } from '../composables/useToast';
import ConfirmDialog from '../components/ConfirmDialog.vue';

interface User {
    id: string;
    email: string;
    name: string;
    role: string;
    createdAt: string;
    lastLoginAt: string | null;
}

const { getUsers, getMe, createUser, updateUser, deleteUser, changeOwnPassword } = useApi();
const { success, error } = useToast();

const users = ref<User[]>([]);
const me = ref<User | null>(null);
const loading = ref(true);

const showInvite = ref(false);
const newUser = ref({ email: '', name: '', password: '', role: 'owner' });

const showPasswordModal = ref(false);
const passwordForm = ref({ current: '', next: '', confirm: '' });

const deleteConfirm = ref<{ open: boolean; user: User | null }>({ open: false, user: null });

const isOwner = computed(() => me.value?.role === 'owner');

const load = async () => {
    loading.value = true;
    try {
        const [allUsers, meData] = await Promise.all([getUsers(), getMe()]);
        users.value = allUsers || [];
        me.value = meData;
    } catch (e: any) {
        error('Failed to load', e.message || 'Could not fetch users');
    } finally {
        loading.value = false;
    }
};

const handleInvite = async () => {
    try {
        if (newUser.value.password.length < 8) {
            error('Password too short', 'Password must be at least 8 characters');
            return;
        }
        await createUser(newUser.value);
        success('User added', `${newUser.value.email} can now sign in`);
        showInvite.value = false;
        newUser.value = { email: '', name: '', password: '', role: 'owner' };
        await load();
    } catch (e: any) {
        error('Could not add user', e.message || 'Try again');
    }
};

const handleChangePassword = async () => {
    if (passwordForm.value.next !== passwordForm.value.confirm) {
        error('Passwords do not match', 'Re-type the new password');
        return;
    }
    if (passwordForm.value.next.length < 8) {
        error('Password too short', 'Use at least 8 characters');
        return;
    }
    try {
        await changeOwnPassword(passwordForm.value.current, passwordForm.value.next);
        success('Password updated', 'Other sessions have been signed out');
        showPasswordModal.value = false;
        passwordForm.value = { current: '', next: '', confirm: '' };
    } catch (e: any) {
        error('Could not change password', e.message || 'Try again');
    }
};

const handleResetPassword = async (user: User) => {
    const next = window.prompt(`Set a new password for ${user.email}:`);
    if (!next) return;
    if (next.length < 8) {
        error('Password too short', 'Use at least 8 characters');
        return;
    }
    try {
        await updateUser(user.id, { password: next });
        success('Password reset', `${user.email} has been signed out everywhere`);
    } catch (e: any) {
        error('Could not reset password', e.message || 'Try again');
    }
};

const handleDelete = async () => {
    const user = deleteConfirm.value.user;
    if (!user) return;
    try {
        await deleteUser(user.id);
        success('User removed', `${user.email} can no longer sign in`);
        deleteConfirm.value = { open: false, user: null };
        await load();
    } catch (e: any) {
        error('Could not delete user', e.message || 'Try again');
    }
};

const formatDate = (s: string | null) => s ? new Date(s).toLocaleString() : 'Never';

onMounted(load);
</script>

<template>
    <div class="users-page">
        <div class="page-header">
            <div>
                <h2 class="section-title">Users</h2>
                <p class="section-subtitle">{{ users.length }} account{{ users.length === 1 ? '' : 's' }}</p>
            </div>
            <div class="header-actions">
                <button class="btn btn-secondary" @click="showPasswordModal = true">Change my password</button>
                <button class="btn btn-primary" v-if="isOwner" @click="showInvite = true">Add user</button>
            </div>
        </div>

        <div v-if="loading" class="loading-state"><div class="spinner"></div><span>Loading…</span></div>

        <div v-else class="user-list">
            <article v-for="u in users" :key="u.id" class="user-card">
                <div class="user-info">
                    <div class="user-name">
                        {{ u.name }}
                        <span v-if="me && u.id === me.id" class="badge">you</span>
                        <span class="role-badge" :class="`role-${u.role}`">{{ u.role }}</span>
                    </div>
                    <div class="user-email">{{ u.email }}</div>
                    <div class="user-meta">
                        Created {{ formatDate(u.createdAt) }} · Last login {{ formatDate(u.lastLoginAt) }}
                    </div>
                </div>
                <div class="user-actions" v-if="isOwner">
                    <button class="btn-sm btn-secondary" @click="handleResetPassword(u)">Reset password</button>
                    <button
                        v-if="me && u.id !== me.id"
                        class="btn-sm btn-danger"
                        @click="deleteConfirm = { open: true, user: u }"
                    >Remove</button>
                </div>
            </article>
        </div>

        <!-- Invite modal -->
        <Teleport to="body">
            <Transition name="modal">
                <div v-if="showInvite" class="modal-overlay">
                    <div class="modal-content modal-sm">
                        <div class="modal-header">
                            <h2>Add user</h2>
                            <button class="modal-close" @click="showInvite = false">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                        <form @submit.prevent="handleInvite" class="modal-form">
                            <div class="form-group">
                                <label class="form-label">Name</label>
                                <input v-model="newUser.name" class="form-input" placeholder="Co-owner name" required />
                            </div>
                            <div class="form-group">
                                <label class="form-label">Email</label>
                                <input v-model="newUser.email" type="email" class="form-input" placeholder="them@yourcompany.com" required />
                            </div>
                            <div class="form-group">
                                <label class="form-label">Initial password</label>
                                <input v-model="newUser.password" type="password" class="form-input" placeholder="at least 8 characters" required minlength="8" />
                                <span class="form-hint">Share with them privately. They can change it after first login.</span>
                            </div>
                            <div class="form-group">
                                <label class="form-label">Role</label>
                                <select v-model="newUser.role" class="form-input">
                                    <option value="owner">Owner (full access)</option>
                                </select>
                            </div>
                            <div class="modal-actions">
                                <button type="button" class="btn btn-secondary" @click="showInvite = false">Cancel</button>
                                <button type="submit" class="btn btn-primary">Add user</button>
                            </div>
                        </form>
                    </div>
                </div>
            </Transition>
        </Teleport>

        <!-- Change own password modal -->
        <Teleport to="body">
            <Transition name="modal">
                <div v-if="showPasswordModal" class="modal-overlay">
                    <div class="modal-content modal-sm">
                        <div class="modal-header">
                            <h2>Change password</h2>
                            <button class="modal-close" @click="showPasswordModal = false">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"/>
                                    <line x1="6" y1="6" x2="18" y2="18"/>
                                </svg>
                            </button>
                        </div>
                        <form @submit.prevent="handleChangePassword" class="modal-form">
                            <div class="form-group">
                                <label class="form-label">Current password</label>
                                <input v-model="passwordForm.current" type="password" class="form-input" required />
                            </div>
                            <div class="form-group">
                                <label class="form-label">New password</label>
                                <input v-model="passwordForm.next" type="password" class="form-input" required minlength="8" />
                            </div>
                            <div class="form-group">
                                <label class="form-label">Confirm new password</label>
                                <input v-model="passwordForm.confirm" type="password" class="form-input" required minlength="8" />
                            </div>
                            <div class="modal-actions">
                                <button type="button" class="btn btn-secondary" @click="showPasswordModal = false">Cancel</button>
                                <button type="submit" class="btn btn-primary">Update password</button>
                            </div>
                        </form>
                    </div>
                </div>
            </Transition>
        </Teleport>

        <ConfirmDialog
            :open="deleteConfirm.open"
            title="Remove user?"
            :message="deleteConfirm.user ? `Remove ${deleteConfirm.user.email}? They will be signed out and lose all access.` : ''"
            variant="danger"
            confirmLabel="Remove"
            @confirm="handleDelete"
            @cancel="deleteConfirm = { open: false, user: null }"
        />
    </div>
</template>

<style scoped>
.users-page { animation: fadeIn var(--transition-normal); max-width: 900px; }

.page-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: var(--space-6);
    gap: var(--space-4);
}

.section-title {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--text-primary);
}

.section-subtitle {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin-top: var(--space-1);
}

.header-actions { display: flex; gap: var(--space-2); }

.user-list { display: flex; flex-direction: column; gap: var(--space-3); }

.user-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
}

.user-name {
    font-weight: var(--font-semibold);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: var(--space-2);
}

.user-email {
    font-size: var(--text-sm);
    color: var(--text-secondary);
    margin-top: var(--space-1);
}

.user-meta {
    font-size: var(--text-xs);
    color: var(--text-muted);
    margin-top: var(--space-2);
}

.badge {
    background: var(--color-primary-subtle);
    color: var(--color-primary);
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-md);
    font-weight: var(--font-medium);
}

.role-badge {
    font-size: var(--text-xs);
    padding: 2px var(--space-2);
    border-radius: var(--radius-md);
    font-weight: var(--font-medium);
    text-transform: capitalize;
}
.role-owner { background: var(--color-success-subtle); color: var(--color-success); }
.role-viewer { background: var(--bg-tertiary); color: var(--text-secondary); }

.user-actions { display: flex; gap: var(--space-2); flex-shrink: 0; }

.btn { padding: var(--space-2) var(--space-4); border-radius: var(--radius-md); font-size: var(--text-sm); font-weight: var(--font-medium); }
.btn-primary { background: var(--color-primary); color: white; }
.btn-primary:hover { background: var(--color-primary-hover); }
.btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
.btn-secondary:hover { background: var(--border-secondary); }

.btn-sm {
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    font-weight: var(--font-medium);
}
.btn-sm.btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
.btn-sm.btn-secondary:hover { background: var(--border-secondary); }
.btn-sm.btn-danger { background: var(--color-danger-subtle); color: var(--color-danger); }
.btn-sm.btn-danger:hover { background: var(--color-danger); color: white; }

.loading-state {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-6);
    color: var(--text-muted);
}
.spinner {
    width: 20px; height: 20px;
    border: 2px solid var(--border-primary);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
}

.modal-overlay {
    position: fixed; inset: 0;
    background: var(--bg-overlay);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    padding: var(--space-4);
}
.modal-content {
    background: var(--bg-elevated);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-xl);
    width: 100%; max-width: 480px;
}
.modal-sm { max-width: 440px; }
.modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-5);
    border-bottom: 1px solid var(--border-primary);
}
.modal-close {
    background: transparent; color: var(--text-muted);
    width: 32px; height: 32px;
    border-radius: var(--radius-md);
    display: flex; align-items: center; justify-content: center;
}
.modal-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.modal-close svg { width: 18px; height: 18px; }

.modal-form { padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.form-group { display: flex; flex-direction: column; gap: var(--space-2); }
.form-label { font-size: var(--text-sm); font-weight: var(--font-medium); color: var(--text-primary); }
.form-input {
    padding: var(--space-3) var(--space-4);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    color: var(--text-primary);
}
.form-input:focus {
    outline: none;
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px var(--color-primary-subtle);
}
.form-hint { font-size: var(--text-xs); color: var(--text-muted); margin-top: var(--space-1); }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

.modal-enter-active, .modal-leave-active { transition: opacity var(--transition-normal); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
</style>
