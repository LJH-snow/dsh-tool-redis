# dsh-tool-redis

[English](README.md) | [中文](README.zh.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的 Redis 巡检与受控写入 Cordis 插件。Agent 可以检查连通性、读取服务端指标、扫描键名、查看键值，并通过显式的单用途写工具执行 SET、EXPIRE、DEL。

## 安装

```sh
npm install @libai168/dsh-tool-redis
```

需要 peer dependency：`@deepseek-ai/cordis`（^4.0.1）和 `@deepseek-ai/dsh-tools`（^0.1.0-rc.6），以及随包分发的运行时依赖 `redis`（^6.3.0）客户端。

## 配置

```yaml
- name: 'github:LJH-snow/dsh-tool-redis'
  config:
    # url: 'redis://127.0.0.1:6379'
    urlEnv: 'REDIS_URL'
    # commandTimeoutMs: 5000
```

连接 URL 依次取 `config.url`、`urlEnv` 指定的环境变量（默认 `REDIS_URL`）、默认值 `redis://127.0.0.1:6379`。不要把可用密码写入源码、示例、测试或提交的配置文件。包含凭据的 URL 在所有工具输出中都会脱敏为 `user:***@host`。

## 工具

| 工具 | 说明 | 写操作 |
|---|---|---|
| `redis_ping` | 验证连通性与延迟 | 否 |
| `redis_server_info` | 服务端指标：版本、内存、客户端、OPS、命中率 | 否 |
| `redis_dbsize` | 当前数据库键数量 | 否 |
| `redis_scan_keys` | MATCH/COUNT 增量扫描键名 | 否 |
| `redis_get_key` | 读取单个键的类型、TTL 和限长值预览 | 否 |
| `redis_set_key` | 写入单个字符串键，可带 TTL 与 NX/XX | 是 |
| `redis_expire_key` | 为单个已有键设置 TTL | 是 |
| `redis_delete_keys` | 删除最多 10 个显式命名的键 | 是 |

## 安全契约

- 连接 URL 可能内嵌凭据；所有输出只显示脱敏后的 `user:***@host`，原始 URL 不进入工具结果。
- 读取操作永不阻塞：键名列举使用 `SCAN`（COUNT 限 10-1000），绝不使用 `KEYS`。
- `redis_get_key` 字符串值预览上限 2000 字符（附带 `valueLength` 与 `truncated`），hash 字段上限 50，list/set/zset 成员上限 100、单项 200 字符；键名上限 200 字符。
- `redis_set_key` 不回显写入的值；结果只含键名与值长度。值上限 10000 字符、TTL 上限一年、删除调用最多 10 个显式键名。
- 三个写工具均为单用途、显式参数操作，标记 `kind: 'edit'`；不提供 FLUSH、CONFIG、SCRIPT 或模块命令。
- 命令通过固定动词表以离散 RESP 参数下发，单命令超时 5 秒；连接采用惰性创建。

## API 范围

当前版本覆盖 string/hash/list/set/zset 读取与受控字符串写入。Pub/sub、Stream、Lua 脚本、集群管理与多键事务有意未包含。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试通过脚本化的命令执行器完全离线运行，不需要真实 Redis 服务。

## 许可证

[MIT](LICENSE)
