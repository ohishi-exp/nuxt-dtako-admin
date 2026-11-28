/**
 * datr 一括検索で読み込んだログと写真を、この端末のブラウザ (IndexedDB) に取っておく入れ物。
 * 画面を開き直したり F5 したりするたびにファイルを選び直さなくて済むようにする (サーバーには送らない)。
 *
 * 取っておくのは「選んだファイルそのもの」(ログは文字列、写真は Blob)。検索の索引は開き直したときに
 * 作り直す。保存できない環境 (プライベートウィンドウ・容量不足など) でも検索は動くよう、失敗は呼び手が握りつぶす。
 */

const DB_NAME = 'datr-search'
const DB_VERSION = 1
const LOGS = 'logs'
const IMAGES = 'images'

export interface StoredLog { name: string, text: string }
export interface StoredImage { name: string, blob: Blob }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(LOGS)) db.createObjectStore(LOGS, { keyPath: 'name' })
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: 'name' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction) => T): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(stores, mode)
      const result = body(t)
      t.oncomplete = () => resolve(result)
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error)
    })
  }
  finally {
    db.close()
  }
}

/** 同じ名前は上書き */
export function saveDatrFiles(logs: StoredLog[], images: StoredImage[]): Promise<void> {
  return tx([LOGS, IMAGES], 'readwrite', (t) => {
    for (const l of logs) t.objectStore(LOGS).put(l)
    for (const i of images) t.objectStore(IMAGES).put(i)
  })
}

export async function loadDatrFiles(): Promise<{ logs: StoredLog[], images: StoredImage[] }> {
  let logsReq!: IDBRequest<StoredLog[]>
  let imagesReq!: IDBRequest<StoredImage[]>
  await tx([LOGS, IMAGES], 'readonly', (t) => {
    logsReq = t.objectStore(LOGS).getAll()
    imagesReq = t.objectStore(IMAGES).getAll()
  })
  return { logs: logsReq.result ?? [], images: imagesReq.result ?? [] }
}

export function clearDatrFiles(): Promise<void> {
  return tx([LOGS, IMAGES], 'readwrite', (t) => {
    t.objectStore(LOGS).clear()
    t.objectStore(IMAGES).clear()
  })
}
