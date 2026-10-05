/** Redis command client with an injectable executor for offline tests. Values
 * written through this client are never echoed back; read results are capped.
 * Command verbs live in the CMD table; every dynamic operand is passed as a
 * discrete RESP argument, never merged into a command string. */

import { NodeRedisExecutor } from './executor.js'

export interface RedisExecutor {
  dispatch(args: string[]): Promise<unknown>
}

export interface RedisClientOptions {
  /** Redis connection URL, for example redis://127.0.0.1:6379. Passwords are redacted in outputs. */
  url?: string
  /** Per-command timeout in milliseconds. 0 disables the timeout. */
  commandTimeoutMs?: number
  /** Command executor override; used by tests to run fully offline. */
  executor?: RedisExecutor
}

export class RedisError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
  ) {
    super(message)
    this.name = 'RedisError'
  }
}

export interface RedisServerInfo {
  redisVersion: string
  redisMode: string
  uptimeSeconds: number
  connectedClients: number
  usedMemoryHuman: string
  totalCommandsProcessed: number
  opsPerSec: number
  keyspaceHits: number
  keyspaceMisses: number
  evictedKeys: number
  expiredKeys: number
}

export interface RedisScanResult {
  cursor: string
  keys: string[]
  hasMore: boolean
}

export interface RedisEntryInfo {
  field: string
  value: string
}

export interface RedisKeyResult {
  found: boolean
  key: string
  type: string
  ttl: number
  value?: string
  valueLength?: number
  truncated?: boolean
  items?: string[]
  entries?: RedisEntryInfo[]
  count?: number
}

export interface RedisSetResult {
  ok: boolean
  applied: boolean
  key: string
  valueLength: number
  ttlSeconds?: number
}

/** RESP command verbs, referenced by identifier so dynamic operands always
 * travel as separate arguments from a fixed verb vocabulary. */
const CMD = {
  ping: 'PING',
  info: 'INFO',
  dbSize: 'DBSIZE',
  scan: 'SCAN',
  match: 'MATCH',
  count: 'COUNT',
  type: 'TYPE',
  ttl: 'TTL',
  get: 'GET',
  hashGetAll: 'HGETALL',
  listRange: 'LRANGE',
  setMembers: 'SMEMBERS',
  sortedRange: 'ZRANGE',
  withScores: 'WITHSCORES',
  set: 'SET',
  expireSeconds: 'EX',
  ifAbsent: 'NX',
  ifPresent: 'XX',
  expire: 'EXPIRE',
  del: 'DEL',
} as const

const KEY_LIMIT = 200
const KEYS_LIMIT = 100
const SCAN_COUNT_MIN = 10
const SCAN_COUNT_MAX = 1000
const VALUE_LIMIT = 2000
const SET_VALUE_LIMIT = 10000
const FIELD_VALUE_LIMIT = 200
const HASH_FIELD_LIMIT = 50
const COLLECTION_LIMIT = 100
const DELETE_KEYS_LIMIT = 10
const TTL_YEAR = 31536000

function asString(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : value == null ? '' : value instanceof Buffer ? value.toString('utf8') : ''
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asReplyNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clampText(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export class RedisClient {
  private readonly url: string
  private readonly commandTimeoutMs: number
  private readonly executor: RedisExecutor

  constructor(options: RedisClientOptions = {}) {
    this.url = options.url ?? 'redis://127.0.0.1:6379'
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000
    this.executor = options.executor ?? new NodeRedisExecutor(this.url)
  }

  getRedactedUrl(): string {
    try {
      const parsed = new URL(this.url)
      const auth = parsed.username ? `${parsed.username}:***@` : ''
      return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}`
    } catch {
      return '(invalid redis url)'
    }
  }

  /** Sends one command: a fixed verb from CMD plus discrete operand strings. */
  private async send(verb: string, ...operands: string[]): Promise<unknown> {
    const argv = [verb, ...operands]
    if (this.commandTimeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RedisError(`Redis command ${verb} timed out after ${this.commandTimeoutMs}ms.`, 504)), this.commandTimeoutMs)
      })
      try {
        return await Promise.race([this.executor.dispatch(argv), timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    return await this.executor.dispatch(argv)
  }

  async ping(): Promise<{ ok: boolean; url: string; latencyMs: number }> {
    const start = Date.now()
    const reply = asString(await this.send(CMD.ping))
    if (reply !== 'PONG') throw new RedisError(`Redis PING returned ${reply || 'an empty reply'}.`, 502)
    return { ok: true, url: this.getRedactedUrl(), latencyMs: Date.now() - start }
  }

  async serverInfo(): Promise<RedisServerInfo> {
    const raw = asString(await this.send(CMD.info))
    const parsed: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const idx = line.indexOf(':')
      if (idx > 0) parsed[line.slice(0, idx)] = line.slice(idx + 1)
    }
    const pick = (key: string): string => parsed[key] ?? ''
    const num = (key: string): number => Number(pick(key)) || 0
    return {
      redisVersion: pick('redis_version'),
      redisMode: pick('redis_mode'),
      uptimeSeconds: num('uptime_in_seconds'),
      connectedClients: num('connected_clients'),
      usedMemoryHuman: pick('used_memory_human'),
      totalCommandsProcessed: num('total_commands_processed'),
      opsPerSec: num('instantaneous_ops_per_sec'),
      keyspaceHits: num('keyspace_hits'),
      keyspaceMisses: num('keyspace_misses'),
      evictedKeys: num('evicted_keys'),
      expiredKeys: num('expired_keys'),
    }
  }

  async dbSize(): Promise<number> {
    return asReplyNumber(await this.send(CMD.dbSize))
  }

  async scanKeys(options: { pattern?: string; cursor?: string; count?: number } = {}): Promise<RedisScanResult> {
    const nextCursor = clampText(options.cursor ?? '0', 64) || '0'
    if (!/^\d+$/.test(nextCursor)) throw new RedisError('cursor must be a numeric scan cursor.', 400)
    const operands: string[] = [nextCursor]
    const pattern = options.pattern ? clampText(options.pattern, 200) : ''
    if (pattern) operands.push(CMD.match, pattern)
    operands.push(CMD.count, String(clampInt(options.count, SCAN_COUNT_MIN, SCAN_COUNT_MAX) ?? 100))
    const reply = asArray(await this.send(CMD.scan, ...operands))
    const cursor = asString(reply[0]) || '0'
    const keys = asArray(reply[1]).map(key => clampText(asString(key), KEY_LIMIT)).filter(Boolean).slice(0, KEYS_LIMIT)
    return { cursor, keys, hasMore: cursor !== '0' }
  }

  async getKey(key: string): Promise<RedisKeyResult> {
    const cleanKey = clampText(key, KEY_LIMIT)
    const type = asString(await this.send(CMD.type, cleanKey))
    if (!type || type === 'none') return { found: false, key: cleanKey, type: 'none', ttl: -2 }
    const ttl = asReplyNumber(await this.send(CMD.ttl, cleanKey))
    const base: RedisKeyResult = { found: true, key: cleanKey, type, ttl }
    if (type === 'string') {
      const value = asString(await this.send(CMD.get, cleanKey))
      return {
        ...base,
        value: clampText(value, VALUE_LIMIT),
        valueLength: value.length,
        truncated: value.length > VALUE_LIMIT,
      }
    }
    if (type === 'hash') {
      const flat = asArray(await this.send(CMD.hashGetAll, cleanKey))
      const entries: RedisEntryInfo[] = []
      for (let i = 0; i + 1 < flat.length && entries.length < HASH_FIELD_LIMIT; i += 2) {
        entries.push({ field: clampText(asString(flat[i]), KEY_LIMIT), value: clampText(asString(flat[i + 1]), FIELD_VALUE_LIMIT) })
      }
      return { ...base, entries, count: Math.floor(flat.length / 2) }
    }
    if (type === 'list' || type === 'set') {
      const verb = type === 'list' ? CMD.listRange : CMD.setMembers
      const rangeOperands = type === 'list' ? ['0', '99'] : []
      const items = asArray(await this.send(verb, cleanKey, ...rangeOperands))
        .map(item => clampText(asString(item), FIELD_VALUE_LIMIT))
        .slice(0, COLLECTION_LIMIT)
      return { ...base, items, count: items.length }
    }
    if (type === 'zset') {
      const flat = asArray(await this.send(CMD.sortedRange, cleanKey, '0', '99', CMD.withScores))
      const entries: RedisEntryInfo[] = []
      for (let i = 0; i + 1 < flat.length && entries.length < COLLECTION_LIMIT; i += 2) {
        entries.push({ field: clampText(asString(flat[i]), FIELD_VALUE_LIMIT), value: asString(flat[i + 1]) })
      }
      return { ...base, entries, count: entries.length }
    }
    return base
  }

  async setKey(key: string, value: string, options: { ttlSeconds?: number; nx?: boolean; xx?: boolean } = {}): Promise<RedisSetResult> {
    const cleanKey = clampText(key, KEY_LIMIT)
    const safeValue = clampText(value, SET_VALUE_LIMIT)
    const operands: string[] = [cleanKey, safeValue]
    const ttlSeconds = clampInt(options.ttlSeconds, 1, TTL_YEAR)
    if (ttlSeconds !== undefined) operands.push(CMD.expireSeconds, String(ttlSeconds))
    if (options.nx) operands.push(CMD.ifAbsent)
    else if (options.xx) operands.push(CMD.ifPresent)
    const reply = asString(await this.send(CMD.set, ...operands))
    const result: RedisSetResult = { ok: true, applied: reply === 'OK', key: cleanKey, valueLength: value.length }
    if (ttlSeconds !== undefined) result.ttlSeconds = ttlSeconds
    return result
  }

  async expireKey(key: string, ttlSeconds: number): Promise<{ ok: boolean; key: string; ttlSeconds: number; applied: boolean }> {
    const cleanKey = clampText(key, KEY_LIMIT)
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > TTL_YEAR) {
      throw new RedisError('ttlSeconds must be between 1 and 31536000.', 400)
    }
    const wholeSeconds = Math.trunc(ttlSeconds)
    const applied = asReplyNumber(await this.send(CMD.expire, cleanKey, String(wholeSeconds))) === 1
    return { ok: true, key: cleanKey, ttlSeconds: wholeSeconds, applied }
  }

  async deleteKeys(keys: string[]): Promise<{ ok: boolean; removed: number }> {
    const cleanKeys = keys.map(key => clampText(key, KEY_LIMIT)).filter(Boolean).slice(0, DELETE_KEYS_LIMIT)
    if (!cleanKeys.length) throw new RedisError('keys must contain at least one key.', 400)
    const removed = asReplyNumber(await this.send(CMD.del, ...cleanKeys))
    return { ok: true, removed }
  }
}
