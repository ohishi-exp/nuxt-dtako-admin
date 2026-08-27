/**
 * 運行No単位の NET780 生データ (ZIP fetch + wasm parse) を取得・キャッシュする
 * composable。`Net780OperationSummary.vue` (NET780タブ)・イベントタブの行選択
 * → 速度カラー Map・**ヘッダの「経路地図」の道なり軌跡** (Refs #873) と、同じ運行No で
 * 複数箇所から呼ばれうるため、モジュールスコープの cache で dedup する
 * (先に呼んだ方が fetch、以降は結果を再利用する)。
 *
 * **生の ZIP バイトはここに残さない** (`Net780ParseResult` だけ持つ)。NET780 タブの
 * 「zip をダウンロード」は `/api/net780/by-operation` を**押されたときに叩き直す** —
 * cache に evict が無いので、開いた運行のぶんだけ数十〜数百 KB が常駐するのを避ける。
 */
import { extractSingleOperationZip, parseNet780Zip } from '~/utils/net780'
import type { Net780ParseResult } from '~/utils/net780'
import { currentAccessToken } from '~/utils/api'

export type Net780DataStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error'

interface CacheEntry {
  status: Ref<Net780DataStatus>
  result: Ref<Net780ParseResult | null>
  error: Ref<string | null>
  promise: Promise<void> | null
}

const cache = new Map<string, CacheEntry>()

function getEntry(operationNo: string): CacheEntry {
  let entry = cache.get(operationNo)
  if (!entry) {
    entry = {
      status: ref<Net780DataStatus>('idle'),
      result: ref<Net780ParseResult | null>(null),
      error: ref<string | null>(null),
      promise: null,
    }
    cache.set(operationNo, entry)
  }
  return entry
}

async function loadEntry(operationNo: string, entry: CacheEntry): Promise<void> {
  entry.status.value = 'loading'
  entry.error.value = null
  try {
    // 同一オリジンなので cookie (`logi_auth_token`) は自動で載るが、cookie の無い
    // 経路でも通るよう `Authorization: Bearer` も明示する — この口が `requireAuth` を
    // 通すようになった (Refs #988)。`snapshot.delete.ts` と同じ扱い。
    const token = currentAccessToken()
    const blob = await $fetch<Blob>('/api/net780/by-operation', {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query: { operationNo },
      responseType: 'blob',
    })
    const bulkBytes = new Uint8Array(await blob.arrayBuffer())
    const singleBytes = await extractSingleOperationZip(bulkBytes)
    entry.result.value = await parseNet780Zip(singleBytes)
    entry.status.value = 'ready'
  }
  catch (e) {
    const status = (e as { statusCode?: number, response?: { status?: number } })?.statusCode
      ?? (e as { response?: { status?: number } })?.response?.status
    if (status === 404) {
      entry.status.value = 'not-found'
    }
    else {
      entry.error.value = e instanceof Error ? e.message : 'NET780 データの取得に失敗しました'
      entry.status.value = 'error'
    }
  }
}

export function useNet780OperationData(operationNo: MaybeRefOrGetter<string>) {
  const opNoRef = computed(() => toValue(operationNo))
  const entryRef = computed(() => getEntry(opNoRef.value))

  /**
   * 冪等。取得成功 (`ready`) 済み、または実行中 (`loading`) ならそれを再利用し
   * 多重fetchしない (ZIP fetch + wasm parse という重い処理の重複を避ける目的)。
   * `not-found`/`error`/`idle` は毎回 fetch し直す — 未アーカイブ/エラーは
   * 取得コストが軽く (404 やネットワークエラーの早期リターン)、ページ再訪問や
   * 別タブでの再選択時に状況が変わっている (後からアーカイブされた等) 可能性を
   * 汲み取れた方が実利が大きいため、こちらは cache しない。
   */
  async function ensureLoaded(): Promise<void> {
    const opNo = opNoRef.value
    if (!opNo) return
    const entry = getEntry(opNo)
    if (entry.status.value === 'ready' || entry.status.value === 'loading') {
      if (entry.promise) await entry.promise
      return
    }
    entry.promise = loadEntry(opNo, entry)
    await entry.promise
  }

  return {
    status: computed(() => entryRef.value.status.value),
    result: computed(() => entryRef.value.result.value),
    error: computed(() => entryRef.value.error.value),
    ensureLoaded,
  }
}
