import { describe, expect, it } from 'vitest'
import { RedisClient, type RedisExecutor } from '../src/client.ts'
import { createTools } from '../src/index.ts'

function fakeRedis(handlers: Record<string, (args: string[]) => unknown>): RedisExecutor & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async dispatch(args: string[]) {
      calls.push(args)
      const handler = handlers[args[0]]
      if (!handler) throw new Error(`unexpected command ${args[0]}`)
      return handler(args)
    },
  }
}

function clientFor(handlers: Record<string, (args: string[]) => unknown>) {
  return new RedisClient({ url: 'redis://cache.example.invalid:6379', executor: fakeRedis(handlers) })
}

describe('dsh-tool-redis tools', () => {
  it('registers the Redis tool set', () => {
    expect(createTools(clientFor({})).map(tool => tool.name)).toEqual([
      'redis_ping',
      'redis_server_info',
      'redis_dbsize',
      'redis_scan_keys',
      'redis_get_key',
      'redis_set_key',
      'redis_expire_key',
      'redis_delete_keys',
    ])
  })

  it('renders info, keys, key values, and scan output', () => {
    const tools = createTools(clientFor({}))
    const info = tools.find(item => item.name === 'redis_server_info')!
    const infoView = info.output.render({}, {
      ok: true, redisVersion: '8.2.1', redisMode: 'standalone', uptimeSeconds: 86400, connectedClients: 7,
      usedMemoryHuman: '12.5M', opsPerSec: 42, keyspaceHits: 900, keyspaceMisses: 100, evictedKeys: 3, expiredKeys: 55,
    }) as Array<{ text: string }>
    expect(infoView[0].text).toContain('Redis 8.2.1 mode=standalone uptime=86400s')
    expect(infoView[0].text).toContain('hitRate=90%')

    const scan = tools.find(item => item.name === 'redis_scan_keys')!
    const scanView = scan.output.render({}, { found: true, keys: ['session:a', 'session:b'], cursor: '17', hasMore: true }) as Array<{ text: string }>
    expect(scanView[0].text).toContain('session:a')
    expect(scanView[0].text).toContain('cursor=17 hasMore=yes')

    const getKey = tools.find(item => item.name === 'redis_get_key')!
    const stringView = getKey.output.render({}, {
      found: true, key: 'greeting', type: 'string', ttl: 120, value: 'hello', valueLength: 5, truncated: false,
    }) as Array<{ text: string }>
    expect(stringView[0].text).toContain('greeting type=string ttl=120')
    expect(stringView[0].text).toContain('hello')

    const hashView = getKey.output.render({}, {
      found: true, key: 'h', type: 'hash', ttl: -1, entries: [{ field: 'f1', value: 'v1' }], count: 1,
    }) as Array<{ text: string }>
    expect(hashView[0].text).toContain('h type=hash ttl=-1 (persistent)')
    expect(hashView[0].text).toContain('f1 = v1')

    const missingView = getKey.output.render({}, { found: false, key: 'ghost', type: 'none', ttl: -2 }) as Array<{ text: string }>
    expect(missingView[0].text).toContain('Key ghost not found.')
  })

  it('marks set, expire, and delete as edits and renders write results', () => {
    const tools = createTools(clientFor({}))
    for (const [name, args] of Object.entries({
      redis_set_key: { key: 'k', value: 'v' },
      redis_expire_key: { key: 'k', ttlSeconds: 60 },
      redis_delete_keys: { keysJson: '["k"]' },
    })) {
      const tool = tools.find(item => item.name === name)!
      expect(tool.presentCall(args)).toMatchObject({ kind: 'edit' })
    }
    expect(tools.find(item => item.name === 'redis_get_key')!.presentCall({ key: 'k' })).toMatchObject({ kind: 'read' })
    expect(tools.find(item => item.name === 'redis_scan_keys')!.presentCall({})).toMatchObject({ kind: 'search' })

    const set = tools.find(item => item.name === 'redis_set_key')!
    const appliedView = set.output.render({}, { ok: true, applied: true, key: 'k', ttlSeconds: 60 }) as Array<{ text: string }>
    expect(appliedView[0].text).toContain('Applied to k ttl=60s')
    const skippedView = set.output.render({}, { ok: true, applied: false, key: 'k' }) as Array<{ text: string }>
    expect(skippedView[0].text).toContain('Not applied')
    const deleteView = tools.find(item => item.name === 'redis_delete_keys')!.output.render({}, { ok: true, removed: 2 }) as Array<{ text: string }>
    expect(deleteView[0].text).toContain('Removed 2 key(s).')
  })

  it('runs set, expire, and read end to end without echoing the written value', async () => {
    const handlers = {
      SET: (args: string[]) => (args[1] === 'session:42' ? 'OK' : null),
      TYPE: () => 'string',
      TTL: () => 600,
      GET: () => 'stored-value',
    }
    const executor = fakeRedis(handlers)
    const tools = createTools(new RedisClient({ url: 'redis://cache.example.invalid:6379', executor }))

    const set = tools.find(item => item.name === 'redis_set_key')!
    const setResult = await set.execute({ key: 'session:42', value: 'super-secret-session-value', ttlSeconds: 600 })
    expect(setResult).toMatchObject({ ok: true, applied: true, valueLength: 26 })
    expect(JSON.stringify(setResult)).not.toContain('super-secret-session-value')
    expect(executor.calls[0]).toEqual(['SET', 'session:42', 'super-secret-session-value', 'EX', '600'])

    const getKey = tools.find(item => item.name === 'redis_get_key')!
    const keyResult = await getKey.execute({ key: 'session:42' })
    expect(keyResult).toMatchObject({ found: true, type: 'string', ttl: 600, value: 'stored-value' })
    expect(executor.calls.slice(1).map(call => call[0])).toEqual(['TYPE', 'TTL', 'GET'])

    const del = tools.find(item => item.name === 'redis_delete_keys')!
    handlers.DEL = () => 1
    const delResult = await del.execute({ keysJson: '["session:42"]' })
    expect(delResult).toMatchObject({ ok: true, removed: 1 })
  })
})
