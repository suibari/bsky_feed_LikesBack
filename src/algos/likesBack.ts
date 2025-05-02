import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton.js'
import { AppContext } from '../config.js'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs';
import { agent } from '../login.js';

export const shortname = 'likesBack'

export const handler = async (ctx: AppContext, params: QueryParams, requesterDid: string) => {
  const now = new Date();

  // Subscriber登録
  const result = await ctx.db
    .insertInto('subscriber')
    .values({
      did: requesterDid,
      indexedAt: now.toISOString(),
    })
    .onConflict((oc) => oc.doNothing())
    .returning(['did']) // ← 挿入に成功したら返ってくる
    .execute()

  if (result.length > 0) {
    console.log(`[${requesterDid}] subscriber registered.`);
  }

  // 1. 24時間以内のlikeを取得（indexedAt昇順）
  const likeRows = await ctx.db
    .selectFrom('like')
    .select(['did', 'indexedAt'])
    .where('likedDid', '=', requesterDid)

    .orderBy('indexedAt', 'desc')
    .execute()

  // 2. likerごとのlike数を集計
  const likeCounts: Record<string, number> = {}
  for (const row of likeRows) {
    likeCounts[row.did] = (likeCounts[row.did] || 0) + 1
  }

  // 3. まとめてポスト取得（Promise.all）
  const responses = await Promise.all(
    Object.entries(likeCounts).map(([liker, count]) =>
      agent.getAuthorFeed({
        actor: liker,
        limit: count,
        filter: "posts_no_replies",
      }).then(res => ({
        liker,
        feed: res.data.feed.filter(item => !item.reason) // リポスト除外
      }))
      .catch(err => {
        console.error(`Failed to fetch feed for liker ${liker}:`, err)
        return { liker, feed: [] }
      })
    )
  )

  // 4. Mapで feed を保持（各likerのポストリスト）
  const feedMap = new Map<string, FeedViewPost[]>()
  for (const { liker, feed } of responses) {
    feedMap.set(liker, feed)
  }

  // 5. like順にポストを組み立て
  const feed: FeedViewPost[] = []
  for (const row of likeRows) {
    const feedRow = feedMap.get(row.did)
    if (feedRow && feedRow.length > 0) {
      const post = feedRow.shift() // 最初の1件を消費
      if (post) {
        feed.push(post)
      }
    }
  }

  // 返却
  console.log(`[${requesterDid}] liked by: ${Object.keys(likeCounts).length}, total posts: ${feed.length}`)
  return {
    cursor: undefined, // cursor非対応
    feed: feed.slice(0, 100).map((item) => ({
      post: item.post.uri,
    })),
  }
}
