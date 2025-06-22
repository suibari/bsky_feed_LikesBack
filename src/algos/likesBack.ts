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
    .returning(['did'])
    .execute()

  if (result.length > 0) {
    console.log(`[${requesterDid}] subscriber registered.`);
  }

  // 1. いいねを取得（indexedAt降順）
  let likeQuery = ctx.db
    .selectFrom('like')
    .select(['did', 'indexedAt', 'uri'])
    .where('likedDid', '=', requesterDid)
    .orderBy('indexedAt', 'desc')
    .orderBy('uri', 'desc') // 同じタイムスタンプの場合の順序を決定的にする
    .limit(PAGE_SIZE + 1)

  // cursorがある場合の処理
  if (params.cursor) {
    try {
      const decodedCursor = Buffer.from(params.cursor, 'base64').toString();
      const [indexedAt, uri] = decodedCursor.split('|');
      likeQuery = likeQuery.where(({eb, or}) => 
        or([
          eb('indexedAt', '<', indexedAt),
          eb.and([
            eb('indexedAt', '=', indexedAt),
            eb('uri', '<', uri)
          ])
        ])
      );
    } catch (err) {
      console.error('Invalid cursor:', err);
    }
  }
  
  const likeRows = await likeQuery.execute();

  // cursor生成
  let nextCursor: string | undefined = undefined;
  if (likeRows.length > PAGE_SIZE) {
    const next = likeRows[PAGE_SIZE];
    nextCursor = Buffer.from(`${next.indexedAt}|${next.uri}`).toString('base64');
    likeRows.splice(PAGE_SIZE);
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
  const usedPostUris = new Set<string>() // 同一ページ内での重複を防ぐ
  
  for (const row of likeRows) {
    const feedRow = feedMap.get(row.did)
    if (feedRow && feedRow.length > 0) {
      // 未使用のポストを探す
      let foundPost: FeedViewPost | null = null
      for (let i = 0; i < feedRow.length; i++) {
        if (!usedPostUris.has(feedRow[i].post.uri)) {
          foundPost = feedRow.splice(i, 1)[0] // 見つけたポストを削除して取得
          break
        }
      }
      
      if (foundPost) {
        usedPostUris.add(foundPost.post.uri)
        feed.push(foundPost)
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
