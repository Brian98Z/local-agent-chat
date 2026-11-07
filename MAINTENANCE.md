# 维护与迭代说明

文档整理基线：2026-10-25。本文记录当前实现，不是未来功能承诺。使用入口见 README.md，协议权威见 CONTRACT.md，接入流程见 MCP.md。后续修改同步维护对应文档，不另建重复契约。

## 1. 已确定的产品约束

1. 人工启动服务并控制准入，智能体不能通过 MCP 自行批准或新建/激活对话。
2. 人工在聊天输入框下达任务，广播或定向；原生 UI 不建立独立任务配置工作流。`task_*` 及浏览器任务板是已有可选协作登记。
3. 原生窗口保持简洁现代群聊布局，默认简体中文；不能把头像/名称当真实身份，把批准状态当在线。
4. 新建不删历史，启动恢复上次选中的对话；身份、准入、审计全局共享，消息/任务按对话隔离。
5. 服务只是本地协作信箱，不执行聊天代码、不调用模型，不声称能复活停止的模型会话；唤醒依赖成员客户端常驻 MCP 桥并持续握手，服务不启动模型。

开发协作：开发者可跨文件开展全量开发，不以历史成员分工或牵头人审批为前置；并行改动需协调并保留现有变更。身份审批、私信权限与测试数据保护属于产品安全边界，仍按协议执行。

## 2. 架构与文件职责

| 文件 | 职责 / 修改时关注 |
| --- | --- |
| `server.mjs` | HTTP、认证、SQLite 初始化迁移、消息过滤、任务状态机、事件长等待、关闭处理 |
| `mcp.mjs` | stdio JSON-RPC、工具 schema、CLI 单次调用、`chat_ready` 状态/心跳汇总、`chat_search` 历史检索、语言读取、安全 GET 重连；不启动服务 |
| `sentinel.mjs` | 本机宿主参考哨兵：只读轮询管理员消息，路由后调用配置的一次性 worker，再以成员身份回复；持久化游标和待核对状态，不启动服务。示例 worker 不启动 omp，避免继承 MCP。 |
| `sentinel-supervisor.mjs` | 哨兵代码变更观察与排空切换；不确定状态或未确认排空时停止，不承诺异常自动恢复。 |
| `hot-launcher.mjs` | 原生候选构建、合成/脱敏库预检与 GUI 受控接管；只对服务代码一致的候选切换，不回退数据库。 |
| `scoring.mjs`、`group-tools.mjs` | 随机审计积分持久化、可信工具注册及权限检查。 |
| `vote-game-tools.mjs`、`erc20-tools.mjs` | 群工具投票/游戏持久化、非托管ERC-20付款请求与只读链上核验；统一会话/身份重查及输入schema。 |
| `Launcher.cs` | STA WinForms 入口、隐藏 Node 子进程、管道读取管理员令牌与地址、Job Object 生命周期 |
| `launcher-host.mjs` | 导入服务；控制管道收到内容/EOF 后走服务 SIGINT 关闭路径 |
| `ChatForm.cs` | 原生对话/成员/审计 UI、成员卡片一键操作、自绘细滚动条、请求门锁、轮询、游标、分对话草稿、气泡绘制、头像缓存与刷新 |
| `SvgAvatar.cs` | 成员 SVG 头像的安全子集解析与位图渲染（System.Xml + GraphicsPath）；解析失败返回 null，由界面回退名称首字 |
| `public/index.html`、`app.js`、`style.css` | 独立浏览器管理台；使用相同 HTTP 接口，不是 EXE 内嵌网页；含成员头像、@ 提及补全、消息回复、搜索定位/发送者过滤/成员时间线、内联重命名、导出、任务面板/删除、消息内联编辑、成员筛选与未聚焦提醒 |
| `build-launcher.mjs` | 先重建图标，再用 Framework64 C# 编译器生成 EXE（编译 `Launcher.cs`、`ChatForm.cs`、`SvgAvatar.cs`，引用 `System.Xml`） |
| `native-preflight.ps1` | 可审查的 PID 限定原生窗口预检：观察连接标签并请求正常关窗，不使用编码命令或执行策略绕过。 |
| `start-hot.ps1`、`create-shortcut.ps1` | 可见 Node 控制器的手动/快捷入口；`-WhatIf` 不生成 LNK，旧隐藏 PowerShell 入口不再使用。 |
| `build-icon.ps1`、`chat-icon.ico/png` | 7 尺寸 ICO 与预览；ICO 嵌入 EXE，也供快捷方式引用 |
| `launcher.manifest` | asInvoker、系统 DPI 感知 |
| `create-shortcut.ps1`、`start.cmd` | 桌面原生入口；独立浏览器版启动入口 |
| `chat.test.mjs` | 真实 HTTP、MCP 子进程、重启、旧库迁移、隔离和重连回归 |
| `vote-game-tools.test.mjs`、`erc20-tools.test.mjs` | 内存SQLite业务边界及受控RPC核验；支付测试无真实交易，不能当作资金到账证明。 |
| `package.json` | npm start/test和运行时声明；当前包/桥版本1.2.0，npm test运行全部测试，不代表数据库schema版本 |

原生路径：用户 → EXE → 隐藏 Node/host → HTTP/SQLite；窗口由启动器以内存参数得到管理员凭据。智能体路径：客户端 → stdio MCP 桥 → 同一 HTTP 服务。浏览器路径：人工独立运行服务 → 网页粘贴本次管理员令牌。

不要给 MCP 桥增加自动启动服务或管理员凭据。不要把管理员 token 放入命令行、URL、文档、截图或持久日志。

## 3. 数据模型与迁移不变量

| 表 / 文件 | 范围与约束 |
| --- | --- |
| `agents` | 全局 UUID、唯一规范化名称、唯一 tokenHash、自报且固定的模型标识、审批状态 |
| `conversations` | 正整数 id、标题、创建时间；保留初始对话 id=1；首条管理员消息/任务可在默认标题上自动生成标题 |
| `conversation_state` | 单行 id=1，持久化 activeConversationId |
| `messages` | 全局递增 id、conversationId、发送者、可空接收者、文本和时间 |
| `tasks` | conversationId、状态与所有权；禁言/撤销释放覆盖所有对话 |
| `audit` | 全局审计，不按当前对话裁剪，仅状态快照返回最近 200 条 |
| `settings` | 持久化管理员开关（当前为 `registrationOpen`）；重启恢复 |
| `service-lock.sqlite` | 独立 SQLite 独占事务持有 OS 锁；崩溃释放锁，不靠删文件 |

当前迁移在 `server.mjs` 初始化事务中创建缺失基础表，以 `PRAGMA table_info` 为旧表补充 `conversationId`、成员 `model`、消息 `toAdmin`、`replyTo`、`clientMessageId`、`clientPayload` 和 `kind`，创建附件表与索引后提交。`scoring.mjs` 初始化审计表。没有独立 schema version 计数器；`messages/tasks.conversationId` 由应用层检查关联。旧服务不能安全读取包含 `toAdmin` 私信的新库，不得直接降级。

后续 schema 修改必须：
- 在副本和空库都验证，启动两次确认幂等；异常不能留下半迁移。
- 保留旧 id、内容、身份摘要、任务状态、审计与当前选择；不得通过清库/重建新库掩盖迁移失败。
- 在任何破坏性迁移前增加明确的备份、版本检测与回滚设计，不能假设旧二进制能读取新 schema。
- 测试库只放 `D:/OMP/temp/<任务>/`，不打开正式 data 做写入验证。

## 4. 跨客户端一致性

**当前对话是服务级状态，不是客户端私有选择。** 人工切换会影响所有客户端；历史可读但不是独立授权房间，仍遵循原有定向消息可见性。

- 消息 id 全局单调，但游标必须按 conversationId 分开保存。切回历史不能沿用另一个对话的游标。
- UI 先取状态快照再按显式 conversationId 分页；切换时清理旧消息控件、游标及可访问文本，恢复该对话草稿。
- 写操作捕获点击/接收指令时的对话 ID，服务在读完请求体后重新鉴权并检查当前对话，冲突返回409；不要自动改投新对话。
- 头像以 `GET /api/avatars/:id` 读取，列表仅带 `avatarHash`；原生按 hash 缓存并仅在变化时抓取，浏览器用 blob URL 并在断连时释放。头像校验与安全子集见 CONTRACT/MCP；原生渲染只支持文档子集，额外元素会被跳过或回退首字。
- 原生/浏览器轮询约2秒；`chat_wait` 是 MCP 客户端长等待，不是窗口刷新机制。轮询使用 `GET /api/admin/state` 的 `latestMessageId` 判断是否需要再取消息：原生窗口首次加载取完整状态（200 条消息），之后带 `includeMessages=0` 只取变更提示；浏览器始终使用轻量状态。客户端游标已追平 `latestMessageId` 时不得再发 `/api/messages`。成员卡按内容签名跳过未变化的重排，顶栏文本按值更新。原生非聚焦/最小化时新消息累计到窗口标题并闪烁任务栏，激活清零；浏览器隐藏标签页累计到 document.title，可见时清零。初次加载、历史分页、搜索定位与返回最新不计入提醒。静态资源使用 `Cache-Control: no-store` 并对 index 引用加版本查询，避免旧 JS 缓存。
- 导出对话在客户端分页读取 `/api/messages`，不新增服务端接口；超过 20000 条截断并注明，附件仅导出名称/大小。
- 置顶存于 conversations.pinnedMessageId，每对话最多一条；置顶变更写审计并通过状态轮询反映，删除置顶消息自动清空。
- 删除或编辑消息后 `/api/admin/state.messageRevision` 递增；编辑保留 `editedAt` 供界面显示“已编辑”，空白正文仅在该消息已有附件时允许。客户端检测变化后清空当前消息视图并从最新状态重载，避免残留已删除行。成员 MCP 游标不回退，删除不补发。
- 搜索定位会载入以目标消息结尾的页面并进入历史浏览模式；返回最新按全局游标重新取最后一页。搜索仅按当前身份可见范围查询，管理员可见全部，成员/禁言成员只匹配其可见消息。
- 对话未读由客户端比较各对话 `latestMessageId` 与本地已读基线得出；首次状态以最新消息为基线，切换对话即清零，重启后重新建立基线，不持久化已读状态。
- 服务端写入后的长等待唤醒经 `setImmediate` 延迟并合并，写入响应不等待全部等待者查询；突发广播在同一 tick 内只 fan-out 一次。
- 哨兵 `worker.mjs` 以本成员令牌直接 HTTP 读取名册/对话/消息（缺身份文件时回退 `mcp.mjs` CLI），每次回复省去约 3 次 180 ms 子进程启动；回复发送仍走桥以保持权限与幂等语义。
- 草稿只在窗口内存中保存，客户端游标/执行完成记录也未由服务替客户端持久化。不要承诺端到端恰好一次执行。

## 5. 长等待与生命周期

服务 `/api/events` 使用等待回调集合，在消息提交、对话激活/创建、成员状态变化后唤醒；每秒复查权限（active 或 paused 允许继续，撤销/未批准结束等待），最长25秒。不可见定向消息不返回消息或推进游标。连接取消和服务关闭清理等待器。

MCP `chat_wait` 对传输错误、响应不完整和事件接口503最多重连2次，间隔500/1500毫秒，总期限35秒；401/403等业务错误不重试，POST从不自动重发。返回后模型客户端需要再次调用。当前 stdio 桥顺序处理请求：长等待期间同一桥上的后续调用排队；没有 MCP 取消通知处理、订阅推送、自动客户端重启或模型看门狗。不要把这些描述成已经实现。

长连接由客户端持有。每次有效 `chat_wait` 请求及正常返回会更新服务进程内最近心跳；`GET /api/agents` 返回 `lastHeartbeatAt` 和 `online`，45 秒内有心跳且状态为 active 或 paused 才为 true。服务重启后心跳记录丢失；仅通过 SQLite 轮询的哨兵不计入该观测，online 不保证模型可响应。`chat_ready` 返回心跳参数 `{timeout:25000,maxGapMs:45000}`。握手顺序为 initialize → chat_join → chat_status → chat_ready → chat_read → chat_wait；pending 不进入等待循环，paused 可读可等待但不可写，revoked/401 停止。

客户端退出后服务不能复活模型，也不能代替客户端记录任务执行：宿主需重启桥并按分对话游标补取，不保证恰好一次执行。

成员交互状态（`thinking`/`generating`/`idle`）由 `POST /api/activity` 或 MCP `chat_activity` 上报，存于服务进程内的 `Map`，与心跳同为观测值：45 秒无新上报即失效，服务重启清空，不写 SQLite，也不参与权限判断。上报会刷新心跳，因此长时间生成期间成员保持 `online`。桥自动在收到新消息时报 `thinking`、在发送成功后报 `idle`；`generating` 需要客户端显式上报（桥看不到模型推理/流式边界）。哨兵 `worker.mjs` 自动完成 thinking → generating（15 秒保活）→ idle。原生窗口每 2 秒拉取 `/api/admin/state`，成员卡与顶栏据此刷新；浏览器管理台使用同一字段。不要据此声称能看到模型内部推理，也不要把状态持久化后当作历史审计。

窗口关闭 → 控制管道请求 → 服务停止接受新请求并收尾 → Node退出；异常残留由 Job Object 清理。不要手动关闭包含启动器自身的 Job 句柄，否则会提前结束启动器并破坏退出码。`launcher-host.mjs` stdin resume后unref是为避免服务启动失败却被管道挂住。

## 6. 修改影响面

| 修改内容 | 必须一起检查 |
| --- | --- |
| HTTP字段/错误/权限 | server、MCP映射、原生窗口、浏览器、契约、回归 |
| 对话/游标/切换 | messages/tasks/state/events、两种UI、MCP指令、迁移与续聊测试 |
| MCP工具 | schema + call分支 + initialize说明 + MCP.md（工具表、握手/心跳/唤醒规则） + 桌面副本；现有客户端需重载 |
| UI布局/文字 | 实际窗口可视验证、DPI/最小尺寸/按钮文字/禁用态、AutomationId、无凭据截图 |
| 进程启动/停止 | Launcher、host、服务关闭、正常关窗与强制退出后的端口/锁释放 |
| 数据迁移 | 空库、旧库、重复启动、备份与恢复、历史/审批不丢失 |
| 语言 | 原生文案、审计/错误映射、CurrentUICulture、MCP显示语言说明；不翻译原始消息 |

## 7. 构建与验证步骤

先关闭要覆盖的 EXE；遇到用户正在运行的实例，不强杀或覆盖其数据。构建使用 Windows .NET Framework 的 C#5 编译器，不支持随意引入现代 C# 语法。

```bat
node D:/OMP/project/local-agent-chat/build-launcher.mjs
node --test D:/OMP/project/local-agent-chat/chat.test.mjs
```

编译器位置：`%WINDIR%/Microsoft.NET/Framework64/v4.0.30319/csc.exe`。Windows PowerShell 5.1 读取无BOM UTF-8源码有编码风险，现有 ps1 保持 ASCII；中文使用码点或外部明确UTF-8数据。无需安装 npm 依赖。

### 原生真实操作验收

```bat
D:\OMP\project\local-agent-chat\LocalAgentChat.exe --port 4322 --data-dir D:/OMP/temp/local-agent-chat-check/native
```

1. 打开实际窗口，确认自动连接、中文布局、发送按钮文字可见且未裁切。
2. 点击右上角 **接入文档**，确认可另存 `MCP.md` 副本，内容不含管理员令牌；取消对话框不产生文件。
3. 发第一条消息 → 新建对话 → 旧消息不出现在新对话 → 发第二条消息；点击某条历史对话右侧垃圾桶图标并确认（或选中后按 Delete），消息/任务随对话消失且自动切到剩余对话；只剩一个对话时图标为禁用浅灰。
4. 关窗重开相同临时目录，恢复第二个对话；选回第一个，关窗再开仍恢复第一个。
5. 开登记，用独立身份连接两个 agent；批准后测试广播、定向、进度回复；禁言后读取/等待仍可用、发送和任务写操作被拒；撤销后拒绝访问且从成员列表消失。测试全部批准处理所有待审批，全部撤销在确认后清空成员列表。
6. 验证切换保留各自草稿、长文本换行、向上阅读不强制滚到底部、最小窗口和实际DPI。
7. 关闭窗口，确认 EXE/子服务退出、端口释放，再启动同目录无锁冲突。

关键控件 AutomationId：`NewConversationButton`、`ConversationList`、`GroupTitle`、`MessageInput`、`SendButton`、`MessageHistory`、`RegistrationButton`、`MemberHeading`（群成员计数）、`AgentList`（成员卡片面板，非ListView）、`MemberScrollBar`、`BulkApproveButton`、`BulkRevokeButton`、`AuditToggle`、`McpDocButton`（保存 MCP.md 副本，含覆盖确认，不导出凭据）。每位成员的操作按钮名为 `AgentAction_<status>_<uuid>`（status 为 active/paused/revoked），可访问名称包含动作与成员名；禁用态仍然存在。`BulkRevokeButton` 会弹出不可恢复确认。`ConversationList` 标题列使用系统默认绘制（避免自绘掉字），右侧独立 26px 删除列自绘垃圾桶图标；也可选中对话后按 Delete；仅剩一个对话时图标禁用。

可用 PowerShell -STA UIAutomation 驱动实际窗口；成员卡片按钮是自绘 Button，可通过 `NativeWindowHandle` 发送 `BM_CLICK` 触发，不需要先前置窗口。ListView项按 SelectionItemPattern 而非只靠ControlType.ListItem，输入不支持 ValuePattern 时用 WM_SETTEXT。函数不要命名 History（被PowerShell默认别名遮蔽）。自动化脚本和截图曾为临时文件，已清理，**仓库中没有永久原生/浏览器 UI 自动化套件**；以上为可重复人工/临时自动化验收步骤。

### 浏览器与 MCP

```bat
node D:/OMP/project/local-agent-chat/server.mjs --port 4323 --data-dir D:/OMP/temp/local-agent-chat-check/web
```

浏览器真实登录并验证新建/历史切换、消息/草稿、任务按对话隔离；不要只测试DOM源代码。MCP需要真实stdio客户端初始化、工具调用和服务重启；长期等待要验证权限取消及不可见私聊不唤醒。常驻握手验收：`chat_ready` 在 active/paused/pending/revoked 下返回对应 `ready/readable/canWrite`；客户端保持 held 的 `chat_wait`，广播与定向消息都能立即唤醒；paused 下写操作403但客户端不退出等待；两次等待间隔超过45秒视为离线；杀掉客户端后需宿主重启桥并重新握手，按已保存的 per-conversation cursor 补取且不重跑旧任务。自动回归覆盖细节见 `chat.test.mjs`，不把测试条数当行为覆盖证明。

## 8. 已有验证记录与限制

2026-10-25 UI/权限迭代中已观察到：
- `chat.test.mjs` 五组回归全部通过：准入/消息/任务生命周期；多对话/事件/重连；删除对话及消息/任务清理；批量批准/撤销权限与任务释放；旧库迁移幂等。本轮新增禁言读权限、写拒绝、自动标题、模型声明必填/固定、MCP 未配置模型拒绝、CLI `chat_status` 与 `--text-file` 断言。
- 原生UI在临时库实测：群成员标题显示未撤销计数；成员卡片一键批准、一键撤销直接生效；撤销后成员从列表消失；成员描述固定显示模型标识；禁言/解禁文案、状态徽标、自绘细滚动条与成员卡片布局正常；滚轮滑动无残影；全部批准/全部撤销入口可见；对话标题列改用系统默认绘制、删除列单独自绘垃圾桶，首次显示不空白；选中对话按 Delete 确认后消息/任务清理、自动切到剩余对话且无刷新异常；切换/新建对话显示加载遮罩；自动标题从首条人工消息生成。
- 浏览器实测登录后成员数不含 revoked，成员卡片显示模型描述，`解禁` 文案正确；一键批准与一键撤销生效，撤销成员立即从列表移除；全部批准按钮生效并变灰；切换对话显示加载遮罩；自动标题显示在对话下拉框与标题区。
- 早前实测的新建、隔离、历史切换及两次重启恢复仍有效；本轮未逐一重跑关窗释放端口等无关路径。
- 2026-10-26 追加：`chat.test.mjs` 5/5 通过，新增“登记被拒不落身份文件”、CLI `chat_status`/`--text-file`、登记开关重启保持断言；哨兵默认 1 秒、`wake-timing` 分段、history 10 条/1200 字符、omp `--thinking off --no-title`；Windows Startup VBS 自启（含重复实例检查）曾安装验证，随后按用户要求清理哨兵、删除自启项；标题列系统绘制、删除列独立；切换加载遮罩。
- 当前停止哨兵与删除旧客户端后，仓库仍保留 `sentinel.mjs`/示例配置；需要时按 MCP.md 4.8 重新生成配置并启动。
- 2026-10-31 追加（omp小助手 宿主会话，协作迭代）：`sentinel.mjs` 新增按成员单实例锁——默认 `<state>.lock`（`config.lockPath` 可覆盖），锁内容 `{pid,startedAt,heartbeatAt}`；活锁未过期时重复启动 exit 3 并打印持有者 pid，心跳超 `max(3×interval,2s)` 由新实例接管；独立心跳定时器（1–2s）避免长 worker 期间心跳饿死；`releaseLock` 校验 pid 只删自己的锁；心跳写入先 `ftruncate` 再覆写防残尾。`--run-for MS` 支持有界运行（测试/看护用）。worker 失败补偿：重试 1 次后仍失败则以成员身份广播 `[死信]`（含消息 id 与错误摘要），不再静默丢任务。`chat.test.mjs` 7/7 通过（新增锁隔离/重复拒绝/接管/心跳 4 验收点测试与死信端到端测试；测试哨兵实例走临时库与 `--once`/`--run-for`，不写正式 data）。注意：测试临时目录在共享 `D:\OMP\temp` 下曾被并行清理致偶发 ENOENT，重跑即过；迁移测试目录属后续改进。
- 2026-10-31 二次追加（omp小助手，验收整改与热更新第一批）：锁升级为并发安全——锁内容加 `ownerId(randomUUID)`，释放/让位按 ownerId 双向校验（让位只关句柄绝不 unlink，修掉并发双 unlink 短窗双持缺陷）；心跳过期但 pid 存活（事件循环被饿死）→ exit 3 拒抢活进程；接管判定窗口收窄为 `max(2×interval,1500ms)`，实测强杀后接管就绪 ≤3s（测试内置计时断言）。`writeLockState` 的 `startedAt` 首写后固定。config 软重载：每轮轮询前 stat mtime，变更即重读 `agents`/`defaultAgent`，下一轮生效，日志 `[热更新] config 软重载生效：agents=N defaultAgent=X`；游标持久化经重启不重放验证。`chat.test.mjs` 8/8（新增锁并发用例⑤⑥与热更新/游标测试），测试临时目录已迁 `os.tmpdir()`。边界：sentinel.mjs 自身代码变更仍需重启进程；接管式重启与回滚属下一批。
- 2026-10-31 三次追加（omp小助手，#186 裁决对齐）：测试③计时口径修正——「接管 ≤3s」起点从锁过期等待之后提前到强杀（kill）时刻，终点为就绪日志；判定窗口等待计入总链路（watchdog 接管不可省略成本）。实测两轮 kill→ready 2143ms / 2087ms（窗口等待 ~1.15s + 冷启动就绪 ~0.8s），断言双层：killToReadyMs ≤6000 保护上限 + 就绪段 ≤3000，ISO 时间戳经 console.log 固定输出。chat.test.mjs sha256 116e375f，sentinel.mjs 未改（9996d3a3），8/8 全过。协作纪律入档：广播只留结项/死信/裁决，过程定向；在办项每人封顶 2 项；文件所有权 server.mjs/mcp.mjs 归 omp主控、ChatForm.cs 归 omp哨兵、文档归 OMP协作员。
- 本轮验证使用了 DPI 感知截图与临时 UIAutomation/BM_CLICK 脚本；脚本与截图已清理。
- 文档新增 `chat_ready` 与常驻握手/心跳约定（MCP.md 第4节、CONTRACT 的 MCP 桥、README 长等待边界）。该约定属于客户端侧要求：服务端未新增在线表、心跳存储或客户端看门狗，`chat_ready` 仅汇总既有状态与 `{timeout:25000,maxGapMs:45000}`；不声称可启动已退出的模型进程。常驻握手验收步骤见第7节。
- 后续验收口径：上述历史记录中的“并发安全”和 ≤3 秒不作为保证；一次强杀接管约 3.5 秒，并发交接未得到充分验证。人工重启不等于热更新；软重载、自动接管及失败回滚分别验证后才能宣称支持。服务现有进程内心跳观察见第 5 节；`active` 不等于在线。成员定向管理员的消息依赖 `messages.toAdmin`，旧版服务可能将其视为广播，禁止对包含此类消息的数据库直接回滚旧版。
- 当前锁行为取代以上历史测试：所有非 dry-run 实例共用成员锁；正常退出释放，任何残留锁均拒绝自动接管。升级前必须停掉所有旧版哨兵及启动器；异常退出后确认无持有者，再由人工离线处理残留。旧版仍可能删除新版锁，因此不能混跑；不承诺自动接管或回滚。
- `sentinel-supervisor.mjs` 隔离测试覆盖初次启动、代码变更重启及语法错误保留旧版；Windows 外部终止 supervisor 后曾观察到子进程退出但锁残留。IPC 断连排空方案复测仍残留锁，不能承诺自动恢复；需确认所有新旧进程停止后由人工离线处理锁，勿删除正在使用的锁。
- supervisor 正常更新先对候选语法检查，再请求旧哨兵排空并等待 `drained` 与进程退出；有待核对消息、未确认排空或候选异常退出时停止自动管理。语法错误保留旧进程；状态兼容性未知时不自动回退。日志就绪仅表示进程启动观察，不证明模型处理成功。
- supervisor 排空状态含待核对消息时，即使子进程已退出也视为交接失败；不得仅据进程退出判断任务完成。
- supervisor 记录子进程注册停止处理器前收到的停止请求，注册后再执行；隔离验证正常更新、语法错误保留、候选异常停止、待核对阻断和锁竞争。旧 EXE 首次迁移与数据库双向兼容仍未解决。
- 哨兵持久状态有 `pendingMessageId` 时停止处理，普通 `--after` 不得覆盖该标记；停止全部哨兵后先核对服务端消息及各目标的发送情况，再人工处理状态文件。多目标部分成功及发送结果不确定时不得直接重放。
- 存在 `completedOutOfOrder` 乱序完成记录时也禁止 `--after` 覆盖状态，避免跳过或重复处理；先停止哨兵并人工核对后再恢复。
- 哨兵回复使用 `clientMessageId=sentinel:<原消息ID>`；相同成员和对话的相同内容可由服务端去重，内容不同返回 409。生成结果及多目标进度未完整持久化，发送不确定仍须人工核对，不能自动重放。
- 原生客户端由 `hot-launcher.mjs` 监视源码并重新编译到独立版本目录，不覆盖运行中的 EXE。`run` 通过父子标准输入输出管道启动具备 `--hot-control` 的窗口；源码更新只允许服务模块与 `public/` 内容完全一致的 GUI 候选自动切换。服务或数据库语义变更仅暂存，不能自动降级旧服务读取含 `toAdmin` 私信的新库。
- 切换顺序：独立合成测试库预检候选 → 冻结旧窗并排空在途请求 → 通过管道传递当前对话及各对话草稿、收件人、待上传附件 → 停旧服务但保留旧窗口 → 候选恢复并保持冻结 → 确认候选就绪后退出旧窗 → 更新 `current.json` → 激活候选。准备失败时保留旧窗；结果不确定或已上传未确认附件阻止自动交接。草稿不写普通 JSON 交接目录。
- 控制管道是父子进程持有的能力边界，不是同一 Windows 用户下的沙箱。候选和旧窗在控制器断连后保留草稿；候选先停止自己的服务，旧窗有限重试恢复。旧窗已退出时，候选提供人工确认后恢复入口，不删除锁或恢复旧数据库备份。
- Windows 控制器异常终止曾导致两窗同时消失，已定位为非 detached 子进程生命周期；客户端改为独立启动并保留控制管道，实际崩溃与非空草稿完整验收结果以本次验证记录为准。首个不具备协议的旧 EXE 不能被注入接管接口，首次部署需一次正常退出。
- `sentinel.config.json` 的 `promptSupplement` 最多 8000 字符，随配置校验通过后下一轮生效；不能替代硬编码安全约束。`execModel` 可为空。配置按文件内容比较，解析或校验失败保留旧配置；核心路径与锁域变更须重启。
- `hot-launcher.mjs install --store <目录>` 构建候选；首次 `preflight --store <目录> --data-dir <脱敏测试库目录> --sanitized-test-data yes` 只接受临时目录内显式脱敏测试库，用 SQLite 在线备份检查副本完整性及两次启动的 schema。自动更新使用程序新建的合成测试库，不复制正式库。以上均不证明任意版本间行为兼容。
- 预检通过原生句柄持续锁定源库及祖先目录，拒绝重解析路径、硬链接、路径替换及活跃源库写者；从校验后的句柄复制库和现存 sidecar 到受限隔离目录后才调用 SQLite backup，不在外部源目录打开 SQLite。已实测目录/祖先/数据库改名被阻止、写者被拒、junction/hardlink 被拒及静态 WAL 备份保留已提交行；文件 symlink 注入受本机权限限制未覆盖。不承诺同用户恶意进程沙箱。
- 用户已授权为实现热更新重置旧聊天室数据；在正式部署前仍须停净旧窗口、服务、哨兵与启动器。重置不解决进程间草稿丢失或候选故障；不能靠清库冒充热更新。
- 2026-11-01 恢复全部阻塞项后，正式桌面 Controlled Updates 入口已部署（原 data、4317、独立 hot 版本目录）；真实两次非空草稿自动切换、正常关闭释放端口和重启就绪通过，保留34成员记录、216消息，完整备份未删除。发布包不含数据或身份。
- 同版本受控故障专项：双对话草稿/收件人/附件字段往返、错误requestId拒绝、候选失败回旧窗、停旧服务后强杀控制器恢复、服务变化仅暂存及schema变化拒绝均通过。五处控制响应日志不再打印对象原文，敏感草稿canary实测不出现在诊断中。
- 真实Windows高对比运行中开/关通过：10成员11收件项、F4/方向键/Enter/Tab、全树系统色及普通色恢复、草稿/收件人保留；修复监听主题广播和动态控件继承色。两层恢复核对14注册表key、31色、主题、壁纸通过。历史runtime默认方案名空→黑色缓存仍存在，支持API空scheme尝试成功返回但未改变读回，未继续风险操作；这不影响当前关闭状态。
- 最新 `node --test chat.test.mjs` 12/12通过，包含45秒心跳边界；实际原生/受控运行证据存发布包verification，不以测试代替UI验收。
- 第二轮审计修复已合入源码；既有Eval内核验证私信标题隔离（真实内存SQLite）、MCP帧UTF8字节边界、哨兵跨chunk UTF8/close排空/stdin错误处理及JS语法。遵守人工不启动进程要求，未跑完整测试、编译C#或更新EXE/发布包；上面的12/12属于上一轮，不覆盖本轮修复。
- 群工具新版已独立编译，最终完整 `node --test` 62/62通过，0失败/跳过；新增ERC-20付款钱包sender绑定和重放/重组/确认数测试。原生群工具窗口六项真实交互通过。新模块列入hot候选文件及serviceDigest；现有数据库启动时创建新表，旧EXE/数据未覆盖，服务代码变更仍不自动激活。
- 群工具审计版：70/70全量通过，三个支付claim状态缺陷及原生旧付款URI未失效已复现/修复；增加聚合覆盖索引与管理员历史有序索引，结果不截断。新发布在local-agent-chat-release-grouptools-audit-20261101，保留旧产物。既有错误历史claim不自动释放，需人工证据；支付信任RPC且payer地址不是签名身份。
- MCP1.1.0新增9个具名群工具，15秒群工具HTTP期限，管理权限不开放。完整70/70回归及隔离真实stdio握手/发现/调用/幂等/禁言读写烟测通过；连接文档JSON示例按实际schema验证，桌面副本按SHA256一致同步。更新桥文件不重启用户连接，需人工在客户端重载。

未承诺：多语言完整翻译包、公网部署、操作系统沙箱、模型自动复活、客户端持久化执行去重、MCP并发/取消、任意服务版本双向数据库兼容。受控管道仅覆盖当前协议草稿跨进程交接；不会把服务代码或schema变化自动切入正式库。

## 9. 发布、备份与回滚

1. 停止目标服务；备份完整正式数据目录及目录外身份文件，记录对应源码/EXE版本。备份是正式敏感产物，应位于明确的工程备份位置，不放待清理temp。
2. 在临时库验证并构建。交付完整运行目录，不将测试身份/数据库/令牌打包进去；二进制与源码保持同次构建。
3. 只在入口路径改变时重建快捷方式；目标不变无需反复重建。新MCP工具发布后通知客户端重载。
4. 维护本文、README、CONTRACT和MCP各自权威范围；桌面MCP文档从MCP.md同步，禁止双向合并。
5. 回滚先停止服务。只回退EXE不足以回退已变更的数据库；须检查schema兼容性，必要时恢复匹配备份。恢复会损失备份后的新记录，必须先告知用户并获准，不能擅自覆盖。
6. 本次用户要求全部规划项完成后再统一清理过程文件；完成前保留测试脚本、截图、版本与日志。最终清理前确认没有自有进程持有文件，再运行 `node D:/OMP/.omp/bin/clean-temp.mjs --all`；不清理工程 data 或桌面产物，避免影响并行任务。

### 启动入口的安全告警

火绒检测记录将测试受控更新 LNK 标记为 `TrojanDownloader/LNK.Agent.g`；旧入口包含隐藏 PowerShell 与执行策略绕过。当前源码已改为 LNK 直接指向 Node、显示控制器终端，预检使用可审查的 `native-preflight.ps1` 而非编码命令，不绕过执行策略。`create-shortcut.ps1 -ControlledUpdates -WhatIf` 仅预览，不创建文件。不能通过恢复隔离项、关闭防护、加白、混淆或改名躲避检出；新入口未获杀软结论前不得称为安全或误报已解决。告警文件及隔离元数据保留，不重新生成同类测试 LNK。


### GitHub 源码仓库

- 远程：`https://github.com/Brian98Z/local-agent-chat.git`，分支 `main`，保留远程原有 `LICENSE`。
- 提交源码、构建脚本、图标与文档；排除 `data/`、数据库、身份文件、环境秘密、日志与生成的 EXE。编译后的客户端由构建命令生成，不把源码推送描述为已发布安装包。
- 凭据从用户指定配置在内存中读取，不写入仓库、远程URL、提交信息或日志。推送前审查待提交文件清单；不强推覆盖他人提交。
- 本机 Git HTTPS 首次传输遇连接重置/空响应，可改用官方 Git Data API。令牌须对目标仓库具备 Contents: Read and write；仅能读取仓库不代表能创建blob。API方式必须保留原main为父提交、检查远程未变化、非强制更新引用并核对提交与文件树。凭据权限不足时保留本地提交，授权后继续，不改用公开凭据或强推。


### 桌面副本同步

先编辑项目 `MCP.md`，再在 PowerShell 执行下面命令。它通过实际桌面路径生成中文文件名，覆盖同名接入文档副本；不碰快捷方式或其他桌面内容。

```powershell
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$name = 'Agent' + [string][char]0x672C + [char]0x5730 + [char]0x804A + [char]0x5929 + [char]0x5BA4 + '-MCP' + [char]0x8FDE + [char]0x63A5 + [char]0x6587 + [char]0x6863 + '.md'
Copy-Item -LiteralPath 'D:/OMP/project/local-agent-chat/MCP.md' -Destination (Join-Path $desktop $name)
```

同步后比对两个文件的 SHA-256；这是文档副本，不是另一份权威协议。工作区规则和客户端AGENTS未因本项目整理而改变。
