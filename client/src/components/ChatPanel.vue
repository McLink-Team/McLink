<script setup lang="ts">
/**
 * 房间聊天面板。
 *
 * 数据来源：
 *   - 历史：GET /rooms/:id/messages?limit=100
 *   - 补齐：GET /rooms/:id/messages?sinceId=<最后一条 id>（WS 重连后 / 重新进房后）
 *   - 实时：store 的 onRoomChat（room.message / room.messageDeleted）
 *
 * 服务端限制（已实测，见 scripts/verify-chat.mjs）：
 *   - 单条最多 500 字符（超出按码点截断并追加省略号）
 *   - 每人每房间每分钟 20 条，超出返回 429 rate_limited
 *   - 房主可删本房间任意消息，普通成员只能删自己的
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { formatRelativeTime, Routes, type ChatMessage } from '@mclink/shared';
import { ApiRequestError, api, friendlyError } from '../lib/api.ts';
import { confirmInApp } from '../lib/confirm.ts';
import { clientState, onRoomChat } from '../lib/store.ts';

interface MessagesResponse {
  messages: ChatMessage[];
  keepPerRoom: number;
  maxBodyChars: number;
}

/** 内置表情：不引库，够日常串门用即可 */
const EMOJIS = [
  '😀', '😂', '😅', '😊', '😍', '🤔', '😎', '😭', '😡', '🥳',
  '👍', '👎', '👏', '🙏', '💪', '🎉', '🔥', '✨', '❤️', '⭐',
  '✅', '❌', '🎮', '⛏️', '🗡️', '🏠', '🚀', '🌙', '☀️', '💎',
];

const session = computed(() => clientState.session);
const roomId = computed(() => session.value?.room.id ?? '');
const selfId = computed(() => clientState.user?.id ?? '');
const isHostView = computed(() => session.value?.isHost === true);

const messages = ref<ChatMessage[]>([]);
const loading = ref(true);
const error = ref('');
const sending = ref(false);
const notice = ref('');
const draft = ref('');
const collapsed = ref(false);
const unread = ref(0);
const emojiOpen = ref(false);
const maxChars = ref(500);
const keepPerRoom = ref(500);
const now = ref(Date.now());

const scroller = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
let clock: number | null = null;
let off: (() => void) | null = null;

const canSend = computed(() => !sending.value && draft.value.trim().length > 0);
const charsLeft = computed(() => maxChars.value - [...draft.value].length);

function merge(incoming: ChatMessage[]): void {
  if (incoming.length === 0) return;
  const byId = new Map<number, ChatMessage>();
  for (const m of messages.value) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  messages.value = [...byId.values()].sort((a, b) => a.id - b.id);
}

function dropLocal(messageId: number): void {
  messages.value = messages.value.filter((m) => m.id !== messageId);
}

function atBottom(): boolean {
  const el = scroller.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** 首次进入 / 换房间：拉最近 100 条 */
async function loadHistory(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.get<MessagesResponse>(Routes.roomMessages(roomId.value), { query: { limit: 100 } });
    messages.value = [...res.messages].sort((a, b) => a.id - b.id);
    maxChars.value = res.maxBodyChars > 0 ? res.maxBodyChars : 500;
    keepPerRoom.value = res.keepPerRoom > 0 ? res.keepPerRoom : 500;
    unread.value = 0;
    await scrollToBottom();
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    loading.value = false;
  }
}

/** 重连 / 重新进房：用 sinceId 只补差量 */
async function loadSince(): Promise<void> {
  if (loading.value || messages.value.length === 0) {
    if (messages.value.length === 0 && !loading.value) await loadHistory();
    return;
  }
  const lastId = messages.value[messages.value.length - 1]?.id ?? 0;
  try {
    const res = await api.get<MessagesResponse>(Routes.roomMessages(roomId.value), {
      query: { sinceId: lastId, limit: 200 },
    });
    const wasAtBottom = atBottom();
    merge(res.messages);
    if (wasAtBottom) await scrollToBottom();
    else if (res.messages.length > 0) unread.value += res.messages.length;
  } catch (err) {
    // 补齐失败不打断聊天：WS 正常时新消息照样能到
    notice.value = `历史消息补齐失败：${friendlyError(err)}`;
  }
}

async function send(): Promise<void> {
  const body = draft.value.trim();
  if (!body || sending.value) return;
  sending.value = true;
  error.value = '';
  notice.value = '';
  try {
    const message = await api.post<ChatMessage>(Routes.roomMessages(roomId.value), { body });
    merge([message]);
    draft.value = '';
    emojiOpen.value = false;
    unread.value = 0;
    await scrollToBottom();
  } catch (err) {
    if (err instanceof ApiRequestError && err.code === 'rate_limited') {
      error.value = '发言太快了，稍等一下再发（每个房间每分钟最多 20 条）。';
    } else if (err instanceof ApiRequestError && err.code === 'room_closed') {
      error.value = '房间已关闭，无法发言。';
    } else {
      error.value = friendlyError(err);
    }
  } finally {
    sending.value = false;
  }
}

function canDelete(message: ChatMessage): boolean {
  if (message.kind === 'system') return false;
  if (isHostView.value) return true;
  return message.userId !== null && message.userId === selfId.value;
}

async function remove(message: ChatMessage): Promise<void> {
  const preview = message.body.length > 40 ? `${message.body.slice(0, 40)}…` : message.body;
  const ok = await confirmInApp({
    title: '删除消息',
    message: `确定删除这条消息吗？（${message.displayName}：${preview}）`,
    detail: '删除后房间里的所有人都看不到这条消息了，且无法恢复。',
    confirmText: '删除消息',
    // 不可恢复，且对房间里所有人可见地消失：破坏性动作
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  try {
    await api.del<{ ok: boolean }>(Routes.roomMessage(roomId.value, message.id));
    dropLocal(message.id);
  } catch (err) {
    error.value = friendlyError(err);
  }
}

function insertEmoji(emoji: string): void {
  const el = input.value;
  if (!el) {
    draft.value += emoji;
    return;
  }
  const start = el.selectionStart ?? draft.value.length;
  const end = el.selectionEnd ?? start;
  draft.value = draft.value.slice(0, start) + emoji + draft.value.slice(end);
  void nextTick(() => {
    el.focus();
    const pos = start + emoji.length;
    el.setSelectionRange(pos, pos);
  });
}

function onScroll(): void {
  if (atBottom() && unread.value > 0) unread.value = 0;
}

function toggleCollapse(): void {
  collapsed.value = !collapsed.value;
  if (!collapsed.value) {
    unread.value = 0;
    void scrollToBottom();
  }
}

function onVisibility(): void {
  if (!document.hidden && !collapsed.value && atBottom()) unread.value = 0;
}

onMounted(async () => {
  await loadHistory();
  off = onRoomChat((event) => {
    if (event.type === 'resync') {
      void loadSince();
      return;
    }
    if (event.type === 'deleted') {
      dropLocal(event.messageId);
      return;
    }
    if (event.message.roomId && event.message.roomId !== roomId.value) return;
    const mine = event.message.userId !== null && event.message.userId === selfId.value;
    const watching = !collapsed.value && !document.hidden && atBottom();
    merge([event.message]);
    if (watching || mine) {
      void scrollToBottom();
      if (mine) unread.value = 0;
    } else {
      unread.value += 1;
    }
  });
  document.addEventListener('visibilitychange', onVisibility);
  clock = window.setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});

/**
 * 重新拿到票据（例如房主轮换密钥后重进同一个房间）时面板不会重新挂载，
 * 因此在这里补一次 sinceId 增量，避免断线期间的消息丢失。
 */
watch(
  () => clientState.sessionEpoch,
  (next, prev) => {
    if (next !== prev) void loadSince();
  },
);

onUnmounted(() => {
  off?.();
  document.removeEventListener('visibilitychange', onVisibility);
  if (clock !== null) window.clearInterval(clock);
});
</script>

<template>
  <div class="card chat">
    <div class="row-between" style="margin-bottom: 10px">
      <div class="row">
        <div style="font-weight: 620">房间聊天</div>
        <span v-if="messages.length > 0" class="badge badge-neutral">{{ messages.length }} 条</span>
        <span v-if="unread > 0" class="badge badge-danger">{{ unread > 99 ? '99+' : unread }} 条新消息</span>
      </div>
      <div class="row">
        <button class="btn btn-sm btn-ghost" @click="toggleCollapse()">
          {{ collapsed ? (unread > 0 ? `展开（${unread}）` : '展开') : '收起' }}
        </button>
        <button class="btn btn-sm btn-ghost" :disabled="loading" @click="loadHistory()">重新加载</button>
      </div>
    </div>

    <template v-if="!collapsed">
      <div v-if="error" class="alert alert-danger" style="margin-bottom: 10px">
        <span class="grow">{{ error }}</span>
        <button class="btn btn-ghost btn-sm" @click="error = ''">关闭</button>
      </div>
      <div v-if="notice" class="alert alert-warn" style="margin-bottom: 10px">
        <span class="grow">{{ notice }}</span>
        <button class="btn btn-ghost btn-sm" @click="notice = ''">关闭</button>
      </div>

      <!-- 三态：加载中 / 失败 / 空 -->
      <div v-if="loading" class="chat-body chat-state">
        <span class="spinner" />
        <span class="muted">正在读取聊天记录…</span>
      </div>
      <div v-else-if="error && messages.length === 0" class="chat-body chat-state">
        <div class="stack" style="align-items: center">
          <span class="muted">聊天记录加载失败：{{ error }}</span>
          <button class="btn btn-sm" @click="loadHistory()">重试</button>
        </div>
      </div>
      <div v-else-if="messages.length === 0" class="chat-body chat-state">
        <span class="faint">还没有人说话。跟房间里的朋友打个招呼吧。</span>
      </div>
      <div v-else ref="scroller" class="chat-body" @scroll="onScroll">
        <template v-for="m in messages" :key="m.id">
          <!-- 系统消息：居中、暗色、不带头像 -->
          <div v-if="m.kind === 'system'" class="chat-system">
            <span>{{ m.body }}</span>
            <span class="faint">· {{ formatRelativeTime(m.createdAt, now) }}</span>
          </div>
          <div v-else class="chat-line" :class="m.userId === selfId ? 'chat-mine' : 'chat-theirs'">
            <div class="chat-bubble" :class="m.userId === selfId ? 'chat-bubble-mine' : 'chat-bubble-theirs'">
              <div class="chat-meta">
                <span class="chat-name">{{ m.displayName }}</span>
                <span v-if="m.role === 'host'" class="badge badge-brand">房主</span>
                <span class="faint">{{ formatRelativeTime(m.createdAt, now) }}</span>
              </div>
              <div class="chat-text">{{ m.body }}</div>
            </div>
            <button v-if="canDelete(m)" class="btn btn-sm btn-ghost chat-del" title="删除这条消息" @click="remove(m)">
              删除
            </button>
          </div>
        </template>
      </div>

      <div class="chat-editor">
        <textarea
          ref="input"
          v-model="draft"
          class="input chat-input"
          rows="2"
          :maxlength="maxChars"
          placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
          :disabled="sending"
          @keydown.enter.exact.prevent="send"
        />
        <div class="chat-actions">
          <button class="btn btn-sm btn-ghost" type="button" @click="emojiOpen = !emojiOpen">表情</button>
          <span class="grow" />
          <span class="hint" :class="{ danger: charsLeft < 60 }">{{ charsLeft }} 字可用</span>
          <button class="btn btn-primary btn-sm" :disabled="!canSend" @click="send">
            <span v-if="sending" class="spinner" />
            <span>{{ sending ? '发送中…' : '发送' }}</span>
          </button>
        </div>
        <div v-if="emojiOpen" class="chat-emoji">
          <button v-for="e in EMOJIS" :key="e" class="chat-emoji-btn" type="button" @click="insertEmoji(e)">
            {{ e }}
          </button>
        </div>
      </div>

      <div class="hint" style="margin-top: 8px">
        消息只保存在服务器上（每房间最多保留最近 {{ keepPerRoom }} 条，单条最多 {{ maxChars }} 字符，每人每分钟 20 条）。
        房主可以删除房间里的任意消息。
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-body {
  height: 300px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--well);
}
.chat-state {
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
}
.chat-system {
  align-self: center;
  max-width: 84%;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-faint);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px var(--s-3);
}
.chat-line {
  display: flex;
  align-items: flex-end;
  gap: var(--s-2);
  max-width: 100%;
}
.chat-mine {
  flex-direction: row-reverse;
}
.chat-bubble {
  max-width: min(78%, 620px);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  white-space: pre-wrap;
  word-break: break-word;
}
.chat-bubble-mine {
  border-color: var(--signal-line);
  background: var(--signal-wash);
}
.chat-bubble-theirs {
  background: var(--surface-hair-strong);
}
.chat-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  margin-bottom: 2px;
}
.chat-name {
  color: var(--text-dim);
  font-weight: 560;
}
.chat-text {
  font-size: var(--fs-sm);
  user-select: text;
}
.chat-del {
  opacity: 0.55;
}
.chat-line:hover .chat-del {
  opacity: 1;
}
.chat-editor {
  margin-top: var(--s-3);
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.chat-input {
  height: auto;
  min-height: 56px;
  padding: var(--s-2) var(--s-3);
  resize: vertical;
  line-height: 1.5;
}
.chat-actions {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.chat-emoji {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: var(--s-2);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--well);
}
.chat-emoji-btn {
  width: 30px;
  height: 30px;
  border-radius: var(--r-xs);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  font-size: 17px;
  line-height: 1;
}
.chat-emoji-btn:hover {
  background: var(--surface-strong);
  border-color: var(--border-strong);
}
.danger {
  color: var(--danger);
}
</style>
