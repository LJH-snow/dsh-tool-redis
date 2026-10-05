/** Default Redis command executor backed by the official node-redis client.
 * The connection is created lazily so importing this module never opens a socket. */

import { createClient } from 'redis'
import type { RedisExecutor } from './client.js'

export class NodeRedisExecutor implements RedisExecutor {
  private readonly url: string
  private readonly client: ReturnType<typeof createClient>
  private connectPromise?: Promise<void>

  constructor(url: string) {
    this.url = url
    this.client = createClient({ url })
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      // Prevent an unhandled 'error' event from crashing the host; command
      // failures surface through dispatch rejections instead.
      this.client.on('error', () => {})
      this.connectPromise = this.client.connect().then(() => undefined)
    }
    await this.connectPromise
  }

  async dispatch(args: string[]): Promise<unknown> {
    await this.ensureConnected()
    return await this.client.sendCommand(args as unknown as Parameters<typeof this.client.sendCommand>[0])
  }
}
