/**
 * dtako 側の会社 (comp_id) 一覧。
 *
 * 元は `app/pages/scraper.vue` に直書きされていたものを、拘束×賃金の社員マスタ
 * (会社横断表示、Refs #367) と共有するために切り出した。**フロントに持つのは
 * ラベルと並び順だけ**で、どの会社を触れるかの判定は常に worker 側が
 * `DTAKO_ACCOUNTS` (comp_id → tenant_id) の逆引きで行う
 * (`workers/dtako-scraper-relay/src/restraint-viewer-auth.ts` の
 * `viewerCompIdsForTenant`) — このリストに載っていても、テナントが許可されて
 * いない会社は 401/403 になる (fail-closed)。
 *
 * 会社が増えた時はここだけ足せば scraper と社員マスタの両方に反映される。
 */
export interface DtakoComp {
  /** dtako の会社ID (X-Theearth-Comp-Id に載る値)。 */
  compId: string
  /** 画面表示用の会社名。 */
  label: string
}

export const DTAKO_COMPS: DtakoComp[] = [
  { compId: '27324455', label: '大石運輸倉庫' },
  { compId: '75700192', label: '北海大運' },
]

/** 会社ID → 会社名。未登録の ID はそのまま返す (閲覧モードの手入力・ローカル検証用)。 */
export function dtakoCompLabel(compId: string): string {
  return DTAKO_COMPS.find(c => c.compId === compId)?.label ?? compId
}

/** 「27324455 (大石運輸倉庫)」形式の表示名。 */
export function dtakoCompDisplay(compId: string): string {
  const found = DTAKO_COMPS.find(c => c.compId === compId)
  return found ? `${found.compId} (${found.label})` : compId
}
