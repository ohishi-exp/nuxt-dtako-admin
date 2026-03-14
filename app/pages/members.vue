<script setup lang="ts">
import type { TenantMember } from '~/types'
import { getMembers, inviteMember, updateMemberRole, deleteMember } from '~/utils/api'

const { user } = useAuth()

const members = ref<TenantMember[]>([])
const loading = ref(false)
const error = ref('')

// 招待フォーム
const showInvite = ref(false)
const newEmail = ref('')
const newRole = ref('member')
const inviting = ref(false)

// ロール変更中
const updatingEmail = ref<string | null>(null)

// 削除中
const removingEmail = ref<string | null>(null)

const isAdmin = computed(() => user.value?.role === 'admin')

const roleOptions = [
  { label: 'Admin', value: 'admin' },
  { label: 'Member', value: 'member' },
]

async function fetchData() {
  loading.value = true
  error.value = ''
  try {
    members.value = await getMembers()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'データの取得に失敗しました'
  } finally {
    loading.value = false
  }
}

async function handleInvite() {
  if (!newEmail.value.trim()) return
  inviting.value = true
  error.value = ''
  try {
    await inviteMember(newEmail.value.trim(), newRole.value)
    showInvite.value = false
    newEmail.value = ''
    newRole.value = 'member'
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'メンバーの招待に失敗しました'
  } finally {
    inviting.value = false
  }
}

async function handleRoleChange(email: string, role: string) {
  updatingEmail.value = email
  error.value = ''
  try {
    await updateMemberRole(email, role)
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'ロールの変更に失敗しました'
  } finally {
    updatingEmail.value = null
  }
}

async function handleRemove(email: string) {
  if (!confirm(`${email} を組織から削除しますか？`)) return
  removingEmail.value = email
  error.value = ''
  try {
    await deleteMember(email)
    await fetchData()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'メンバーの削除に失敗しました'
  } finally {
    removingEmail.value = null
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

onMounted(fetchData)
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-xl font-bold">メンバー管理</h2>
      <div class="flex gap-2">
        <UButton
          v-if="isAdmin"
          icon="i-lucide-user-plus"
          label="メンバー招待"
          size="sm"
          @click="showInvite = true"
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

    <!-- 招待フォーム -->
    <div v-if="showInvite" class="mb-4 p-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg">
      <h3 class="text-sm font-medium mb-3">メンバー招待</h3>
      <div class="flex items-end gap-3">
        <div class="flex-1">
          <label class="block text-xs text-gray-500 mb-1">メールアドレス</label>
          <input
            v-model="newEmail"
            type="email"
            placeholder="user@example.com"
            class="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
            @keyup.enter="handleInvite"
          />
        </div>
        <div class="w-40">
          <label class="block text-xs text-gray-500 mb-1">ロール</label>
          <USelect
            v-model="newRole"
            :items="roleOptions"
            size="sm"
          />
        </div>
        <UButton
          label="招待"
          size="sm"
          :loading="inviting"
          :disabled="!newEmail.trim()"
          @click="handleInvite"
        />
        <UButton
          label="キャンセル"
          variant="ghost"
          size="sm"
          @click="showInvite = false"
        />
      </div>
    </div>

    <!-- メンバー一覧 -->
    <div class="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
            <th class="text-left px-4 py-3 font-medium">メールアドレス</th>
            <th class="text-left px-4 py-3 font-medium">ロール</th>
            <th class="text-left px-4 py-3 font-medium">追加日</th>
            <th v-if="isAdmin" class="text-left px-4 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr>
            <td :colspan="isAdmin ? 4 : 3" class="px-4 py-8 text-center text-gray-500">
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin mr-2" />
              読み込み中...
            </td>
          </tr>
        </tbody>
        <tbody v-else-if="members.length === 0">
          <tr>
            <td :colspan="isAdmin ? 4 : 3" class="px-4 py-8 text-center text-gray-500">
              メンバーがいません
            </td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr
            v-for="member in members"
            :key="member.email"
            class="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/30"
          >
            <td class="px-4 py-3">
              {{ member.email }}
              <span v-if="member.email === user?.email" class="ml-1 text-xs text-gray-400">(自分)</span>
            </td>
            <td class="px-4 py-3">
              <USelect
                v-if="isAdmin && member.email !== user?.email"
                :model-value="member.role"
                :items="roleOptions"
                size="xs"
                class="w-28"
                :loading="updatingEmail === member.email"
                @update:model-value="(val: string) => handleRoleChange(member.email, val)"
              />
              <span v-else class="text-xs font-medium px-2 py-1 rounded-full"
                :class="member.role === 'admin'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'"
              >
                {{ member.role }}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-500">{{ formatDate(member.created_at) }}</td>
            <td v-if="isAdmin" class="px-4 py-3">
              <UButton
                v-if="member.email !== user?.email"
                label="削除"
                icon="i-lucide-trash-2"
                variant="ghost"
                color="error"
                size="xs"
                :loading="removingEmail === member.email"
                @click="handleRemove(member.email)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
