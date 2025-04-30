import dotenv from 'dotenv';
dotenv.config();

import { AtpAgent } from '@atproto/api'

export let agent: AtpAgent
export const initAgent = async () => {
  agent = new AtpAgent({ service: 'https://bsky.social' })
  await agent.login({
    identifier: process.env.BSKY_IDENTIFIER ?? "",
    password: process.env.BSKY_APP_PASSWORD ?? ""
  });
}
