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

/** 会社対応表 (`GET /restraint-api/comp-map`、D1 `comp_payroll_map`) の 1 会社。
 * dtako 会社ID ↔ 給与大臣の会社コードの対応は**サーバー (D1) が正** — 会社が
 * 増えてもデプロイ不要にするため、フロントは取得結果をそのまま使う (Refs #367)。 */
export interface CompMapEntry {
  compId: string
  compLabel: string
  payrollCompanies: Array<{
    /** 給与大臣の会社コード 4 桁。**社員マスタの突合キーはこれ** (Refs #405)。 */
    payrollCompany: string
    /** 移行前の会社ラベル ("有"/"株")。統合済み・不要なら null。 */
    legacyLabel: string | null
    /** 給与DB の会社名 (KYCOMSTD.CONAME1)。**表示専用** — 突合には使わない。
     * 自由文字列で表記揺れがあるため、キーには会社コードを使う (Refs #405)。 */
    payrollCompanyName: string | null
  }>
}

/** `GET /restraint-api/comp-map` の応答を検証して取り出す。
 * 壊れた応答は空配列 (呼び出し側は `DTAKO_COMPS` にフォールバックする)。 */
export function parseCompMap(raw: unknown): CompMapEntry[] {
  const comps = (raw as { comps?: unknown } | null)?.comps
  if (!Array.isArray(comps)) return []
  const out: CompMapEntry[] = []
  for (const c of comps) {
    const compId = (c as { compId?: unknown }).compId
    const compLabel = (c as { compLabel?: unknown }).compLabel
    const list = (c as { payrollCompanies?: unknown }).payrollCompanies
    if (typeof compId !== 'string' || !compId) continue
    out.push({
      compId,
      compLabel: typeof compLabel === 'string' && compLabel ? compLabel : compId,
      payrollCompanies: (Array.isArray(list) ? list : [])
        .filter((p): p is { payrollCompany: string, legacyLabel?: unknown } =>
          typeof (p as { payrollCompany?: unknown })?.payrollCompany === 'string')
        .map((p) => {
          const name = (p as { payrollCompanyName?: unknown }).payrollCompanyName
          return {
            payrollCompany: p.payrollCompany,
            legacyLabel: typeof p.legacyLabel === 'string' && p.legacyLabel ? p.legacyLabel : null,
            payrollCompanyName: typeof name === 'string' && name ? name : null,
          }
        }),
    })
  }
  return out
}

/** サーバー (D1) から会社対応表が取れない時のフォールバック。scraper ページの
 * 会社セレクタもこれを使う (スクレイプ対象は給与DBと無関係のため対応表は不要)。 */
export const DTAKO_COMPS: DtakoComp[] = [
  { compId: '27324455', label: '大石運輸倉庫' },
  { compId: '75700192', label: '北海大運' },
]

/** 会社ID → 会社名。未登録の ID はそのまま返す (閲覧モードの手入力・ローカル検証用)。 */
export function dtakoCompLabel(compId: string): string {
  return DTAKO_COMPS.find(c => c.compId === compId)?.label ?? compId
}

/**
 * 給与大臣の会社コードの表示用ラベル (`0100 (有限会社 大石運輸)`、Refs #405)。
 *
 * 社員マスタの `company` はコードを保持するので、そのまま出すと読めない。
 * 会社名 (CONAME1) が未取得なら**コードだけ**を返す — 名前は表示専用で、
 * 無くても機能は成立する (突合はコードで行う)。
 */
export function payrollCompanyLabel(
  comps: CompMapEntry[],
  compId: string,
  payrollCompany: string,
): string {
  const name = comps
    .find(c => c.compId === compId)?.payrollCompanies
    .find(p => p.payrollCompany === payrollCompany)?.payrollCompanyName
  return name ? `${payrollCompany} (${name})` : payrollCompany
}

/** 「27324455 (大石運輸倉庫)」形式の表示名。 */
export function dtakoCompDisplay(compId: string): string {
  const found = DTAKO_COMPS.find(c => c.compId === compId)
  return found ? `${found.compId} (${found.label})` : compId
}
