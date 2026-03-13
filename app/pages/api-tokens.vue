<script setup lang="ts">
import type { ApiTokenListItem } from '~/types'
import { getApiTokens, createApiToken, revokeApiToken } from '~/utils/api'

const items = ref<ApiTokenListItem[]>([])
const loading = ref(false)
const error = ref('')

// 作成フォーム
const showCreate = ref(false)
const newName = ref('')
const newExpiryDays = ref<number | undefined>(undefined)
const creating = ref(false)

// 作成直後のトークン表示
const createdToken = ref('')
const copied = ref(false)

// 失効中
const revoking = ref<string | null>(null)

async function fetchData() {
  loading.value = true
  error.value = ''
  try {
    items.value = await getApiTokens()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'データの取得に失敗しました'
  } finally {
    loading.value = false
  }
}

async function handleCreate() {
  if (!newName.value.trim()) return
  creating.value = true
  error.value = ''
  try {
    const res = await createApiToken(newName.value.trim(), newExpiryDays.value)
    createdToken.value = res.token
    copied.value = false
    showCreate.value = false
    newName.value = ''
    newExpiryDays.value = undefined
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'トークンの作成に失敗しました'
  } finally {
    creating.value = false
  }
}

async function handleRevoke(id: string) {
  if (!confirm('このトークンを失効させますか？')) return
  revoking.value = id
  error.value = ''
  try {
    await revokeApiToken(id)
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'トークンの失効に失敗しました'
  } finally {
    revoking.value = null
  }
}

async function copyToken() {
  await navigator.clipboard.writeText(createdToken.value)
  copied.value = true
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function tokenStatus(item: ApiTokenListItem): { label: string; color: string } {
  if (item.revoked_at) return { label: '失効済み', color: 'text-red-500' }
  if (item.expires_at && new Date(item.expires_at) < new Date()) return { label: '期限切れ', color: 'text-orange-500' }
  return { label: '有効', color: 'text-green-600' }
}

onMounted(fetchData)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold">APIトークン管理</h2>
      <div class="flex gap-2">
        <UButton
          icon="i-lucide-plus"
          label="新規トークン"
          size="sm"
          @click="showCreate = true"
        />
        <UButton
          icon="i-lucide-refresh-cw"
          label="再読み込み"
          variant="ghost"
          size="sm"
          :loading="loading"
          @click="fetchData"
        />
      </div>
    </div>

    <UAlert v-if="error" color="error" :title="error" class="mb-4" />

    <!-- 作成直後のトークン表示 -->
    <div v-if="createdToken" class="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
      <p class="text-sm font-medium text-yellow-800 dark:text-yellow-200 mb-2">
        トークンが作成されました。このトークンは再表示できません。コピーして安全な場所に保管してください。
      </p>
      <div class="flex items-center gap-2">
        <code class="flex-1 text-xs bg-white dark:bg-gray-900 p-2 rounded border border-yellow-300 dark:border-yellow-700 break-all select-all">
          {{ createdToken }}
        </code>
        <UButton
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :label="copied ? 'コピー済み' : 'コピー'"
          size="sm"
          :variant="copied ? 'soft' : 'solid'"
          @click="copyToken"
        />
      </div>
      <UButton
        label="閉じる"
        variant="ghost"
        size="xs"
        class="mt-2"
        @click="createdToken = ''"
      />
    </div>

    <!-- 作成フォーム -->
    <div v-if="showCreate" class="mb-4 p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg">
      <h3 class="text-sm font-medium mb-3">新規APIトークン</h3>
      <div class="flex items-end gap-3">
        <div class="flex-1">
          <label class="block text-xs text-gray-500 mb-1">トークン名</label>
          <input
            v-model="newName"
            type="text"
            placeholder="例: 外部連携用"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            @keyup.enter="handleCreate"
          />
        </div>
        <div class="w-40">
          <label class="block text-xs text-gray-500 mb-1">有効期限（日数）</label>
          <input
            v-model.number="newExpiryDays"
            type="number"
            placeholder="無期限"
            min="1"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
          />
        </div>
        <UButton
          label="作成"
          size="sm"
          :loading="creating"
          :disabled="!newName.trim()"
          @click="handleCreate"
        />
        <UButton
          label="キャンセル"
          variant="ghost"
          size="sm"
          @click="showCreate = false"
        />
      </div>
    </div>

    <!-- トークン一覧 -->
    <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
            <th class="text-left px-4 py-3 font-medium">名前</th>
            <th class="text-left px-4 py-3 font-medium">トークン</th>
            <th class="text-left px-4 py-3 font-medium">状態</th>
            <th class="text-left px-4 py-3 font-medium">有効期限</th>
            <th class="text-left px-4 py-3 font-medium">最終利用</th>
            <th class="text-left px-4 py-3 font-medium">作成日</th>
            <th class="text-left px-4 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr>
            <td colspan="7" class="px-4 py-8 text-center text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin mr-2" />
              読み込み中...
            </td>
          </tr>
        </tbody>
        <tbody v-else-if="items.length === 0">
          <tr>
            <td colspan="7" class="px-4 py-8 text-center text-gray-500">
              トークンがありません
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr
            v-for="item in items"
            :key="item.id"
            class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30"
            :class="{ 'opacity-50': item.revoked_at }"
          >
            <td class="px-4 py-3 font-medium">{{ item.name }}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ item.token_prefix }}...</td>
            <td class="px-4 py-3">
              <span class="text-xs font-medium" :class="tokenStatus(item).color">
                {{ tokenStatus(item).label }}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-500">{{ formatDate(item.expires_at) }}</td>
            <td class="px-4 py-3 text-gray-500">{{ formatDate(item.last_used_at) }}</td>
            <td class="px-4 py-3 text-gray-500">{{ formatDate(item.created_at) }}</td>
            <td class="px-4 py-3">
              <UButton
                v-if="!item.revoked_at"
                label="失効"
                icon="i-lucide-ban"
                variant="ghost"
                color="error"
                size="xs"
                :loading="revoking === item.id"
                @click="handleRevoke(item.id)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
