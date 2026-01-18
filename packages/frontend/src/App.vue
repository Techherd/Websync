<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useTheme } from './composables/useTheme';
import AppLayout from './components/AppLayout.vue';

const route = useRoute();
// Initialize theme system
useTheme();

const showLayout = computed(() => route.meta.requiresAuth !== false);
</script>

<template>
    <AppLayout v-if="showLayout">
        <router-view />
    </AppLayout>
    <router-view v-else />
</template>
