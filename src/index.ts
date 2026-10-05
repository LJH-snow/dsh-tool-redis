import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallView } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RedisClient, RedisError } from './client.js'

export const name = 'dsh-tool-redis'
export const inject = ['tools']

export interface RedisPluginConfig {
  /** Explicit Redis URL; overrides urlEnv when set. */
  url?: string
  /** Environment variable containing the Redis URL (default REDIS_URL). */
  urlEnv?: string
  /** Per-command timeout in milliseconds (default 5000). */
  commandTimeoutMs?: number
}

export function apply(ctx: Context, config: RedisPluginConfig = {}) {
  const urlEnv = config.urlEnv ?? 'REDIS_URL'
  const client = new RedisClient({
    url: config.url ?? process.env[urlEnv],
    commandTimeoutMs: config.commandTimeoutMs,
  })
  for (const tool of createTools(client)) ctx.tools.register(tool)
}

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

function unavailable(reason: string) {
  return { found: false, items: [], keys: [], reason }
}

function errorReason(error: unknown): string {
  return error instanceof RedisError ? error.message : error instanceof Error ? error.message : String(error)
}

function splitKeys(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

const ITEM_RENDER_LIMIT = 20

function renderPing(value: { ok?: boolean; reason?: string; url?: string; latencyMs?: number }) {
  return value.ok
    ? text(`Redis reachable at ${value.url ?? ''} latency=${value.latencyMs ?? 0}ms`)
    : text(`Redis connection failed: ${value.reason ?? ''}`)
}

function renderInfo(value: { ok?: boolean; reason?: string; redisVersion?: string; redisMode?: string; uptimeSeconds?: number; connectedClients?: number; usedMemoryHuman?: string; opsPerSec?: number; keyspaceHits?: number; keyspaceMisses?: number; evictedKeys?: number; expiredKeys?: number }) {
  if (!value.ok) return text(value.reason ?? 'Redis server info unavailable.')
  const hitRate = (value.keyspaceHits ?? 0) + (value.keyspaceMisses ?? 0) > 0
    ? Math.round(((value.keyspaceHits ?? 0) / ((value.keyspaceHits ?? 0) + (value.keyspaceMisses ?? 0))) * 100)
    : 0
  return text([
    `Redis ${value.redisVersion ?? ''} mode=${value.redisMode ?? ''} uptime=${value.uptimeSeconds ?? 0}s`,
    `memory=${value.usedMemoryHuman ?? ''} clients=${value.connectedClients ?? 0} opsPerSec=${value.opsPerSec ?? 0}`,
    `hits=${value.keyspaceHits ?? 0} misses=${value.keyspaceMisses ?? 0} hitRate=${hitRate}% evicted=${value.evictedKeys ?? 0} expired=${value.expiredKeys ?? 0}`,
  ].join('\n'))
}

function renderKeys(items: string[], cursor?: string, hasMore?: boolean) {
  const lines = items.slice(0, ITEM_RENDER_LIMIT).map(key => `  ${key}`)
  if (items.length > ITEM_RENDER_LIMIT) lines.push(`  ... ${items.length - ITEM_RENDER_LIMIT} more keys omitted`)
  if (cursor !== undefined) lines.push(`cursor=${cursor} hasMore=${hasMore ? 'yes' : 'no'}`)
  return text(lines.length ? lines.join('\n') : 'No keys matched.')
}

function renderKey(value: { found?: boolean; reason?: string; key?: string; type?: string; ttl?: number; value?: string; valueLength?: number; truncated?: boolean; items?: string[]; entries?: Array<{ field?: string; value?: string }>; count?: number }) {
  if (!value.found) return text(value.reason ?? `Key ${value.key ?? ''} not found.`)
  const header = `${value.key ?? ''} type=${value.type ?? ''} ttl=${value.ttl ?? 0}${value.ttl === -1 ? ' (persistent)' : ''}`
  if (value.value !== undefined) {
    return text([header, `length=${value.valueLength ?? 0}${value.truncated ? ' (truncated preview)' : ''}`, value.value].join('\n'))
  }
  if (value.entries?.length) {
    const lines = value.entries.slice(0, ITEM_RENDER_LIMIT).map(entry => `  ${entry.field ?? ''} = ${entry.value ?? ''}`)
    if ((value.count ?? 0) > value.entries.length) lines.push(`  ... ${value.count! - value.entries.length} more entries omitted`)
    return text([header, ...lines].join('\n'))
  }
  if (value.items?.length) {
    const lines = value.items.slice(0, ITEM_RENDER_LIMIT).map(item => `  ${item}`)
    if (value.items.length > ITEM_RENDER_LIMIT) lines.push(`  ... ${value.items.length - ITEM_RENDER_LIMIT} more items omitted`)
    return text([header, ...lines].join('\n'))
  }
  return text(header)
}

function renderWrite(value: { ok?: boolean; reason?: string; applied?: boolean; key?: string; removed?: number; ttlSeconds?: number }) {
  if (!value.ok) return text(`Redis write failed: ${value.reason ?? ''}`)
  if (value.removed !== undefined) return text(`Removed ${value.removed} key(s).`)
  return value.applied
    ? text(`Applied to ${value.key ?? ''}${value.ttlSeconds ? ` ttl=${value.ttlSeconds}s` : ''}`)
    : text(`Not applied (condition not met) on ${value.key ?? ''}`)
}

function parseKeysJson(value: unknown): string[] | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return null
    return parsed.map(item => (typeof item === 'string' ? item : '')).filter(Boolean)
  } catch {
    return null
  }
}

export function createTools(client: RedisClient) {
  return [
    defineTool({
      name: 'redis_ping',
      description: 'Verify Redis connectivity and latency. The connection URL is redacted before display.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, url: { type: 'string' }, latencyMs: { type: 'number' } } },
        render: (_args, value) => renderPing(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Ping Redis', kind: 'read' } },
      async execute() {
        try { return await client.ping() }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'redis_server_info',
      description: 'Read Redis server runtime metrics (version, memory, clients, ops, hit rate).',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, redisVersion: { type: 'string' }, redisMode: { type: 'string' }, uptimeSeconds: { type: 'number' }, connectedClients: { type: 'number' }, usedMemoryHuman: { type: 'string' }, totalCommandsProcessed: { type: 'number' }, opsPerSec: { type: 'number' }, keyspaceHits: { type: 'number' }, keyspaceMisses: { type: 'number' }, evictedKeys: { type: 'number' }, expiredKeys: { type: 'number' } } },
        render: (_args, value) => renderInfo(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Redis server info', kind: 'read' } },
      async execute() {
        try { return { ok: true, ...await client.serverInfo() } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'redis_dbsize',
      description: 'Report the number of keys in the selected Redis database.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, keys: { type: 'number' } } },
        render: (_args, value) => value.ok ? text(`keys=${value.keys ?? 0}`) : text(`Redis dbsize failed: ${value.reason ?? ''}`),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Redis key count', kind: 'read' } },
      async execute() {
        try { return { ok: true, keys: await client.dbSize() } }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'redis_scan_keys',
      description: 'Incrementally scan key names with an optional MATCH pattern. Uses SCAN (never blocking KEYS); paginate via the returned cursor.',
      parameters: {
        pattern: { type: 'string', description: 'Glob-style MATCH pattern, e.g. session:*' },
        cursor: { type: 'string', description: 'Cursor from the previous scan response (default 0)' },
        count: { type: 'integer', description: 'Hint for keys per scan iteration, 10-1000 (default 100)' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, cursor: { type: 'string' }, hasMore: { type: 'boolean' } } },
        render: (_args, value) => !value.found ? text(value.reason ?? 'Redis scan unavailable.') : renderKeys(value.keys ?? [], value.cursor, value.hasMore),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Scan Redis keys${args.pattern ? ` ${args.pattern}` : ''}`, kind: 'search' } },
      async execute(args) {
        try {
          const result = await client.scanKeys({ pattern: args.pattern as string, cursor: args.cursor as string, count: args.count as number })
          return { found: true, ...result }
        } catch (error) { return unavailable(errorReason(error)) }
      },
    }),

    defineTool({
      name: 'redis_get_key',
      description: 'Read one key: type, TTL, and a capped preview of its value by data type (string, hash, list, set, zset).',
      parameters: { key: { type: 'string', required: true, description: 'Redis key name' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { found: { type: 'boolean' }, reason: { type: 'string' }, key: { type: 'string' }, type: { type: 'string' }, ttl: { type: 'number' }, value: { type: 'string' }, valueLength: { type: 'number' }, truncated: { type: 'boolean' }, items: { type: 'array', items: { type: 'string' } }, entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { field: { type: 'string' }, value: { type: 'string' } } } }, count: { type: 'number' } } },
        render: (_args, value) => renderKey(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Redis key ${args.key ?? ''}`, kind: 'read' } },
      async execute(args) {
        if (!args.key) return { found: false, key: '', type: 'none', ttl: -2, reason: 'key is required.' }
        try { return await client.getKey(args.key as string) }
        catch (error) { return { found: false, key: args.key as string, type: 'none', ttl: -2, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'redis_set_key',
      description: 'Set one string key with optional TTL and NX/XX semantics. WRITE operation; the value is never echoed back.',
      parameters: {
        key: { type: 'string', required: true, description: 'Redis key name' },
        value: { type: 'string', required: true, description: 'String value (max 10000 characters)' },
        ttlSeconds: { type: 'integer', description: 'Expiration in seconds, 1-31536000' },
        nx: { type: 'boolean', description: 'Only set if the key does not exist' },
        xx: { type: 'boolean', description: 'Only set if the key already exists' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, applied: { type: 'boolean' }, key: { type: 'string' }, valueLength: { type: 'number' }, ttlSeconds: { type: 'number' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Set Redis key ${args.key ?? ''}`, kind: 'edit' } },
      async execute(args) {
        if (!args.key || typeof args.value !== 'string') return { ok: false, reason: 'key and value are required.' }
        try {
          return await client.setKey(args.key as string, args.value as string, { ttlSeconds: args.ttlSeconds as number, nx: Boolean(args.nx), xx: Boolean(args.xx) })
        } catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'redis_expire_key',
      description: 'Set a TTL on one existing key. WRITE operation; single key only.',
      parameters: {
        key: { type: 'string', required: true, description: 'Redis key name' },
        ttlSeconds: { type: 'integer', required: true, description: 'Expiration in seconds, 1-31536000' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, key: { type: 'string' }, ttlSeconds: { type: 'number' }, applied: { type: 'boolean' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(args): ToolCallView { return { card: 'generic', title: `Expire Redis key ${args.key ?? ''}`, kind: 'edit' } },
      async execute(args) {
        if (!args.key || typeof args.ttlSeconds !== 'number') return { ok: false, reason: 'key and ttlSeconds are required.' }
        try { return await client.expireKey(args.key as string, args.ttlSeconds as number) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),

    defineTool({
      name: 'redis_delete_keys',
      description: 'Delete up to 10 keys by name. WRITE operation; names must be explicit.',
      parameters: { keysJson: { type: 'string', required: true, description: 'JSON array of key names (max 10)' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, removed: { type: 'number' } } },
        render: (_args, value) => renderWrite(value),
      },
      presentCall(): ToolCallView { return { card: 'generic', title: 'Delete Redis keys', kind: 'edit' } },
      async execute(args) {
        const keys = parseKeysJson(args.keysJson)
        if (!keys) return { ok: false, reason: 'keysJson must be a JSON array of key names.' }
        try { return await client.deleteKeys(keys) }
        catch (error) { return { ok: false, reason: errorReason(error) } }
      },
    }),
  ]
}
