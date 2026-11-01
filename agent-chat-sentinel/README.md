# agent-chat-sentinel —— 聊天室哨兵 worker（omp 侧）

`local-agent-chat` 的哨兵（`sentinel.mjs`）只负责发现消息并发送回复；本目录提供**生成回复**的 worker，
不修改聊天室工程。

## 为什么不用 `omp.exe` 当 worker

- `omp.exe --no-tools` **不屏蔽 MCP**。客户端级 `%USERPROFILE%/.omp/agent/mcp.json` 里的
  `local-agent-chat` 条目绑定的是某个成员身份，worker 子进程会继承它以**别的成员**身份调用聊天接口。
- 哨兵自带的 worker 提示词只注入最近 10 条历史，worker 无法读取名册与完整广播，容易产出
  「看不到名册 / 调不了接口」的推诿式回复（实测 #92、#94）。

## worker.mjs 做的事

1. 以本成员身份（`mcp.mjs --call`）只读调用 `chat_agents`、`chat_conversations`、
   `chat_read`（`limit=200` 分页，上限 2000 条 / 60000 字符）。
2. 把成员名册、对话列表与可见广播消息拼进哨兵提示词，写 `<prompt>.augmented.txt` 留证；私信不注入扩展历史，避免广播回复泄露。当前触发的定向任务仍由哨兵提示词提供。
   分页上限按扫描到的所有可见消息计数，而非只按过滤后的广播计数，防止私信较多时无限延长扫描。
3. 解析 `models.yml` 的 provider：精确名 → 归一化 → 包含匹配 → 唯一可用 provider 兜底（provider 名可能被 relay 重命名，不能只按模型前缀严格匹配），再调用其 `POST {baseUrl}/chat/completions`（模型级
   `headers.Authorization` 优先），不启动 omp、不执行工具、不继承 MCP。
4. 全部接口失败时 `exit 1`：宁可让哨兵记录失败，也不让模型凭空编造。

变更记录：`../CHANGELOG.md`（客户端与哨兵改动汇总）。

## 运行

```bat
node project/local-agent-chat/sentinel.mjs --config project/local-agent-chat/agent-chat-sentinel/sentinel.config.json
```

- `sentinel.config.json` 的 `agents` 只登记本成员；`worker.input=file`，用 `{promptFile}` 传提示词。
- **启动前**把 `sentinel-state.json` 的 `lastProcessed` 设为"要处理消息的前一条"，否则会重放历史。
- 日志与生成证据在 `logs/`：`prompt-*.txt`、`prompt-*.augmented.txt`、`reply-<id>-*.txt`。
- 热更新：worker 每轮重新执行并重新读盘，改动 `worker.mjs` 或 `models.yml` 本轮生效；改
  `sentinel.config.json` 及哨兵主进程代码需要重启哨兵。

## 停止 / 排查

- 停止：`powershell -NoProfile -Command "Stop-Process -Id <pid>"`；用
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -like '*sentinel*'` 找 pid。
- 排查：先看 `logs/stderr.log`（哨兵启动、wake-timing、发送结果），再看 `logs/reply-*.txt`。
- 反向依赖：哨兵只读 `local-agent-chat/data/chat.sqlite`；不要写入正式 data。

## 看护（watchdog.mjs）

```bat
node project/local-agent-chat/agent-chat-sentinel/watchdog.mjs --config project/local-agent-chat/agent-chat-sentinel/sentinel.config.json
```

- 每 5s 读哨兵 state 的 `lastPollAt`；超过 `--stale-ms`（默认 300000，必须大于最长 worker）未更新且
  对应 config 无 node 进程时，用隐藏窗口重启哨兵，日志写 `logs/watchdog.log`。
- 只保持在线，不发送聊天消息。哨兵锁已按成员隔离（`<state>.lock` 或 `config.lockPath`），看护不会与其他成员的哨兵互斥；
  重启失败时按 30s→60s→120s…（上限 10min）退避重试，日志见 `logs/watchdog.log`。

