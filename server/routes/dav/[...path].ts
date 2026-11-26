/**
 * 複合機の WebDAV 送信 (ETC コーポレートカード発行明細書) を受ける /dav/** (Refs #1287)。
 * 判定は `server/utils/etc-scan-dav.ts`、D1 の読み書きは `server/utils/etc-scan.ts`。
 * auth-worker の `/m/etc-scan/**` からの中継 (X-Internal-Shared-Secret 付き) だけを処理し、それ以外は 404。
 * 形は ohishi-exp/nuxt-leave の `server/routes/dav/[...path].ts` に倣った (保存先だけ違う)。
 */
import { defineEventHandler, getRequestURL, setResponseHeaders, setResponseStatus, toWebRequest } from 'h3'
import { cfEnv, resolveSecret } from '../../utils/cf-env'
import type { D1DatabaseLite } from '../../utils/kyuyo-master-db'
import type { AlcRedactRpc } from '../../utils/etc-scan'
import {
  NOT_RELAYED,
  handlePut,
  hasAuthorization,
  isRelayed,
  logLine,
  planReply,
  readBodyLimited,
  type DavOutcome,
  type MachineCredentialRpc,
} from '../../utils/etc-scan-dav'

interface DavEnv {
  INTERNAL_SHARED_SECRET?: unknown
  AUTH_MCRED?: MachineCredentialRpc
  ALC_REDACT?: AlcRedactRpc
  DTAKO_DB?: D1DatabaseLite
}

export default defineEventHandler(async (event) => {
  const req = toWebRequest(event)
  const authorization = req.headers.get('authorization')
  const env = cfEnv<DavEnv>(event)

  let bodyBytes = 0
  let outcome: DavOutcome
  if (!isRelayed(req.headers.get('x-internal-shared-secret'), await resolveSecret(env.INTERNAL_SHARED_SECRET))) {
    await req.body?.cancel()
    outcome = NOT_RELAYED
  }
  // PUT は認証が付いているときだけ本文を読む (無ければ planReply が 401 を返す)
  else if (event.method.toUpperCase() === 'PUT' && hasAuthorization(authorization)) {
    if (!env.AUTH_MCRED || !env.ALC_REDACT || !env.DTAKO_DB) {
      await req.body?.cancel()
      outcome = { kind: 'upstream_error', reply: { status: 503, headers: {} }, log: { detail: 'binding missing (AUTH_MCRED / ALC_REDACT / DTAKO_DB)' } }
    }
    else {
      const body = await readBodyLimited(req.body, req.headers.get('content-length'))
      bodyBytes = body?.byteLength ?? Number(req.headers.get('content-length') ?? 0)
      outcome = await handlePut(authorization, body, {
        mcred: env.AUTH_MCRED,
        redact: env.ALC_REDACT,
        db: env.DTAKO_DB,
        now: () => new Date().toISOString(),
      })
    }
  }
  else {
    await req.body?.cancel()
    outcome = planReply(event.method, getRequestURL(event).pathname, hasAuthorization(authorization))
  }

  console.log(logLine(event.method, bodyBytes, outcome))

  setResponseStatus(event, outcome.reply.status)
  setResponseHeaders(event, outcome.reply.headers)
  return outcome.reply.body ?? ''
})
