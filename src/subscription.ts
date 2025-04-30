import dotenv from 'dotenv';
dotenv.config();

import {
  OutputSchema as RepoEvent,
  isCommit,
} from './lexicon/types/com/atproto/sync/subscribeRepos'
import { FirehoseSubscriptionBase, getOpsByType } from './util/subscription'
import { dot } from 'node:test/reporters';
import { isSubscribedDid } from './db/subscriberCache';

export class FirehoseSubscription extends FirehoseSubscriptionBase {
  async handleEvent(evt: RepoEvent) {
    if (!isCommit(evt)) return

    const ops = await getOpsByType(evt)

    for (const like of ops.likes.creates) {
      if (like.record.subject.uri.includes(process.env.FEEDGEN_PUBLISHER_DID ?? '')) {
        console.log(`[${like.author}] likes to ${like.record.subject.uri}`);
      }
    }

    // いいね登録削除: 登録はSubscriberに限定
    const likesToDelete = ops.likes.deletes.map((del) => del.uri)
    const likesToCreate = ops.likes.creates
      .map((create) => {
        const likedDid = create.record.subject.uri.match(/at:\/\/([^\/]+)\/(.+)/)?.[1] ?? ''
        return {
          did: create.author,
          uri: create.uri,
          likedDid,
          indexedAt: new Date().toISOString(),
        }
      })
      .filter((like) => isSubscribedDid(like.likedDid));

    if (likesToDelete.length > 0) {
      await this.db
        .deleteFrom('like')
        .where('uri', 'in', likesToDelete)
        .execute()
    }
    if (likesToCreate.length > 0) {
      await this.db
        .insertInto('like')
        .values(likesToCreate)
        .onConflict((oc) => oc.doNothing())
        .execute()
    }
  }
}
