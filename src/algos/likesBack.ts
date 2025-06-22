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
    .select(['did', 'indexedAt', 'uri']) // uriを追加して一意性を確保
    .where('likedDid', '=', requesterDid)
    .orderBy('indexedAt', 'desc')
    .orderBy('uri', 'desc') // 同じタイムスタンプの場合の順序を決定的にする
    .limit(PAGE_SIZE + 1)

  // cursorがある場合の処理を改善
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
      // カーソルが無効な場合は無視して最初から取得
    }
  }
  
  const likeRows = await likeQuery.execute();

  // cursor生成を改善
  let nextCursor: string | undefined = undefined;
  if (likeRows.length > PAGE_SIZE) {
    const next = likeRows[PAGE_SIZE];
    nextCursor = Buffer.from(`${next.indexedAt}|${next.uri}`).toString('base64');
    likeRows.splice(PAGE_SIZE);
  }

  // 2. ユニークなlikerを抽出し、必要なポスト数を計算
  const likerPostNeeds = new Map<string, number>();
  for (const row of likeRows) {
    likerPostNeeds.set(row.did, (likerPostNeeds.get(row.did) || 0) + 1);
  }

  // 3. 各likerのポストを取得
  const responses = await Promise.all(
    Array.from(likerPostNeeds.entries()).map(([liker, neededCount]) =>
      limit(() => 
        agent.getAuthorFeed({
          actor: liker,
          limit: Math.min(neededCount, 100), // 必要な分だけ取得
          filter: "posts_and_author_threads",
        }).then(res => ({
          liker,
          feed: res.data.feed
            .filter(item => !item.reason) // リポスト除外
            .slice(0, neededCount) // 必要な分だけ
        }))
        .catch(err => {
          console.error(`Failed to fetch feed for liker ${liker}:`, err)
          return { liker, feed: [] }
        })
      )
    )
  )

  // 4. likerごとのポストキューを作成
  const postQueues = new Map<string, FeedViewPost[]>();
  for (const { liker, feed } of responses) {
    postQueues.set(liker, feed);
  }

  // 5. 重複チェック用のSet
  const usedPostUris = new Set<string>();
  const feed: FeedViewPost[] = [];

  // 6. like順にポストを組み立て（重複チェック付き）
  for (const row of likeRows) {
    const queue = postQueues.get(row.did);
    if (!queue || queue.length === 0) {
      continue;
    }

    // キューから未使用のポストを探す
    let postIndex = 0;
    let foundPost: FeedViewPost | null = null;
    
    while (postIndex < queue.length) {
      const candidatePost = queue[postIndex];
      if (!usedPostUris.has(candidatePost.post.uri)) {
        foundPost = candidatePost;
        queue.splice(postIndex, 1); // キューから削除
        break;
      }
      postIndex++;
    }

    if (foundPost) {
      usedPostUris.add(foundPost.post.uri);
      feed.push(foundPost);
    }
  }

  console.log(`[${requesterDid}] liked by: ${likerPostNeeds.size}, total posts: ${feed.length}, cursor: ${nextCursor}`);
  return {
    cursor: nextCursor,
    feed: feed.map((item) => ({
      post: item.post.uri,
    })),
  };
}
