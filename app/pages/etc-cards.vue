<script setup lang="ts">
/**
 * ETC コーポレートカードの登録待ち (Refs #1287)。複合機でスキャンした「ETC コーポレートカード発行明細書」を
 * OCR した行 (D1 `etc_card_registrations`) を出し、
 *   - 要確認 (4 項目のどれかが読めなかった行) を手で直して保存 (揃えば「走行待ち」へ)
 *   - OCR に失敗した scan の「再 OCR」
 *   - 行ごとの「今すぐ登録」(relay へ転送。走行日の照合と etc-meisai.jp への登録は relay の担当)
 *   - 走行待ちの行の「走行日を探し直す」(relay がその車の運行ごとに theearth から zip を取り直して走行日を探す。
 *     202 で受けて後で回すので、結果は再読み込みで見る)
 *   - 行ごとの「登録日」(空なら受信日)。relay はこの日より前の走行を、そのカードの利用日にしない
 *   - ヘッダの「ETC アカウントを取り直す」(ETC 明細 CSV の取得を cron と同じ道で 1 回走らせ、各アカウントの
 *     法人/個人の種別を relay に記録し直させる。「今すぐ登録」の担当判定に使われる)
 * カード番号は末尾 5 桁しか受け取らない (API が全桁を返さない)。
 * 下に複合機の資格情報 (purpose `etc-scan`) の発行・一覧を置く (部品 `MachineCredentials`、`/fuel/credentials` と共有)。
 */
import { currentAccessToken } from '~/utils/api'
import { describeCaughtError } from '~/utils/api-error'
import {
  CARD_NUMBER_DIGITS,
  KUBUN,
  OBU_NUMBER_DIGITS,
  STATUSES,
  STATUS_LABEL,
  canRegister,
  canRescan,
  countByStatus,
  RESCAN_ACCEPTED_TEXT,
  etcCardErrorText,
  formatBytes,
  maskedCard,
  receivedDate,
  type EtcCardStatus,
  type EtcCardView,
  type EtcCardsResponse,
  type EtcScanView,
} from '~/utils/etc-cards'
import { formatIssuedDate } from '~/utils/machine-credentials'

const rows = ref<EtcCardView[]>([])
const failedScans = ref<EtcScanView[]>([])
const loading = ref(false)
const listError = ref<string | null>(null)
/** 行・scan ごとの操作の結果 (成功も失敗も、その行の下に出す) */
const notes = ref<Record<string, { ok: boolean, text: string }>>({})
/** 再 OCR の結果。読めた scan は一覧から消えるので、行ではなく表の上に出す */
const scanNotice = ref<{ ok: boolean, text: string } | null>(null)
const busy = ref<string | null>(null)
const filter = ref<EtcCardStatus | 'all'>('all')
const KUBUN_ITEMS: string[] = [...KUBUN]

const counts = computed(() => countByStatus(rows.value))
const shown = computed(() => filter.value === 'all' ? rows.value : rows.value.filter(r => r.status === filter.value))

function authHeaders(): Record<string, string> {
  const t = currentAccessToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

/** 行ごとの登録日の入力欄 (id → 入力中の文字列)。読み込みのたびに保存済みの値で作り直す */
const regDraft = ref<Record<number, string>>({})

async function load() {
  loading.value = true
  listError.value = null
  try {
    const res = await $fetch<EtcCardsResponse>('/api/etc-cards', { headers: authHeaders() })
    rows.value = res.registrations
    failedScans.value = res.failed_scans
    regDraft.value = Object.fromEntries(res.registrations.map(r => [r.id, r.registration_date ?? '']))
  }
  catch (e) {
    rows.value = []
    failedScans.value = []
    listError.value = etcCardErrorText(e, 'ページを再読み込みしてください')
  }
  finally {
    loading.value = false
  }
}

// ---- 要確認の手直し ----
const editing = ref<EtcCardView | null>(null)
const form = reactive({ kubun: '', card_number: '', vehicle_number: '', obu_number: '' })
const editError = ref<string | null>(null)

function openEdit(r: EtcCardView) {
  editing.value = r
  form.kubun = r.kubun ?? ''
  form.card_number = ''
  form.vehicle_number = r.vehicle_number ?? ''
  form.obu_number = r.obu_number ?? ''
  editError.value = null
}

async function saveEdit() {
  const r = editing.value
  if (!r) return
  busy.value = `edit-${r.id}`
  editError.value = null
  try {
    const after = await $fetch<EtcCardView>(`/api/etc-cards/${r.id}`, { method: 'PATCH', body: { ...form }, headers: authHeaders() })
    editing.value = null
    notes.value[`row-${r.id}`] = { ok: true, text: `保存しました (${STATUS_LABEL[after.status]})` }
    await load()
  }
  catch (e) {
    // 400 の本文 (`data.error`) は入力の何が違うかの文
    const msg = (e as { data?: { data?: { error?: unknown } } })?.data?.data?.error
    editError.value = typeof msg === 'string' ? msg : etcCardErrorText(e, 'もう一度「保存」を押してください')
  }
  finally {
    busy.value = null
  }
}

// ---- 登録日 ----
function regDateChanged(r: EtcCardView): boolean {
  return (regDraft.value[r.id] ?? '').trim() !== (r.registration_date ?? '')
}

async function saveRegDate(r: EtcCardView) {
  busy.value = `regdate-${r.id}`
  try {
    const after = await $fetch<EtcCardView>(`/api/etc-cards/${r.id}/registration-date`, {
      method: 'PATCH',
      body: { registration_date: (regDraft.value[r.id] ?? '').trim() || null },
      headers: authHeaders(),
    })
    notes.value[`row-${r.id}`] = {
      ok: true,
      text: `登録日を ${after.registration_date ?? `空 (受信日 ${receivedDate(after.received_at)})`} にしました。走行日は探し直します (${STATUS_LABEL[after.status]})`,
    }
    await load()
  }
  catch (e) {
    const msg = (e as { data?: { data?: { error?: unknown } } })?.data?.data?.error
    notes.value[`row-${r.id}`] = { ok: false, text: `登録日を保存できませんでした: ${typeof msg === 'string' ? msg : etcCardErrorText(e, 'もう一度「保存」を押してください')}` }
  }
  finally {
    busy.value = null
  }
}

// ---- 再 OCR ----
async function reOcr(s: EtcScanView) {
  busy.value = `scan-${s.sha256}`
  scanNotice.value = null
  try {
    const res = await $fetch<{ ok: boolean, row_count?: number, inserted?: number, error?: string }>(
      `/api/etc-cards/scans/${s.sha256}/ocr`, { method: 'POST', headers: authHeaders() })
    const label = `${formatIssuedDate(s.received_at)} の ${s.sha256.slice(0, 12)}`
    scanNotice.value = res.ok
      ? { ok: true, text: `${label} を読めました: ${res.row_count} 行 (新しく足したのは ${res.inserted} 行。同じカード番号が既にある行は足していません)` }
      : { ok: false, text: `${label} はまた読めませんでした (${res.error})` }
    await load()
  }
  catch (e) {
    scanNotice.value = { ok: false, text: etcCardErrorText(e, 'もう一度「再 OCR」を押してください') }
  }
  finally {
    busy.value = null
  }
}

// ---- 今すぐ登録 ----
async function register(r: EtcCardView) {
  busy.value = `reg-${r.id}`
  try {
    await $fetch(`/api/etc-cards/${r.id}/register`, { method: 'POST', body: {}, headers: authHeaders() })
    notes.value[`row-${r.id}`] = { ok: true, text: '登録の処理を受け付けました' }
    await load()
  }
  catch (e) {
    notes.value[`row-${r.id}`] = { ok: false, text: `登録できませんでした: ${etcCardErrorText(e, 'もう一度「今すぐ登録」を押してください')}` }
  }
  finally {
    busy.value = null
  }
}

// ---- ETC アカウントを取り直す ----
/** 結果は行ではなくページ上部に出す (どの行の操作でもないため) */
const recheckNotice = ref<{ ok: boolean, text: string } | null>(null)

async function recheckAccounts() {
  busy.value = 'recheck'
  recheckNotice.value = null
  try {
    const res = await $fetch<{ total: number, ok: number }>('/api/etc-cards/accounts-recheck', { method: 'POST', body: {}, headers: authHeaders() })
    recheckNotice.value = {
      ok: res.ok === res.total,
      text: `ETC アカウント ${res.total} 件中 ${res.ok} 件で取り直しを受け付けました (ログインは裏で走ります)。`
        + '1〜2 分おいてから、もう一度「今すぐ登録」を押してください',
    }
  }
  catch (e) {
    recheckNotice.value = { ok: false, text: `取り直せませんでした: ${describeCaughtError(e, 'もう一度「ETC アカウントを取り直す」を押してください')}` }
  }
  finally {
    busy.value = null
  }
}

// ---- 走行日を探し直す ----
async function rescan(r: EtcCardView) {
  busy.value = `rescan-${r.id}`
  try {
    await $fetch(`/api/etc-cards/${r.id}/rescan`, { method: 'POST', body: {}, headers: authHeaders() })
    notes.value[`row-${r.id}`] = { ok: true, text: RESCAN_ACCEPTED_TEXT }
  }
  catch (e) {
    notes.value[`row-${r.id}`] = { ok: false, text: `探し直せませんでした: ${etcCardErrorText(e, 'もう一度「走行日を探し直す」を押してください')}` }
  }
  finally {
    busy.value = null
  }
}

const statusColor: Record<EtcCardStatus, 'warning' | 'neutral' | 'info' | 'success' | 'error'> = {
  needs_review: 'warning',
  waiting_run: 'neutral',
  dry_run_ok: 'info',
  registered: 'success',
  failed: 'error',
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-xl font-bold mr-auto">ETC カード登録</h2>
      <UButton to="#machine-credentials" icon="i-lucide-key-round" variant="outline" label="複合機の資格情報" />
      <UButton
        icon="i-lucide-user-round-search"
        variant="outline"
        label="ETC アカウントを取り直す"
        :loading="busy === 'recheck'"
        :disabled="busy !== null"
        data-testid="accounts-recheck"
        @click="recheckAccounts"
      />
      <UButton icon="i-lucide-refresh-cw" variant="outline" label="再読み込み" :loading="loading" @click="load" />
    </div>

    <p class="text-sm text-muted">
      複合機でスキャンした「ETC コーポレートカード発行明細書」から読んだカードです。カードで初めて走行した日が運行データに出たら、etc-meisai.jp へ登録します。
      登録日 (空なら受信日) より前の走行は使いません。
      読めなかった項目がある行は「要確認」になります。直して保存すると「走行待ち」になります。
    </p>

    <UAlert
      v-if="recheckNotice"
      :color="recheckNotice.ok ? 'success' : 'error'"
      variant="subtle"
      :icon="recheckNotice.ok ? 'i-lucide-check' : 'i-lucide-alert-triangle'"
      :description="recheckNotice.text"
      data-testid="recheck-notice"
    />

    <UAlert v-if="listError" color="error" variant="subtle" icon="i-lucide-alert-triangle" title="一覧を読めませんでした" :description="listError" />

    <div class="flex flex-wrap gap-2" data-testid="status-counts">
      <UButton
        size="xs"
        :variant="filter === 'all' ? 'solid' : 'outline'"
        :label="`すべて ${rows.length}`"
        @click="filter = 'all'"
      />
      <UButton
        v-for="s in STATUSES"
        :key="s"
        size="xs"
        :color="statusColor[s]"
        :variant="filter === s ? 'solid' : 'outline'"
        :label="`${STATUS_LABEL[s]} ${counts[s]}`"
        @click="filter = s"
      />
    </div>

    <UAlert
      v-if="scanNotice"
      :color="scanNotice.ok ? 'success' : 'error'"
      variant="subtle"
      :icon="scanNotice.ok ? 'i-lucide-check' : 'i-lucide-alert-triangle'"
      :description="scanNotice.text"
      data-testid="scan-notice"
    />

    <!-- OCR に失敗した scan -->
    <div v-if="failedScans.length > 0" class="space-y-2">
      <h3 class="font-bold">読めなかったスキャン ({{ failedScans.length }} 件)</h3>
      <table class="etc-table">
        <thead>
          <tr><th>受信</th><th>大きさ</th><th>理由</th><th /></tr>
        </thead>
        <tbody>
          <tr v-for="s in failedScans" :key="s.sha256">
            <td>{{ formatIssuedDate(s.received_at) }} <span class="text-dimmed font-mono">{{ s.sha256.slice(0, 12) }}</span></td>
            <td>{{ formatBytes(s.bytes) }}</td>
            <td>{{ s.ocr_error ?? '-' }}</td>
            <td><UButton size="xs" variant="outline" label="再 OCR" :loading="busy === `scan-${s.sha256}`" :disabled="busy !== null" @click="reOcr(s)" /></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="loading && rows.length === 0" class="flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-loader-circle" class="animate-spin size-4" />読み込み中...
    </div>
    <div v-else class="overflow-x-auto">
      <table class="etc-table" data-testid="etc-cards-table">
        <thead>
          <tr>
            <th>状態</th><th>区分</th><th>カード番号</th><th>車両番号</th><th>下 4 桁</th><th>車載器番号</th>
            <th>受信日</th><th>登録日</th>
            <th>走行日</th><th>運行 NO</th><th>試行</th><th>最後の誤り</th><th>受付</th><th />
          </tr>
        </thead>
        <tbody>
          <template v-for="r in shown" :key="r.id">
            <tr>
              <td><UBadge :label="STATUS_LABEL[r.status]" :color="statusColor[r.status]" variant="subtle" /></td>
              <td>{{ r.kubun ?? '(未読)' }}</td>
              <td class="font-mono">{{ maskedCard(r.card_last5) }}</td>
              <td>{{ r.vehicle_number ?? '(未読)' }}</td>
              <td class="font-mono">{{ r.plate4 ?? '-' }}</td>
              <td class="font-mono">{{ r.obu_number ?? '(未読)' }}</td>
              <td>{{ receivedDate(r.received_at) }}</td>
              <td class="whitespace-nowrap" data-testid="registration-date">
                <UInput
                  v-model="regDraft[r.id]"
                  size="xs"
                  class="w-28 font-mono"
                  :placeholder="receivedDate(r.received_at)"
                  :disabled="r.status === 'registered' || busy !== null"
                  autocomplete="off"
                />
                <UButton
                  v-if="regDateChanged(r)"
                  size="xs"
                  variant="outline"
                  label="保存"
                  class="ml-1"
                  :loading="busy === `regdate-${r.id}`"
                  :disabled="busy !== null"
                  @click="saveRegDate(r)"
                />
              </td>
              <td>{{ r.run_date ?? '-' }}</td>
              <td class="font-mono">{{ r.unko_no ?? '-' }}</td>
              <td>{{ r.attempts }}</td>
              <td class="max-w-64 truncate" :title="r.last_error ?? ''">{{ r.last_error ?? '-' }}</td>
              <td>{{ formatIssuedDate(r.created_at) }}</td>
              <td class="whitespace-nowrap">
                <UButton v-if="r.status === 'needs_review'" size="xs" variant="outline" label="直す" :disabled="busy !== null" @click="openEdit(r)" />
                <UButton
                  v-if="canRegister(r.status)"
                  size="xs"
                  variant="outline"
                  label="今すぐ登録"
                  :loading="busy === `reg-${r.id}`"
                  :disabled="busy !== null"
                  @click="register(r)"
                />
                <UButton
                  v-if="canRescan(r)"
                  size="xs"
                  variant="outline"
                  label="走行日を探し直す"
                  class="ml-1"
                  :loading="busy === `rescan-${r.id}`"
                  :disabled="busy !== null"
                  @click="rescan(r)"
                />
              </td>
            </tr>
            <tr v-if="notes[`row-${r.id}`]">
              <td colspan="14" :class="notes[`row-${r.id}`]!.ok ? 'text-success' : 'text-error'">{{ notes[`row-${r.id}`]!.text }}</td>
            </tr>
          </template>
          <tr v-if="shown.length === 0 && !listError && !loading">
            <td colspan="14" class="text-center text-muted">{{ rows.length === 0 ? 'まだスキャンされたカードはありません' : 'この状態の行はありません' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 要確認の手直し -->
    <UModal :open="editing !== null" @update:open="(v: boolean) => { if (!v) editing = null }">
      <template #content>
        <div v-if="editing" class="p-6 space-y-4">
          <h3 class="text-lg font-bold">カードの手直し</h3>
          <p class="text-sm text-muted">明細書の紙を見て、読めなかった項目を入れてください。4 項目 (区分・カード番号・車両番号の下 4 桁・車載器番号) が揃うと「走行待ち」になります。</p>
          <UAlert v-if="editError" color="error" variant="subtle" icon="i-lucide-alert-triangle" :description="editError" />
          <UFormField label="区分">
            <USelect v-model="form.kubun" :items="KUBUN_ITEMS" placeholder="選んでください" class="w-48" />
          </UFormField>
          <UFormField
            label="カード番号"
            :description="editing.card_last5 === null
              ? `数字 ${CARD_NUMBER_DIGITS} 桁`
              : `いまは ${maskedCard(editing.card_last5)}。変えるときだけ数字 ${CARD_NUMBER_DIGITS} 桁を入れてください (空欄はそのまま)`"
          >
            <UInput v-model="form.card_number" inputmode="numeric" autocomplete="off" class="w-64 font-mono" />
          </UFormField>
          <UFormField label="車両番号" description="例: テスト100あ1234 (末尾の数字が下 4 桁になります)">
            <UInput v-model="form.vehicle_number" class="w-64" />
          </UFormField>
          <UFormField label="車載器番号" :description="`数字 ${OBU_NUMBER_DIGITS} 桁`">
            <UInput v-model="form.obu_number" inputmode="numeric" autocomplete="off" class="w-64 font-mono" />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton label="キャンセル" variant="outline" @click="editing = null" />
            <UButton label="保存" :loading="busy === `edit-${editing.id}`" @click="saveEdit" />
          </div>
        </div>
      </template>
    </UModal>

    <!-- 複合機がスキャンを送るときの資格情報 (purpose etc-scan)。給油の画面ではなくここで発行する -->
    <section id="machine-credentials" class="space-y-2 pt-4 border-t border-default">
      <h3 class="font-bold">複合機の資格情報</h3>
      <MachineCredentials purpose="etc-scan" />
    </section>
  </div>
</template>

<style scoped>
.etc-table {
  border-collapse: collapse;
  font-size: 0.875rem;
}
.etc-table th,
.etc-table td {
  border: 1px solid var(--ui-border);
  padding: 2px 4px;
  white-space: nowrap;
}
.etc-table th {
  text-align: left;
}
</style>
