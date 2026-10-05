# dsh-tool-redis 开发文档

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 项目名 | `dsh-tool-redis` |
| 定位 | DeepSeek Harness 的 Redis 巡检与受控写入插件 |
| 版本 | v0.1.0 |
| 架构 | Cordis 插件 + `ctx.tools.register(defineTool(...))` |
| 协议 | Redis RESP（官方 `redis` ^6.3.0 客户端，惰性连接） |
| 认证 | 连接 URL 内嵌凭据，输出一律脱敏为 `user:***@host` |

### 1.1 目录

```text
src/client.ts        RedisClient：命令动词表、超时、限长、脱敏 URL、类型化读取
src/executor.ts      NodeRedisExecutor：node-redis 适配（惰性连接、错误收敛）
src/index.ts         8 个 defineTool 定义与插件 apply
 tests/client.spec.ts 离线命令构造、解析、限长、超时测试
 tests/tools.spec.ts  工具注册、render、kind 与端到端测试
examples/cordis.yml  dsh 组合配置示例
```

## 2. 技术决策

### 2.1 执行器抽象

- `RedisExecutor.dispatch(args)` 为唯一执行入口；测试注入脚本化假执行器即可完全离线运行。
- `NodeRedisExecutor` 惰性创建连接（首次命令才 connect），并把客户端 `error` 事件收敛，避免未处理异常击穿宿主进程。

### 2.2 命令构造

- 所有动词集中在 `CMD` 常量表（PING/INFO/DBSIZE/SCAN/MATCH/COUNT/TYPE/TTL/GET/HGETALL/LRANGE/SMEMBERS/ZRANGE/WITHSCORES/SET/EX/NX/XX/EXPIRE/DEL），动态操作数永远作为离散 RESP 参数传递，不拼接命令字符串。
- 读取键名只用 `SCAN`（COUNT 限 10-1000），不使用 `KEYS`，避免大库阻塞。
- 单命令超时默认 5 秒（`Promise.race` 实现），0 表示禁用。

### 2.3 脱敏与限长

- URL 输出前经 `getRedactedUrl()` 脱敏（密码替换为 `***`，解析失败显示占位符）。
- 字符串值预览 2000 字符（附 valueLength/truncated）；hash 50 字段、list/set/zset 100 成员、单项 200 字符；键名 200 字符。
- `redis_set_key` 不回显写入值；值上限 10000 字符、TTL 上限一年（31536000）、删除最多 10 个显式键名。

### 2.4 工具范围

- 读：ping、server_info、dbsize、scan_keys、get_key（string/hash/list/set/zset）。
- 写：set_key（可选 EX/NX/XX）、expire_key、delete_keys，均为单用途显式参数操作并标记 `kind: 'edit'`。
- 不做：FLUSH、CONFIG、SCRIPT/Lua、Stream、Pub/sub、集群管理、多键事务。

## 3. 测试

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

测试使用脚本化假执行器覆盖：PING 与 URL 脱敏、INFO 指标解析、SCAN 参数与游标分页、五类数据类型读取与限长截断、SET 参数构造与 applied 语义、EXPIRE/DEL 钳制、命令超时、工具注册、render、写操作 kind 与端到端执行（含写入值不回显断言）。

## 4. 后续方向

- 增加 memory/cluster 只读巡检与慢查询日志（SLOWLOG GET）。
- 增加 Stream（XRANGE）与 Pub/Sub 频道巡检。
- 按需增加 TTL 批量续期等受控批量操作（仍保持显式键名清单）。
