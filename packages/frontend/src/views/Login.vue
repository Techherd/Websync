<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useApi } from '../composables/useApi';
import { useTheme } from '../composables/useTheme';
import ThemeToggle from '../components/ThemeToggle.vue';

const router = useRouter();
const { login } = useApi();
// Initialize theme system
useTheme();

const password = ref('');
const error = ref('');
const loading = ref(false);

const handleSubmit = async () => {
    error.value = '';
    loading.value = true;
    
    try {
        await login(password.value);
        router.push('/');
    } catch (e: any) {
        error.value = e.message || 'Invalid password';
    } finally {
        loading.value = false;
    }
};
</script>

<template>
    <div class="login-page">
        <div class="login-background">
            <div class="bg-gradient"></div>
            <div class="bg-grid"></div>
        </div>
        
        <div class="login-container">
            <div class="login-card">
                <div class="login-header">
                    <div class="logo">
                        <svg class="logo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                        </svg>
                        <span class="logo-text">WebSync</span>
                    </div>
                    <p class="login-subtitle">Sign in to manage your sync jobs</p>
                </div>

                <form @submit.prevent="handleSubmit" class="login-form">
                    <div class="form-group">
                        <label for="password" class="form-label">Password</label>
                        <div class="input-wrapper">
                            <svg class="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                            </svg>
                            <input 
                                id="password"
                                v-model="password" 
                                type="password" 
                                class="form-input"
                                placeholder="Enter your password"
                                required
                                autofocus
                            />
                        </div>
                    </div>

                    <div v-if="error" class="error-message">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="15" y1="9" x2="9" y2="15"/>
                            <line x1="9" y1="9" x2="15" y2="15"/>
                        </svg>
                        <span>{{ error }}</span>
                    </div>

                    <button type="submit" class="login-button" :disabled="loading">
                        <span v-if="loading" class="spinner"></span>
                        <span v-else>Sign In</span>
                    </button>
                </form>

                <div class="login-footer">
                    <ThemeToggle />
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.login-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
}

.login-background {
    position: absolute;
    inset: 0;
    z-index: 0;
}

.bg-gradient {
    position: absolute;
    inset: 0;
    background: 
        radial-gradient(ellipse at 20% 20%, var(--color-primary-subtle) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 80%, var(--color-success-subtle) 0%, transparent 50%),
        var(--bg-secondary);
}

.bg-grid {
    position: absolute;
    inset: 0;
    background-image: 
        linear-gradient(var(--border-primary) 1px, transparent 1px),
        linear-gradient(90deg, var(--border-primary) 1px, transparent 1px);
    background-size: 60px 60px;
    opacity: 0.3;
}

.login-container {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 420px;
    padding: var(--space-4);
}

.login-card {
    background: var(--bg-elevated);
    border-radius: var(--radius-2xl);
    padding: var(--space-10);
    box-shadow: var(--shadow-xl);
    border: 1px solid var(--border-primary);
    animation: slideInUp var(--transition-slow);
}

.login-header {
    text-align: center;
    margin-bottom: var(--space-8);
}

.logo {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
}

.logo-icon {
    width: 40px;
    height: 40px;
    color: var(--color-primary);
}

.logo-text {
    font-size: var(--text-2xl);
    font-weight: var(--font-bold);
    color: var(--text-primary);
}

.login-subtitle {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.login-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
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

.input-wrapper {
    position: relative;
}

.input-icon {
    position: absolute;
    left: var(--space-4);
    top: 50%;
    transform: translateY(-50%);
    width: 20px;
    height: 20px;
    color: var(--text-muted);
    pointer-events: none;
}

.form-input {
    width: 100%;
    padding: var(--space-4) var(--space-4) var(--space-4) 48px;
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

.error-message {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: var(--color-danger-subtle);
    border-radius: var(--radius-lg);
    color: var(--color-danger);
    font-size: var(--text-sm);
}

.error-message svg {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
}

.login-button {
    width: 100%;
    padding: var(--space-4);
    background: var(--color-primary);
    color: white;
    border-radius: var(--radius-lg);
    font-size: var(--text-base);
    font-weight: var(--font-semibold);
    transition: all var(--transition-fast);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
}

.login-button:hover:not(:disabled) {
    background: var(--color-primary-hover);
    transform: translateY(-1px);
}

.login-button:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.spinner {
    width: 20px;
    height: 20px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
}

.login-footer {
    display: flex;
    justify-content: center;
    margin-top: var(--space-6);
    padding-top: var(--space-6);
    border-top: 1px solid var(--border-primary);
}
</style>
