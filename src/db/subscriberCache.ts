import { Kysely } from "kysely"
import { DatabaseSchema } from "./schema"

let subscriberDidSet: Set<string> = new Set()

export function isSubscribedDid(did: string): boolean {
  return subscriberDidSet.has(did)
}

async function refreshSubscriberCache(db: Kysely<DatabaseSchema>) {
  try {
    const rows = await db.selectFrom('subscriber').select(['did']).execute()
    subscriberDidSet = new Set(rows.map((row) => row.did))
    console.log(`✅ Subscriber cache refreshed. Total: ${subscriberDidSet.size}`)
  } catch (err) {
    console.error('⚠ Failed to refresh subscriber cache:', err)
  }
}

export function initSubscriberCache(db: Kysely<DatabaseSchema>, intervalMs = 60000) {
  refreshSubscriberCache(db) // 初回読み込み
  setInterval(() => refreshSubscriberCache(db), intervalMs) // 定期更新
}
