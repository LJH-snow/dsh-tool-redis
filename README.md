# dsh-tool-redis

[English](README.md) | [中文](README.zh.md)

Redis inspection and guarded write tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) as a Cordis plugin. The agent can check connectivity, read server metrics, scan key names, and inspect key values — with explicit, single-purpose write tools for SET, EXPIRE, and DEL.

## Install

```sh
npm install @libai168/dsh-tool-redis
```

Requires `@deepseek-ai/cordis` (^4.0.1) and `@deepseek-ai/dsh-tools` (^0.1.0-rc.6) as peer dependencies, plus the bundled `redis` (^6.3.0) client as a runtime dependency.

## Configuration

```yaml
- name: 'github:LJH-snow/dsh-tool-redis'
  config:
    # url: 'redis://127.0.0.1:6379'
    urlEnv: 'REDIS_URL'
    # commandTimeoutMs: 5000
```

The connection URL is resolved from `config.url` first, then the environment variable named by `urlEnv` (default: `REDIS_URL`), then the default `redis://127.0.0.1:6379`. Do not put a usable password in source, examples, tests, or committed configuration. URLs that embed credentials are redacted to `user:***@host` in every tool output.

## Tools

| Tool | Description | Write |
|---|---|---|
| `redis_ping` | Verify connectivity and latency | No |
| `redis_server_info` | Server metrics: version, memory, clients, ops, hit rate | No |
| `redis_dbsize` | Key count of the selected database | No |
| `redis_scan_keys` | Incremental key-name scan with MATCH/COUNT | No |
| `redis_get_key` | Read one key's type, TTL, and capped value preview | No |
| `redis_set_key` | Set one string key with optional TTL and NX/XX | Yes |
| `redis_expire_key` | Set a TTL on one existing key | Yes |
| `redis_delete_keys` | Delete up to 10 explicitly named keys | Yes |

## Security contract

- The connection URL may embed credentials; every output shows the redacted `user:***@host` form, and the raw URL never enters tool results.
- Reads never block: key listing uses `SCAN` with a bounded COUNT hint (10-1000), never `KEYS`.
- `redis_get_key` caps string previews at 2,000 characters (with `valueLength` and `truncated` metadata), hash entries at 50, and list/set/zset members at 100 with 200-character items; key names are capped at 200 characters.
- `redis_set_key` never echoes the written value back; results carry only the key name and value length. Values are capped at 10,000 characters, TTLs at one year, and delete calls at 10 explicit key names.
- All three write tools are single-purpose, explicit-parameter operations marked `kind: 'edit'`; there are no FLUSH, CONFIG, SCRIPT, or module commands.
- Commands run through a fixed verb table with discrete RESP arguments and a 5-second per-command timeout; the connection is created lazily.

## API scope

This version covers string, hash, list, set, and zset reads plus guarded string writes. Pub/sub, streams, Lua scripting, cluster administration, and multi-key transactions are intentionally not included.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests run fully offline against a scripted command executor; no Redis server is needed.

## License

[MIT](LICENSE)
