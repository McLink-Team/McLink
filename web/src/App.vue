<script setup lang="ts">
import { RouterView } from 'vue-router';
import ToastHost from './components/ToastHost.vue';
</script>

<template>
  <RouterView v-slot="{ Component }">
    <component :is="Component" />
  </RouterView>
  <ToastHost />
</template>
