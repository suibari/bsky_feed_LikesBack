import dotenv from 'dotenv';
import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton'
import { AppContext } from '../config'
import { AtpAgent } from '@atproto/api'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs';

// 起動時にログイン
dotenv.config();
const agent = new AtpAgent({ service: 'https://bsky.social' })
agent.login({
  identifier: process.env.BSKY_IDENTIFIER ?? "",
  password: process.env.BSKY_APP_PASSWORD ?? ""
});

export const shortname = 'likesBack'

export const handler = async (ctx: AppContext, params: QueryParams, requesterDid: string) => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 24時間以内のlikeを取得して、likerごとに回数を集計
  const likeRows = await ctx.db
    .selectFrom('like')
    .select(['did'])
    .where('uri', 'like', `at://${requesterDid}/%`)
    .where('indexedAt', '>=', yesterday.toISOString())
    .execute()

  // 集計: likerごとのlike回数
  const likeCounts: Record<string, number> = {}
  for (const row of likeRows) {
    likeCounts[row.did] = (likeCounts[row.did] || 0) + 1
  }

  const posts: FeedViewPost[] = []

  // likerごとに、その回数分だけ最新ポストを取得
  for (const [liker, count] of Object.entries(likeCounts)) {
    try {
      const response = await agent.getAuthorFeed({
        actor: liker,
        limit: count, // いいね数に応じた件数だけ取得
        filter: "posts_no_replies",
      })

      const userFeed = response.data.feed;

      posts.push(...userFeed)
    } catch (err) {
      console.error(`Failed to fetch feed for liker ${liker}:`, err)
      continue
    }
  }

  // --- 🧠 ここから cursor 処理
  let feed: FeedViewPost[] = posts

  // ソート条件
  feed = feed.sort((a, b) => {
    const dateA = new Date(a.post.indexedAt).getTime()
    const dateB = new Date(b.post.indexedAt).getTime()
    return dateB - dateA // 新しい順
  })

  if (params.cursor) {
    // カーソル（時刻）より前のポストだけに絞る
    const cursorTime = parseInt(params.cursor, 10)
    feed = feed.filter((item) => {
      const itemTime = new Date(item.post.indexedAt).getTime()
      return itemTime < cursorTime
    })
  }

  // 出す件数制限
  const limitedFeed = feed.slice(0, params.limit)

  // 次のカーソルを計算
  let cursor: string | undefined
  if (limitedFeed.length > 0) {
    const lastTime = new Date(limitedFeed[limitedFeed.length - 1].post.indexedAt).getTime()
    cursor = lastTime.toString()
  }

  // 返却
  return {
    cursor,
    feed: limitedFeed.map((item) => ({
      post: item.post.uri,
    })),
  }
}