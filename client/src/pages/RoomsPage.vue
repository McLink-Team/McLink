<script setup lang="ts">
/** 联机主页：未进房时展示我的房间与建房/加入；已进房时交给 RoomPage */
import { computed } from 'vue';
import { clientState, hasRoom } from '../lib/store.ts';
import RoomPage from './RoomPage.vue';
import CreateJoin from '../components/CreateJoin.vue';

const active = computed(() => hasRoom.value);
void clientState;
</script>

<template>
  <RoomPage v-if="active" />
  <CreateJoin v-else />
</template>
