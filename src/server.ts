import http from 'http'
import events from 'events'
import express from 'express'
import { DidResolver, MemoryCache } from '@atproto/identity'
import { createServer } from './lexicon/index.js'
import feedGeneration from './methods/feed-generation.js'
import describeGenerator from './methods/describe-generator.js'
import { createDb, Database, migrateToLatest } from './db/index.js'
import { JetstreamSubscription } from './subscription.js'
import { AppContext, Config } from './config.js'
import wellKnown from './well-known.js'
import { startCleanupTask } from './db/cleanup.js'
import { initAgent } from './login.js'
import { initSubscriberCache } from './db/subscriberCache.js'

export class FeedGenerator {
  public app: express.Application
  public server?: http.Server
  public db: Database
  public jetstreamSub: JetstreamSubscription
  public cfg: Config

  constructor(
    app: express.Application,
    db: Database,
    jetstreamSub: JetstreamSubscription,
    cfg: Config,
  ) {
    this.app = app
    this.db = db
    this.jetstreamSub = jetstreamSub
    this.cfg = cfg
  }

  static create(cfg: Config) {
    const app = express()
    const db = createDb(cfg.sqliteLocation)
    const jetstreamSub = new JetstreamSubscription(db)

    const didCache = new MemoryCache()
    const didResolver = new DidResolver({
      plcUrl: 'https://plc.directory',
      didCache,
    })

    const server = createServer({
      validateResponse: true,
      payload: {
        jsonLimit: 100 * 1024, // 100kb
        textLimit: 100 * 1024, // 100kb
        blobLimit: 5 * 1024 * 1024, // 5mb
      },
    })
    const ctx: AppContext = {
      db,
      didResolver,
      cfg,
    }
    feedGeneration(server, ctx)
    describeGenerator(server, ctx)
    app.use(server.xrpc.router)
    app.use(wellKnown(ctx))

    return new FeedGenerator(app, db, jetstreamSub, cfg)
  }

  async start(): Promise<http.Server> {
    await migrateToLatest(this.db)

    // 定期処理をしかける
    startCleanupTask(this.db)
    initSubscriberCache(this.db)
    // BSKYログイン
    await initAgent();

    await this.jetstreamSub.run()
    this.server = this.app.listen(this.cfg.port, this.cfg.listenhost)
    await events.once(this.server, 'listening')
    return this.server
  }
}

export default FeedGenerator
