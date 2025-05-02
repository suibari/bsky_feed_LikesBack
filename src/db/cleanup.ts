import { Kysely } from 'kysely'
import { DatabaseSchema } from './schema.js'

export function startCleanupTask(db: Kysely<DatabaseSchema>) {
  const intervalMs = 30 * 60 * 1000 // 30分ごと

  setInterval(async () => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 12 * 60 * 60 * 1000) // 12時間前より前のいいねを削除

    console.log(`[Cleanup] Deleting likes older than ${yesterday.toISOString()}`)

    await db
      .deleteFrom('like')
      .where('indexedAt', '<', yesterday.toISOString())
      .execute()

    console.log(`[Cleanup] Done.`)
  }, intervalMs)
}
