<script setup lang="ts">
/**
 * 機械が Basic で名乗る資格情報の発行・一覧・rotate・失効 (Refs yhonda-ohishi/nginx#814, #1287)。
 * 用途 (`purpose`) は置く画面が固定で渡す — `/fuel/credentials` は `fuel-utran`、`/etc-cards` は `etc-scan`。
 * 画面の中で用途を切り替えない (給油の画面から ETC の資格情報を出さない)。
 *
 * auth-worker を画面のブラウザから直接呼ぶ (`useMachineCredentialApi`)。password は発行・rotate の
 * 応答で 1 回だけ返るので、閉じるまでモーダルに出し、閉じたら捨てる。`etc-scan` はそこに複合機の
 * 設定例 (WebDAV のホスト名・フォルダ・PC から試す curl) も並べる。
 */
import {
  LABEL_MAX,
  PURPOSE_TEXT,
  credentialErrorText,
  deviceSetupFor,
  deviceSetupRows,
  formatIssuedDate,
  issueErrorText,
  labelError,
  sortCredentials,
  type IssuedCredential,
  type MachineCredential,
  type Purpose,
} from '~/utils/machine-credentials'

const props = defineProps<{ purpose: Purpose }>()

const text = computed(() => PURPOSE_TEXT[props.purpose])
const api = useMachineCredentialApi(() => props.purpose)
const authWorkerUrl = String(useRuntimeConfig().public.authWorkerUrl ?? '')

const creds = ref<MachineCredential[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)
const actionError = ref<string | null>(null)

const newLabel = ref('')
const newLabelError = ref<string | null>(null)
const issuing = ref(false)

/** 発行・rotate の応答。閉じたら null に戻して password を捨てる */
const shown = ref<IssuedCredential | null>(null)
/** 発行直後に出す行 (fuel-utran は username / password、etc-scan は複合機の設定例) */
const shownRows = computed<[string, string][]>(() => {
  if (!shown.value) return []
  const setup = deviceSetupFor(props.purpose, authWorkerUrl, shown.value)
  return setup ? deviceSetupRows(setup) : [['username', shown.value.username], ['password', shown.value.password]]
})
const shownCurl = computed(() => shown.value ? deviceSetupFor(props.purpose, authWorkerUrl, shown.value)?.curl ?? null : null)
const copied = ref<string | null>(null)

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
  newLabelError.value = labelError(newLabel.value, text.value.nameLabel)
  if (newLabelError.value) return
  issuing.value = true
  actionError.value = null
  try {
    shown.value = await api.issue(newLabel.value)
    newLabel.value = ''
    await load()
  }
  catch (e) {
    actionError.value = issueErrorText(e)
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

async function copy(key: string, value: string) {
  try {
    await navigator.clipboard.writeText(value)
    copied.value = key
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
  <div class="space-y-4" :data-purpose="purpose">
    <p class="text-sm text-muted">{{ text.intro }}</p>

    <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="資格情報の一覧を読めませんでした" :description="listError" />
    <UAlert v-if="actionError" color="error" variant="subtle" icon="i-lucide-alert-triangle" :description="actionError" />

    <p class="text-sm text-muted">{{ text.guide }}</p>
    <div class="flex flex-wrap items-end gap-2">
      <UFormField :label="text.nameLabel" :error="newLabelError ?? undefined" :description="`${text.nameHint} (${LABEL_MAX} 文字まで)`">
        <UInput v-model="newLabel" :placeholder="text.namePlaceholder" class="w-64" />
      </UFormField>
      <UButton label="発行" icon="i-lucide-key-round" :loading="issuing" @click="issue" />
    </div>

    <div v-if="loading" class="flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
    </div>
    <div v-else class="overflow-x-auto">
      <table class="cred-table">
        <thead>
          <tr><th>{{ text.nameLabel }}</th><th>username</th><th>作成日</th><th>状態</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="c in creds" :key="c.username" :class="{ 'text-dimmed': c.revoked }">
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
            <td colspan="5" class="text-center text-muted">発行した資格情報はありません</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- rotate・失効の確認 -->
    <UModal :open="pending !== null" @update:open="(v: boolean) => { if (!v) pending = null }">
      <template #content>
        <div v-if="pending" class="p-6 space-y-4">
          <h3 class="text-lg font-bold">{{ pending.kind === 'rotate' ? 'パスワードの再発行' : '資格情報の失効' }}</h3>
          <p v-if="pending.kind === 'rotate'" class="text-muted">
            {{ pending.cred.label }} ({{ pending.cred.username }}) のパスワードを作り直しますか？今のパスワードはすぐ使えなくなり、{{ text.rotateNote }}
          </p>
          <p v-else class="text-muted">
            {{ pending.cred.label }} ({{ pending.cred.username }}) を失効しますか？{{ text.revokeNote }}この操作は取り消せません。
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
        <div v-if="shown" class="p-6 space-y-4" data-testid="issued-credential">
          <h3 class="text-lg font-bold">{{ shownCurl ? '複合機の設定' : '資格情報' }}</h3>
          <UAlert color="warning" variant="subtle" icon="i-lucide-triangle-alert" :description="text.notice" />
          <dl class="space-y-2">
            <div v-for="[k, v] in shownRows" :key="k" class="flex items-center gap-2">
              <dt class="w-32 text-sm text-muted">{{ k }}</dt>
              <dd class="flex-1 font-mono break-all select-all">{{ v }}</dd>
              <UButton
                size="xs"
                variant="outline"
                :icon="copied === k ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copied === k ? 'コピーしました' : 'コピー'"
                @click="copy(k, v)"
              />
            </div>
          </dl>
          <template v-if="shownCurl">
            <h4 class="font-medium text-sm">PC から試す</h4>
            <div class="flex items-center gap-2">
              <code class="flex-1 text-xs break-all select-all" data-testid="issued-curl">{{ shownCurl }}</code>
              <UButton
                size="xs"
                variant="outline"
                :icon="copied === 'curl' ? 'i-lucide-check' : 'i-lucide-copy'"
                :label="copied === 'curl' ? 'コピーしました' : 'コピー'"
                @click="copy('curl', shownCurl)"
              />
            </div>
          </template>
          <div class="flex justify-end">
            <UButton label="閉じる" @click="closeShown" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* /fuel/cards と同じ表 (固定色を持たず Nuxt UI のトークンに乗るので、ダークでも白地にならない) */
.cred-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}
.cred-table th,
.cred-table td {
  border: 1px solid var(--ui-border);
  padding: 2px 4px;
  white-space: nowrap;
}
.cred-table th {
  text-align: left;
}
</style>
