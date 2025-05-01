import { isSubscribedDid } from './db/subscriberCache.js'
import { Database } from './db/index.js'
import { CommitCreateEvent, CommitDeleteEvent, Jetstream } from '@skyware/jetstream'
import Websocket from 'ws'
import { Record } from './lexicon/types/app/bsky/feed/like.js'

export class JetstreamSubscription {
  private client: InstanceType<typeof Jetstream>
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.client = new Jetstream({
      wantedCollections: ['app.bsky.feed.like'],
      ws: Websocket,
    });
  }

  async run() {
    this.client.onCreate("app.bsky.feed.like", (evt: CommitCreateEvent<any>) => {
      this.handleCreateEvent(evt)
    });

    this.client.onDelete("app.bsky.feed.like", (evt: CommitDeleteEvent<any>) => {
      this.handleDeleteEvent(evt)
    });

    this.client.start();
  }

  private async handleCreateEvent(evt: CommitCreateEvent<any>) {
    const record = evt.commit.record as Record
    const subjectUri = record.subject.uri
    const likedDid = subjectUri.match(/^at:\/\/([^\/]+)/)?.[1]

    if (!likedDid || !isSubscribedDid(likedDid)) return

    const fullUri = `at://${evt.did}/app.bsky.feed.like/${evt.commit.rkey}`

    const like = {
      did: evt.did,
      uri: fullUri,
      likedDid,
      indexedAt: new Date().toISOString(),
    }

    await this.db
      .insertInto('like')
      .values(like)
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  private async handleDeleteEvent(evt: CommitDeleteEvent<any>) {
    const fullUri = `at://${evt.did}/app.bsky.feed.like/${evt.commit.rkey}`

    await this.db
      .deleteFrom('like')
      .where('uri', '=', fullUri)
      .execute()
  }
}
