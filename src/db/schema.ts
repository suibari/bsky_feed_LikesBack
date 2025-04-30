export type DatabaseSchema = {
  like: Like
  subscriber: Subscriber
  sub_state: SubState
}

export type Like = {
  did: string
  uri: string
  likedDid: string
  indexedAt: string
}

export type Subscriber = {
  did: string
  indexedAt: string
}

export type SubState = {
  service: string
  cursor: number
}
