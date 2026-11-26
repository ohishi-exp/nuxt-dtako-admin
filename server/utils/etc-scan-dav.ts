/**
 * 複合機の WebDAV 送信 (ETC コーポレートカード発行明細書の PDF) を受ける /dav/** の判定 (Refs #1287)。
 *
 * 機械の入口は auth-worker の `/m/etc-scan/<rest>` 1 か所で、auth-worker が中継の印
 * `X-Internal-Shared-Secret` (= INTERNAL_SHARED_SECRET) を付けて Service Binding でここ (`/dav/<rest>`) へ渡す。
 * 印が合わないものは 404 で存在を見せない。Basic の照合は RPC `issueTicket` (auth-worker) がする。
 *
 * 認可の順 (どれか外れたら止める):
 *   ① 中継の印 → 404  ② PUT 以外は {@link planReply}  ③ `issueTicket` が null → 401
 * tenant の照合は auth-worker の `issueTicket` が `APP_TENANT_ACL` (dtako の origin) で行う (Refs #1287)。
 * 返った tenantId はそのまま `etc_card_scans.tenant_id` に保存する (relay と画面の tenant 絞り込みが使う)。
 * 通ったら: `%PDF-` で始まらなければ 415 → scan を保存 → OCR → 行の作成。
 * OCR に失敗しても scan は残して 201 (複合機に再送させない。画面の「再 OCR」でやり直す)。
 *
 * ★ **出典**: {@link isRelayed} / {@link hasAuthorization} / {@link looksLikeFile} / {@link propfindXml} /
 *   {@link planReply} / {@link readBodyLimited} は ohishi-exp/nuxt-leave の
 *   `server/utils/dav.ts` (origin/main) から写した汎用部分 (realm と上限だけ変えた)。leave の `sha256Hex` は
 *   写さず、この repo に既にある `server/utils/profit-r2-io.ts` の同じ関数を使う。leave 固有の
 *   inbox (R2) への保存は写していない。**2 本目の利用者が出たら、共通化の issue を起票すること**
 *   (いまは leave とこの repo の 2 か所に同じ判定がある。Refs #1287)。
 *
 * ログに Authorization・共有秘密・本文・カード番号は出さない (sha256 の先頭 12 桁・行数・status だけ)。
 */
import type { D1DatabaseLite } from './kyuyo-master-db'
import { insertScan, runOcr, shaPrefix, type AlcRedactRpc } from './etc-scan'
import { sha256Hex } from './profit-r2-io'

/**
 * PUT の本文の上限。D1 の行上限 (2MB) に PDF を BLOB で入れるため 1.5MB で切る
 * (front には書き込める R2 が無い。`DTAKO_R2` は read-only)。超えたら保存せず 413。
 */
export const MAX_PUT_BYTES = 1.5 * 1024 * 1024

/** auth-worker の RPC に渡す用途 */
export const PURPOSE = 'etc-scan'

const ALLOW = 'OPTIONS, PROPFIND, MKCOL, PUT, DELETE'
const WWW_AUTHENTICATE = 'Basic realm="etc-scan", charset="UTF-8"'

export interface DavReply {
  status: number
  headers: Record<string, string>
  body?: string
}

/** ログに出す結果の種類 */
export type DavKind =
  | 'not_relayed'
  | 'options'
  | 'unauthorized'
  | 'empty'
  | 'too_large'
  | 'rejected'
  | 'not_pdf'
  | 'duplicate'
  | 'stored'
  | 'stored_ocr_failed'
  | 'upstream_error'
  | 'propfind'
  | 'mkcol'
  | 'delete'
  | 'not_found'
  | 'method_not_allowed'

export interface DavOutcome {
  kind: DavKind
  reply: DavReply
  /** ログに足す情報 (番号を入れない) */
  log?: { sha?: string, rows?: number, detail?: string }
}

export interface IssuedTicket {
  ticket: string
  tenantId: string
  username: string
}

/** auth-worker の MachineCredentialEntrypoint (service binding AUTH_MCRED) */
export interface MachineCredentialRpc {
  issueTicket(authorization: string, purpose: string, sha256: string): Promise<IssuedTicket | null>
}

export interface EtcScanDeps {
  mcred: MachineCredentialRpc
  redact: AlcRedactRpc
  db: D1DatabaseLite
  now: () => string
}

const unauthorized = (): DavOutcome => ({
  kind: 'unauthorized',
  reply: { status: 401, headers: { 'WWW-Authenticate': WWW_AUTHENTICATE } },
})

/** auth-worker からの中継でないときの応答 (存在を見せない) */
export const NOT_RELAYED: DavOutcome = { kind: 'not_relayed', reply: { status: 404, headers: {} } }

/**
 * `X-Internal-Shared-Secret` が INTERNAL_SHARED_SECRET と一致するか (auth-worker からの中継か)。
 * どちらかが無い・空なら偽。比較は定数時間 (長さの違いも全バイト見てから偽にする)。
 */
export function isRelayed(header: string | null | undefined, secret: string | null | undefined): boolean {
  if (!header || !secret) return false
  const enc = new TextEncoder()
  const a = enc.encode(header)
  const b = enc.encode(secret)
  let diff = a.length ^ b.length
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) diff |= (a[i % a.length]! ^ b[i % b.length]!)
  return diff === 0
}

/** Authorization ヘッダーが付いているか (値の検証は auth-worker がする) */
export function hasAuthorization(header: string | null | undefined): header is string {
  return typeof header === 'string' && header.trim() !== ''
}

/** 末尾の要素に拡張子があればファイル、無ければフォルダとみなす。 */
export function looksLikeFile(path: string): boolean {
  // 最後の `/` より後ろ (leave の `split('/').pop() ?? ''` は pop が必ず値を返すので `??` が死に分岐だった)
  const last = path.replace(/\/+$/, '').replace(/^.*\//, '')
  return /\.[A-Za-z0-9]+$/.test(last)
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** フォルダ 1 つ分の PROPFIND 応答 (中身は空のフォルダとして返す)。 */
export function propfindXml(href: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<D:multistatus xmlns:D="DAV:"><D:response>'
    + `<D:href>${escapeXml(href)}</D:href>`
    + '<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>'
    + '<D:status>HTTP/1.1 200 OK</D:status></D:propstat>'
    + '</D:response></D:multistatus>'
}

/**
 * PUT 以外のメソッドの応答。OPTIONS だけ認証なしで答え、それ以外 (認証なしの PUT も) は Authorization が無ければ 401。
 * (PUT は本文を読む必要があるので {@link handlePut} で扱う)
 */
export function planReply(method: string, path: string, hasAuth: boolean): DavOutcome {
  const m = method.toUpperCase()
  if (m === 'OPTIONS') {
    return { kind: 'options', reply: { status: 200, headers: { 'DAV': '1', 'Allow': ALLOW, 'MS-Author-Via': 'DAV' } } }
  }
  if (!hasAuth) return unauthorized()
  switch (m) {
    case 'PROPFIND':
      // 送る前の存在確認: ファイルは「無い」、フォルダは「ある」と答える
      if (looksLikeFile(path)) return { kind: 'not_found', reply: { status: 404, headers: {} } }
      return {
        kind: 'propfind',
        reply: { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: propfindXml(path) },
      }
    case 'MKCOL':
      return { kind: 'mkcol', reply: { status: 201, headers: {} } }
    case 'DELETE':
      return { kind: 'delete', reply: { status: 204, headers: {} } }
    case 'GET':
    case 'HEAD':
      return { kind: 'not_found', reply: { status: 404, headers: {} } }
    default:
      return { kind: 'method_not_allowed', reply: { status: 405, headers: { Allow: ALLOW } } }
  }
}

/**
 * 本文を上限付きで読む。Content-Length か実際の長さが limit を超えたら null (読むのをやめる)。
 * body が無ければ 0 バイト。
 */
export async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  limit: number = MAX_PUT_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (contentLength !== null && Number(contentLength) > limit) {
    await body?.cancel()
    return null
  }
  if (!body) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** 本文が PDF (`%PDF-` で始まる) か */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D
}

/**
 * PUT の処理 (中継の印は呼び手が確かめ済み)。`body` は {@link readBodyLimited} の結果 (null = 上限超え)。
 * 0 バイト (複合機が最初に送る空ファイル) は保存せず 201、RPC も呼ばない。
 */
export async function handlePut(
  authorization: string | null | undefined,
  body: Uint8Array<ArrayBuffer> | null,
  deps: EtcScanDeps,
): Promise<DavOutcome> {
  if (!hasAuthorization(authorization)) return unauthorized()
  if (body === null) return { kind: 'too_large', reply: { status: 413, headers: {} } }
  if (body.byteLength === 0) return { kind: 'empty', reply: { status: 201, headers: {} } }

  let sha = ''
  try {
    sha = await sha256Hex(body)
    const issued = await deps.mcred.issueTicket(authorization, PURPOSE, sha)
    if (!issued) return { ...unauthorized(), kind: 'rejected', log: { sha: shaPrefix(sha) } }
    if (!isPdf(body)) return { kind: 'not_pdf', reply: { status: 415, headers: {} }, log: { sha: shaPrefix(sha) } }

    const now = deps.now()
    const fresh = await insertScan(deps.db, { sha256: sha, pdf: body, tenantId: issued.tenantId, receivedAt: now })
    if (!fresh) return { kind: 'duplicate', reply: { status: 201, headers: {} }, log: { sha: shaPrefix(sha) } }

    const ocr = await runOcr(deps.db, deps.redact, sha, body, now)
    if (!ocr.ok) {
      return { kind: 'stored_ocr_failed', reply: { status: 201, headers: {} }, log: { sha: shaPrefix(sha), detail: ocr.error } }
    }
    return { kind: 'stored', reply: { status: 201, headers: {} }, log: { sha: shaPrefix(sha), rows: ocr.rowCount } }
  }
  catch (e) {
    return {
      kind: 'upstream_error',
      reply: { status: 503, headers: {} },
      log: { sha: sha === '' ? undefined : shaPrefix(sha), detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) },
    }
  }
}

/** ログ 1 行 (CF Observability は構造化引数を展開しないので文字列にする)。資格情報・本文・番号は含めない。 */
export function logLine(method: string, bodyBytes: number, outcome: DavOutcome): string {
  return `etc-scan dav: ${JSON.stringify({ method: method.toUpperCase(), bodyBytes, status: outcome.reply.status, kind: outcome.kind, ...outcome.log })}`
}
