import { QueryParams } from '../lexicon/types/app/bsky/feed/getFeedSkeleton.js'
import { AppContext } from '../config.js'
import { FeedViewPost } from '@atproto/api/dist/client/types/app/bsky/feed/defs';
import pLimit from 'p-limit';
import { agent } from '../login.js';

export const shortname = 'likesBack'

export const handler = async (ctx: AppContext, params: QueryParams, requesterDid: string) => {
  const PAGE_SIZE = Math.min(params.limit ?? 100, 100);
  const limit = pLimit(10); // 同時fetch制限

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
  let likeQuery = ctx.db
    .selectFrom('like')
    .select(['did', 'indexedAt'])
    .where('likedDid', '=', requesterDid)
    .orderBy('indexedAt', 'desc')
    .limit(PAGE_SIZE + 1) // 1件多く取得して、次があるか確認

  // cursorがある場合、参照位置を指定
  if (params.cursor) {
    const decodedCursor = Buffer.from(params.cursor, 'base64').toString();
    likeQuery = likeQuery.where('indexedAt', '<', decodedCursor);
  }
  const likeRows = await likeQuery.execute();

  // cursor生成
  let nextCursor: string | undefined = undefined;
  if (likeRows.length > PAGE_SIZE) {
    const next = likeRows[PAGE_SIZE].indexedAt;
    nextCursor = Buffer.from(next).toString('base64');
    likeRows.splice(PAGE_SIZE); // 100件に絞る
  }

  // 2. likerごとのlike数を集計
  const likeCounts: Record<string, number> = {}
  for (const row of likeRows) {
    likeCounts[row.did] = (likeCounts[row.did] || 0) + 1
  }

  // 3. まとめてポスト取得（Promise.all）
  const responses = await Promise.all(
    Object.entries(likeCounts).map(([liker, count]) =>
      limit(() => 
        agent.getAuthorFeed({
          actor: liker,
          limit: 100,
          filter: "posts_and_author_threads", // リプライ除外かつスレッド先頭ポスト含む
        }).then(res => ({
          liker,
          feed: res.data.feed
            .filter(item => !item.reason) // リポスト除外
            .slice(0, count)
        }))
        .catch(err => {
          console.error(`Failed to fetch feed for liker ${liker}:`, err)
          return { liker, feed: [] }
        })
      )
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
  console.log(`[${requesterDid}] liked by: ${Object.keys(likeCounts).length}, total posts: ${feed.length}, cursor: ${nextCursor}`);
  return {
    cursor: nextCursor,
    feed: feed.map((item) => ({
      post: item.post.uri,
    })),
  };
}
