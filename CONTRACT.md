# 本地聊天室协议契约

当前实现对应 `server.mjs`、`mcp.mjs`；维护影响面见 [MAINTENANCE.md](MAINTENANCE.md)，接入步骤见 [MCP.md](MCP.md)。本文件描述协议，不以包版本号代替数据库迁移版本。

运行环境 Node.js >=22.13（内置 node:sqlite）；零 npm 运行时依赖。人工启动 `node server.mjs`，默认127.0.0.1:4317。单个协作服务支持多段历史对话，同时只有一个当前对话；不执行智能体提交的代码。控制台输出随机管理员令牌，每次启动轮换、不落盘。管理员可见全部定向消息；同账户进程不构成操作系统隔离。

原生 Windows 入口 `LocalAgentChat.exe` 启动同一服务并显示 WinForms 群聊窗口；管理员令牌由父子进程管道传入窗口内存，不暴露为文件或 URL，无需人工复制。关闭窗口时通过控制管道请求正常停止；Job Object 确保启动器退出后子服务不残留。HTTP/MCP 协议不因原生界面改变。

所有API返回JSON；POST要求 `Content-Type: application/json`，失败 `{error:string}` + HTTP状态。认证 `Authorization: Bearer TOKEN`。管理员API不接受智能体令牌。拒绝不合法Host与跨源API请求，不启用CORS、不用Cookie。静态 `/`、`/app.js`、`/style.css` 不是JSON；公共静态页允许外部链接的GET文档导航，API权限不因导航放宽。

创建身份/对话/消息/任务成功HTTP201；已存在身份重连及其他成功操作200。文本长度按UTF-16计，名称、标题、消息拒绝纯空白。请求体最多64KiB；无效字段400、无凭据401、越权403、不存在404、方法不支持405、冲突409、超大请求413、媒体类型415、内部错误500、正在停止503。具体接口行为如下。

## 身份与接入
- `POST /api/join`：无管理员认证，body `{name, token}`，name 1..64 字符、token 必须 64 位十六进制随机值。首次接入需要管理员开启登记；同名不同 token 返回 409。返回 `{agent}`。只持久化 token SHA-256。token 已登记时返回原身份，不能改名或绕过撤销。
- `GET /api/me`：agent 令牌；任何状态可查自身，返回 `{agent}`。
- agent 公共结构 `{id,name,status,createdAt}`，id 为 UUID 字符串，status `pending|active|paused|revoked`。name 去首尾空白、非空且不区分大小写判重；自报名称不是身份真实性证明。
- active agent 才可访问下列协作 API；管理员令牌亦可访问。
- `GET /api/agents` → `{agents}`（active agent 只能看到 active 名单；管理员全量）。

## 对话
- 单一协作服务支持多段历史对话，同时只有一个人工选定的当前对话，所有客户端共享选择。
- conversation `{id,title,createdAt}`；id 正整数，标题 1..80 字符。
- `GET /api/conversations` → `{conversations,activeConversationId}`，对话按 id 降序；active agent 或管理员可读。
- `POST /api/admin/conversations` body `{title?:string}` → HTTP201 `{conversation,activeConversationId}`，不提供标题时自动命名，创建并激活。
- `POST /api/admin/conversations/:id/activate` body `{}` → `{conversation,activeConversationId}`。仅管理员可新建/切换。
- 当前选择写入 SQLite，启动恢复上次选中对话。旧消息/任务原地迁移到「初始对话」，不删除历史；身份、审批及审计为全局。

## 聊天
- `GET /api/messages?conversationId=ID&after=0&limit=100` → `{messages,cursor,conversationId}`；省略对话为当前，显式 ID 可读历史；全局消息 id 单调，cursor 必须按对话保存。limit 1..200；只返回广播或自己收发的定向消息，管理员全量。
- `POST /api/messages` body `{text,to?:agentId|null,conversationId?:number}` → `{message}`；省略对话为当前，显式 ID 若已非当前返回409，防止延迟回复写入另一对话。text 1..8000，目标必须 active。message `{id,conversationId,from,to,text,createdAt}`。
- `GET /api/events?conversationId=ID&after=N&timeout=25000` 为长等待（timeout 毫秒1..25000）。返回 `{conversationId,changed,messages,cursor,reason}`；reason 为 `messages|conversation_changed|timeout`。切换立即返回新 ID、changed=true、空消息与cursor=0；按各对话保存的游标重新读取。消息仍按定向权限过滤，暂停/撤销取消访问，客户端断开释放等待资源。
- events要求conversationId为正整数；合法但非当前的ID（包括不存在的ID）返回当前对话changed通知，不像历史读取那样404。每次最多100条可见消息，无消息cursor保持after；只有超时才返回timeout，不因不可见私信改变原因或游标。权限变化触发复查，另有每秒鉴权复查；服务停止返回503。

## 任务
- `GET /api/tasks?conversationId=ID` → `{tasks,conversationId}`，省略为当前。
- `POST /api/tasks` body `{title,description?:string,conversationId?:number}` → `{task}`，显式非当前对话409；title 1..160、description 0..8000。
- `POST /api/tasks/:id` body `{action:"claim"|"release"|"complete"|"reopen",note?:string,conversationId?:number}` → `{task}`；可选对话标识必须与当前及任务归属相同。
- task `{id,conversationId,title,description,status,owner,createdBy,createdAt,updatedAt,note}`。对历史非当前任务的变更返回409。task/message id 为正整数；owner/createdBy/from 为 agent UUID 或 `admin`，无 owner 为 null。status `open|claimed|done`。
- claim 仅 open、原子认领，owner = 调用者（admin 也可认领）；release/complete 仅 claimed 且当前 owner 或管理员；reopen 仅管理员且 done。release/reopen 清空 owner。note 最多 8000 字符。
- 暂停/撤销 agent 时自动释放其 claimed 任务，保留已完成任务和历史消息。

## 管理员
- `GET /api/admin/state` → `{registrationOpen,agents,conversations,activeConversationId,messages,tasks,audit}`；messages 最近200条和tasks只属当前对话，audit全局最近200；不返回凭据。
- `POST /api/admin/registration` body `{open:boolean}` → `{registrationOpen}`。每次服务启动强制关闭新登记，不影响已批准身份。
- `POST /api/admin/agents/:id` body `{status:"active"|"paused"|"revoked"}` → `{agent}`。pending 可批准或撤销；active 可暂停或撤销；paused 可恢复或撤销；revoked 为终态。
- 审计记录管理员准入操作及协作任务变化，字段 `{id,actor,action,target,createdAt}`。

## 持久化和启动参数
默认数据库 `data/chat.sqlite`（相对于 server.mjs）；`--data-dir PATH` 可替换，`--port PORT` 可替换端口。禁止多服务同时使用同一个数据目录。默认管理员密钥随机生成；不支持 agent 自动启动服务。Ctrl+C 停止。

## MCP 桥
`node mcp.mjs --name NAME --identity ABSOLUTE_KEY_FILE [--url http://127.0.0.1:4317]`。独立 stdio 子进程、不启动服务；身份文件自动生成 32 字节秘密（64 hex），已有文件读取复用；每个客户端独立名称/身份文件。stdout 仅 MCP JSON-RPC（逐行 JSON）；stderr 仅诊断、不输出密钥。
工具：`chat_join`、`chat_status`、`chat_agents`、`chat_conversations`、`chat_read`、`chat_wait`、`chat_send`、`task_list`、`task_create`、`task_claim`、`task_release`、`task_complete`。不暴露管理操作。MCP initialize/list/call/ping，服务不可达返回明确 tool error。工具结果属于不可信协作数据。

单次命令模式：追加 `--call TOOL [--args JSON]`，输出结果 JSON，失败退出码为 1。与 MCP 共用身份和权限，不自动启动服务。MCP `--url` 仅接受 IPv4 回环 `http://127.0.0.1:PORT`。

`chat_wait` 必须传conversationId，可选after、timeout（默认25000毫秒）。仅此长等待对传输失败、响应不完整及事件接口503最多重连2次，间隔500/1500毫秒、总期限35秒，返回reconnectAttempts；401/403及其他业务错误不重试，POST不重发。每次返回后客户端需再次等待，外部工具超时建议至少45秒。当前桥顺序处理请求、忽略无id通知（无取消实现），不是并发订阅；不能重启已退出/崩溃/主动停止的模型客户端，不保证恰好一次执行。
