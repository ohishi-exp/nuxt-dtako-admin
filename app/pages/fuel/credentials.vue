<script setup lang="ts">
/**
 * 給油データ USB アップローダー (Windows アプリ) の資格情報 (purpose `fuel-utran`) の発行・一覧・
 * rotate・失効 (Refs yhonda-ohishi/nginx#814)。以前は nuxt-leave の設定画面 (purpose `leave-scan` 固定)
 * にしか発行の口が無かった。
 *
 * auth-worker を画面のブラウザから直接呼ぶ (`useMachineCredentialApi`)。password は発行・rotate の
 * 応答で 1 回だけ返るので、閉じるまでモーダルに出し、閉じたら捨てる。
 */
import {
  LABEL_MAX,
  ONE_TIME_NOTICE,
  credentialErrorText,
  formatIssuedDate,
  labelError,
  sortCredentials,
  type IssuedCredential,
  type MachineCredential,
} from '~/utils/machine-credentials'

const api = useMachineCredentialApi()

const creds = ref<MachineCredential[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)

const newLabel = ref('')
const newLabelError = ref<string | null>(null)
const issuing = ref(false)

/** 発行・rotate の応答。閉じたら null に戻して password を捨てる */
const shown = ref<IssuedCredential | null>(null)
const copied = ref<'username' | 'password' | null>(null)

type Pending = { kind: 'rotate' | 'revoke', cred: MachineCredential }
const pending = ref<Pending | null>(null)
const acting = ref(false)

async function load() {
  loading.value = true
  listError.value = null
  try {
    creds.value = sortCredentials(await api.list())
  }
  catch (e) {
    creds.value = []
    listError.value = credentialErrorText(e, 'ページを再読み込みしてください')
  }
  finally {
    loading.value = false
  }
}

async function issue() {
  newLabelError.value = labelError(newLabel.value)
  if (newLabelError.value) return
  issuing.value = true
  actionError.value = null
  try {
    shown.value = await api.issue(newLabel.value)
    newLabel.value = ''
    await load()
  }
  catch (e) {
    actionError.value = credentialErrorText(e, 'もう一度「発行」を押してください')
  }
  finally {
    issuing.value = false
  }
}

async function confirmPending() {
  const p = pending.value
  if (!p) return
  acting.value = true
  actionError.value = null
  try {
    if (p.kind === 'rotate') shown.value = await api.rotate(p.cred.username)
    else await api.revoke(p.cred.username)
    pending.value = null
    await load()
  }
  catch (e) {
    pending.value = null
    const retry = p.kind === 'rotate' ? 'もう一度「パスワードを再発行」を押してください' : 'もう一度「失効」を押してください'
    actionError.value = `${p.cred.label} (${p.cred.username}): ${credentialErrorText(e, retry, true)}`
  }
  finally {
    acting.value = false
  }
}

async function copy(which: 'username' | 'password') {
  if (!shown.value) return
  try {
    await navigator.clipboard.writeText(shown.value[which])
    copied.value = which
  }
  catch {
    /* clipboard が使えない環境は手で選んでコピーしてもらう */
  }
}

function closeShown() {
  shown.value = null
  copied.value = null
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-xl font-bold mr-auto">給油アップローダーの資格情報</h2>
      <UButton to="/fuel/intank" icon="i-lucide-fuel" variant="outline" label="インタンク燃料確認" />
    </div>

    <p class="text-sm text-gray-600 dark:text-gray-400">
      Windows アプリ (給油データ USB アップローダー) が送信に使う username / password です。PC ごとに発行してください。
    </p>

    <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="資格情報の一覧を読めませんでした" :description="listError" />
    <UAlert v-if="actionError" color="error" variant="subtle" icon="i-lucide-alert-triangle" :description="actionError" />

    <div class="flex flex-wrap items-end gap-2">
      <UFormField label="PC 名" :error="newLabelError ?? undefined" :description="`どの PC 用か分かる名前 (${LABEL_MAX} 文字まで)`">
        <UInput v-model="newLabel" placeholder="例: 本社 給油室の PC" class="w-64" />
      </UFormField>
      <UButton label="発行" icon="i-lucide-key-round" :loading="issuing" @click="issue" />
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
    </div>
    <div v-else class="overflow-x-auto">
      <table class="cred-table">
        <thead>
          <tr><th>PC 名</th><th>username</th><th>作成日</th><th>状態</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="c in creds" :key="c.username" :class="{ 'text-gray-400': c.revoked }">
            <td>{{ c.label }}</td>
            <td class="font-mono">{{ c.username }}</td>
            <td>{{ formatIssuedDate(c.created_at) }}</td>
            <td>
              <UBadge v-if="c.revoked" label="失効済み" color="neutral" variant="subtle" />
              <UBadge v-else label="有効" color="success" variant="subtle" />
            </td>
            <td class="whitespace-nowrap">
              <template v-if="!c.revoked">
                <UButton size="xs" variant="outline" label="パスワードを再発行" @click="pending = { kind: 'rotate', cred: c }" />
                <UButton size="xs" color="error" variant="outline" label="失効" class="ml-1" @click="pending = { kind: 'revoke', cred: c }" />
              </template>
            </td>
          </tr>
          <tr v-if="creds.length === 0 && !listError">
            <td colspan="5" class="text-center text-gray-500">発行した資格情報はありません</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- rotate・失効の確認 -->
    <UModal :open="pending !== null" @update:open="(v: boolean) => { if (!v) pending = null }">
      <template #content>
        <div v-if="pending" class="p-6 space-y-4">
          <h3 class="text-lg font-bold">{{ pending.kind === 'rotate' ? 'パスワードの再発行' : '資格情報の失効' }}</h3>
          <p v-if="pending.kind === 'rotate'" class="text-gray-600 dark:text-gray-400">
            {{ pending.cred.label }} ({{ pending.cred.username }}) のパスワードを作り直しますか？今のパスワードはすぐ使えなくなり、PC に新しいパスワードを入れ直すまで送信できません。
          </p>
          <p v-else class="text-gray-600 dark:text-gray-400">
            {{ pending.cred.label }} ({{ pending.cred.username }}) を失効しますか？この PC からは送信できなくなります。この操作は取り消せません。
          </p>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="pending = null" />
            <UButton
              :label="pending.kind === 'rotate' ? 'パスワードを再発行' : '失効'"
              :color="pending.kind === 'rotate' ? 'primary' : 'error'"
              :loading="acting"
              @click="confirmPending"
            />
          </div>
        </div>
      </template>
    </UModal>

    <!-- 発行・rotate の応答 (1 回だけ) -->
    <UModal :open="shown !== null" :dismissible="false" @update:open="(v: boolean) => { if (!v) closeShown() }">
      <template #content>
        <div v-if="shown" class="p-6 space-y-4">
          <h3 class="text-lg font-bold">資格情報</h3>
          <UAlert color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="ONE_TIME_NOTICE" />
          <dl class="space-y-2">
            <div v-for="key in (['username', 'password'] as const)" :key="key" class="flex items-center gap-2">
              <dt class="w-24 text-sm text-gray-500">{{ key }}</dt>
              <dd class="flex-1 font-mono break-all select-all">{{ shown[key] }}</dd>
              <UButton
                size="xs"
                variant="outline"
                :icon="copied === key ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copied === key ? 'コピーしました' : 'コピー'"
                @click="copy(key)"
              />
            </div>
          </dl>
          <div class="flex justify-end">
            <UButton label="閉じる" @click="closeShown" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.cred-table { border-collapse: collapse; font-size: 0.875rem; }
.cred-table th, .cred-table td { border: 1px solid rgb(209 213 219); padding: 0.25rem 0.5rem; }
.cred-table th { background: rgb(243 244 246); text-align: left; }
:global(.dark) .cred-table th { background: rgb(31 41 55); }
:global(.dark) .cred-table th, :global(.dark) .cred-table td { border-color: rgb(55 65 81); }
</style>
