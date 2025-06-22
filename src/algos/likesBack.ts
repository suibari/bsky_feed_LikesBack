import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton.js'
import { AppContext } from '../config.js'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs'
import pLimit from 'p-limit'
import { agent } from '../login.js'

export const shortname = 'likesBack'

type CursorData = {
  lastIndexedAt: string
  usedCounts: Record<string, number>
}

export const handler = async (ctx: AppContext, params: QueryParams, requesterDid: string) => {
  const PAGE_SIZE = Math.min(params.limit ?? 100, 100)
  const limit = pLimit(10)
  const now = new Date()

  // subscriber 登録
  const result = await ctx.db
    .insertInto('subscriber')
    .values({
      did: requesterDid,
      indexedAt: now.toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .returning(['did'])
    .execute()

  if (result.length > 0) {
    console.log(`[${requesterDid}] subscriber registered.`)
  }

  // --- カーソル解釈 ---
  let cursorData: CursorData | undefined
  if (params.cursor) {
    try {
      const decoded = Buffer.from(params.cursor, 'base64').toString()
      cursorData = JSON.parse(decoded)
    } catch {
      console.warn(`Invalid cursor: ${params.cursor}`)
    }
  }

  // --- like取得 ---
  let likeQuery = ctx.db
    .selectFrom('like')
    .select(['did', 'indexedAt'])
    .where('likedDid', '=', requesterDid)
    .orderBy('indexedAt', 'desc')
    .limit(PAGE_SIZE + 1)

  if (cursorData?.lastIndexedAt) {
    likeQuery = likeQuery.where('indexedAt', '<', cursorData.lastIndexedAt)
  }

  const likeRows = await likeQuery.execute()

  // --- cursor生成 ---
  let nextCursor: string | undefined = undefined
  let nextUsedCounts: Record<string, number> = { ...(cursorData?.usedCounts || {}) }

  if (likeRows.length > PAGE_SIZE) {
    const nextIndexedAt = likeRows[PAGE_SIZE].indexedAt
    likeRows.splice(PAGE_SIZE) // 上限分に絞る
    nextCursor = Buffer.from(JSON.stringify({
      lastIndexedAt: nextIndexedAt,
      usedCounts: nextUsedCounts, // あとで上書き
    })).toString('base64')
  }

  // --- like数を集計 ---
  const likeCounts: Record<string, number> = {}
  for (const row of likeRows) {
    likeCounts[row.did] = (likeCounts[row.did] || 0) + 1
  }

  // --- ポスト取得（likerごとに取得 + slice） ---
  const responses = await Promise.all(
    Object.entries(likeCounts).map(([liker, count]) =>
      limit(() =>
        agent.getAuthorFeed({
          actor: liker,
          limit: 100,
          filter: 'posts_and_author_threads',
        })
          .then(res => {
            const allPosts = res.data.feed.filter(p => !p.reason) // リポスト除外
            const prevUsed = cursorData?.usedCounts?.[liker] || 0
            const feed = allPosts.slice(prevUsed, prevUsed + count)
            return { liker, feed }
          })
          .catch(err => {
            console.error(`Failed to fetch feed for liker ${liker}:`, err)
            return { liker, feed: [] }
          })
      )
    )
  )

  // --- feedMap構築 ---
  const feedMap = new Map<string, FeedViewPost[]>()
  for (const { liker, feed } of responses) {
    feedMap.set(liker, feed)
  }

  // --- フィード構築 + usedCount更新 ---
  const feed: FeedViewPost[] = []
  const usedUris = new Set<string>()

  for (const row of likeRows) {
    const feedRow = feedMap.get(row.did)
    if (feedRow && feedRow.length > 0) {
      const post = feedRow.find(p => !usedUris.has(p.post.uri))
      if (post) {
        feed.push(post)
        usedUris.add(post.post.uri)
        nextUsedCounts[row.did] = (nextUsedCounts[row.did] || 0) + 1
      }
    }
  }

  // --- 次のカーソル再生成（使用数反映） ---
  if (feed.length > 0 && likeRows.length === PAGE_SIZE) {
    const lastIndexedAt = likeRows[likeRows.length - 1].indexedAt
    nextCursor = Buffer.from(JSON.stringify({
      lastIndexedAt,
      usedCounts: nextUsedCounts,
    })).toString('base64')
  } else {
    nextCursor = undefined // 最後のページ
  }

  console.log(`[${requesterDid}] liked by: ${Object.keys(likeCounts).length}, total posts: ${feed.length}, cursor: ${nextCursor}`)

  return {
    cursor: nextCursor,
    feed: feed.map((item) => ({
      post: item.post.uri,
    })),
  }
}
