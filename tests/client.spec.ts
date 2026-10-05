import { describe, expect, it } from 'vitest'
import { RedisClient, RedisError, type RedisExecutor } from '../src/client.ts'

function fakeRedis(handlers: Record<string, (args: string[]) => unknown>): RedisExecutor & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async dispatch(args: string[]) {
      calls.push(args)
      const handler = handlers[args[0]]
      if (!handler) throw new RedisError(`unexpected command ${args[0]} in test`, 500)
      return handler(args)
    },
  }
}

function clientFor(executor: RedisExecutor, commandTimeoutMs = 5000): RedisClient {
  return new RedisClient({ url: 'redis://default:hushhush@cache.example.invalid:6379', commandTimeoutMs, executor })
}

describe('RedisClient', () => {
  it('pings with a redacted URL and never exposes the password', async () => {
    const executor = fakeRedis({ PING: () => 'PONG' })
    const result = await clientFor(executor).ping()

    expect(result).toMatchObject({ ok: true, latencyMs: expect.any(Number) })
    expect(result.url).toBe('redis://default:***@cache.example.invalid:6379')
    expect(JSON.stringify(result)).not.toContain('hushhush')
    expect(executor.calls[0]).toEqual(['PING'])
  })

  it('parses server info metrics from the INFO payload', async () => {
    const info = [
      '# Server',
      'redis_version:8.2.1',
      'redis_mode:standalone',
      'uptime_in_seconds:86400',
      '# Clients',
      'connected_clients:7',
      '# Memory',
      'used_memory_human:12.5M',
      '# Stats',
      'total_commands_processed:123456',
      'instantaneous_ops_per_sec:42',
      'keyspace_hits:900',
      'keyspace_misses:100',
      'evicted_keys:3',
      'expired_keys:55',
      '',
    ].join('\r\n')
    const executor = fakeRedis({ INFO: () => info })
    const result = await clientFor(executor).serverInfo()

    expect(result).toEqual({
      redisVersion: '8.2.1', redisMode: 'standalone', uptimeSeconds: 86400, connectedClients: 7,
      usedMemoryHuman: '12.5M', totalCommandsProcessed: 123456, opsPerSec: 42,
      keyspaceHits: 900, keyspaceMisses: 100, evictedKeys: 3, expiredKeys: 55,
    })
    expect(executor.calls[0]).toEqual(['INFO'])
  })

  it('scans with MATCH and COUNT operands and reports cursor pagination', async () => {
    const executor = fakeRedis({ SCAN: (args) => (args[1] === '0' ? ['17', ['session:a', 'session:b', '']] : ['0', []]) })
    const result = await clientFor(executor).scanKeys({ pattern: 'session:*', cursor: '0', count: 50 })

    expect(result).toEqual({ cursor: '17', keys: ['session:a', 'session:b'], hasMore: true })
    expect(executor.calls[0]).toEqual(['SCAN', '0', 'MATCH', 'session:*', 'COUNT', '50'])
    const second = await clientFor(executor).scanKeys({ cursor: '17' })
    expect(second).toEqual({ cursor: '0', keys: [], hasMore: false })
    expect(executor.calls[1]).toEqual(['SCAN', '17', 'COUNT', '100'])
    await expect(clientFor(executor).scanKeys({ cursor: 'drop-table' })).rejects.toThrow('numeric scan cursor')
  })

  it('reads string keys with a capped, truncation-flagged preview', async () => {
    const longValue = 'v'.repeat(3000)
    const executor = fakeRedis({
      TYPE: (args) => (args[1] === 'ghost' ? 'none' : 'string'),
      TTL: () => 120,
      GET: (args) => (args[1] === 'big' ? longValue : 'hello'),
    })
    const fire = clientFor(executor)
    const small = await fire.getKey('greeting')
    const big = await fire.getKey('big')
    const missing = await fire.getKey('ghost')

    expect(small).toEqual({ found: true, key: 'greeting', type: 'string', ttl: 120, value: 'hello', valueLength: 5, truncated: false })
    expect(big.value).toHaveLength(2000)
    expect(big.valueLength).toBe(3000)
    expect(big.truncated).toBe(true)
    expect(missing).toEqual({ found: false, key: 'ghost', type: 'none', ttl: -2 })
    expect(executor.calls.map(call => call[0])).toEqual(['TYPE', 'TTL', 'GET', 'TYPE', 'TTL', 'GET', 'TYPE'])
  })

  it('maps hash, list, set, and zset values into capped entries', async () => {
    const clientWithType = (kind: string) => new RedisClient({
      url: 'redis://localhost:6379',
      executor: fakeRedis({
        TYPE: () => kind,
        TTL: () => -1,
        HGETALL: () => ['field1', 'value1', 'field2', 'value2'],
        LRANGE: () => ['a', 'b'],
        SMEMBERS: () => ['x', 'y'],
        ZRANGE: () => ['alpha', '1.5', 'beta', '2.5'],
      }),
    })

    const hash = await clientWithType('hash').getKey('h')
    expect(hash.entries).toEqual([{ field: 'field1', value: 'value1' }, { field: 'field2', value: 'value2' }])
    expect(hash.count).toBe(2)

    const list = await clientWithType('list').getKey('l')
    expect(list.items).toEqual(['a', 'b'])

    const set = await clientWithType('set').getKey('s')
    expect(set.items).toEqual(['x', 'y'])

    const zset = await clientWithType('zset').getKey('z')
    expect(zset.entries).toEqual([{ field: 'alpha', value: '1.5' }, { field: 'beta', value: '2.5' }])
  })

  it('sets keys with EX/NX operands and reports applied state without echoing values', async () => {
    const executor = fakeRedis({ SET: (args) => (args[1] === 'locked' ? 'OK' : null) })
    const fire = clientFor(executor)
    const applied = await fire.setKey('locked', 'super-secret-value-123', { ttlSeconds: 600, nx: true })
    const skipped = await fire.setKey('missing', 'x', { xx: true })

    expect(applied).toEqual({ ok: true, applied: true, key: 'locked', valueLength: 22, ttlSeconds: 600 })
    expect(skipped).toMatchObject({ ok: true, applied: false })
    expect(JSON.stringify(applied)).not.toContain('super-secret-value-123')
    expect(executor.calls[0]).toEqual(['SET', 'locked', 'super-secret-value-123', 'EX', '600', 'NX'])
    expect(executor.calls[1]).toEqual(['SET', 'missing', 'x', 'XX'])
  })

  it('expires and deletes with validated, explicit operands', async () => {
    const executor = fakeRedis({ EXPIRE: () => 1, DEL: () => 2 })
    const fire = clientFor(executor)
    const expired = await fire.expireKey('k', 3600)
    const removed = await fire.deleteKeys(['a', 'b', 'c'])

    expect(expired).toEqual({ ok: true, key: 'k', ttlSeconds: 3600, applied: true })
    expect(removed).toEqual({ ok: true, removed: 2 })
    expect(executor.calls[0]).toEqual(['EXPIRE', 'k', '3600'])
    expect(executor.calls[1]).toEqual(['DEL', 'a', 'b', 'c'])
    await expect(fire.expireKey('k', 0)).rejects.toThrow('between 1 and 31536000')
    await expect(fire.expireKey('k', 99999999)).rejects.toThrow('between 1 and 31536000')
    await expect(fire.deleteKeys([])).rejects.toThrow('at least one key')
  })

  it('times out a hung command with a RedisError', async () => {
    const hungExecutor: RedisExecutor = { dispatch: () => new Promise(() => {}) }
    await expect(clientFor(hungExecutor, 25).ping()).rejects.toThrow('timed out')
  })
})
