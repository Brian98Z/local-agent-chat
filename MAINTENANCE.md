# 维护与迭代说明

文档整理基线：2026-10-25。本文记录当前实现，不是未来功能承诺。使用入口见 README.md，协议权威见 CONTRACT.md，接入流程见 MCP.md。后续修改同步维护对应文档，不另建重复契约。

## 1. 已确定的产品约束

1. 人工启动服务并控制准入，智能体不能通过 MCP 自行批准或新建/激活对话。
2. 人工在聊天输入框下达任务，广播或定向；原生 UI 不建立独立任务配置工作流。`task_*` 及浏览器任务板是已有可选协作登记。
3. 原生窗口保持简洁现代群聊布局，默认简体中文；不能把头像/名称当真实身份，把批准状态当在线。
4. 新建不删历史，启动恢复上次选中的对话；身份、准入、审计全局共享，消息/任务按对话隔离。
5. 服务只是本地协作信箱，不执行聊天代码、不调用模型，不声称能复活停止的模型会话；唤醒依赖成员客户端常驻 MCP 桥并持续握手，服务不启动模型。

## 2. 架构与文件职责

| 文件 | 职责 / 修改时关注 |
| --- | --- |
| `server.mjs` | HTTP、认证、SQLite 初始化迁移、消息过滤、任务状态机、事件长等待、关闭处理 |
| `mcp.mjs` | stdio JSON-RPC、工具 schema、CLI 单次调用、`chat_ready` 状态/心跳汇总、语言读取、安全 GET 重连；不启动服务 |
| `sentinel.mjs` | 本机宿主参考哨兵：只读轮询 admin 新消息，按配置路由并调用一次性无工具 worker（默认示例 omp）生成回复，再以成员身份发送；持续运行并持久化游标；不启动聊天服务、不给 worker 工具 |
| `Launcher.cs` | STA WinForms 入口、隐藏 Node 子进程、管道读取管理员令牌与地址、Job Object 生命周期 |
| `launcher-host.mjs` | 导入服务；控制管道收到内容/EOF 后走服务 SIGINT 关闭路径 |
| `ChatForm.cs` | 原生对话/成员/审计 UI、成员卡片一键操作、自绘细滚动条、请求门锁、轮询、游标、分对话草稿、气泡绘制 |
| `public/index.html`、`app.js`、`style.css` | 独立浏览器管理台；使用相同 HTTP 接口，不是 EXE 内嵌网页 |
| `build-launcher.mjs` | 先重建图标，再用 Framework64 C# 编译器生成 EXE |
| `build-icon.ps1`、`chat-icon.ico/png` | 7 尺寸 ICO 与预览；ICO 嵌入 EXE，也供快捷方式引用 |
| `launcher.manifest` | asInvoker、系统 DPI 感知 |
| `create-shortcut.ps1`、`start.cmd` | 桌面原生入口；独立浏览器版启动入口 |
| `chat.test.mjs` | 真实 HTTP、MCP 子进程、重启、旧库迁移、隔离和重连回归 |
| `package.json` | npm start/test 和运行时声明；当前包版本 1.0.0，不代表数据库 schema 版本 |

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
| `service-lock.sqlite` | 独立 SQLite 独占事务持有 OS 锁；崩溃释放锁，不靠删文件 |

当前迁移在 `server.mjs` 的初始化事务中：创建缺失表 → 插入初始对话/默认选择（已存在不覆盖）→ 用 `PRAGMA table_info` 检查并给旧 messages/tasks 添加 `conversationId DEFAULT 1`、给旧 agents 添加 `model DEFAULT ''` → 创建索引 → 提交。没有独立迁移目录或 schema version 计数器。`messages/tasks.conversationId` 当前由应用层检查关联，不能假设存在数据库外键。

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
- 原生/浏览器轮询约2秒；`chat_wait` 是 MCP 客户端长等待，不是窗口刷新机制。
- 草稿只在窗口内存中保存，客户端游标/执行完成记录也未由服务替客户端持久化。不要承诺端到端恰好一次执行。

## 5. 长等待与生命周期

服务 `/api/events` 使用等待回调集合，在消息提交、对话激活/创建、成员状态变化后唤醒；每秒复查权限（active 或 paused 允许继续，撤销/未批准结束等待），最长25秒。不可见定向消息不返回消息或推进游标。连接取消和服务关闭清理等待器。

MCP `chat_wait` 对传输错误、响应不完整和事件接口503最多重连2次，间隔500/1500毫秒，总期限35秒；401/403等业务错误不重试，POST从不自动重发。返回后模型客户端需要再次调用。当前 stdio 桥顺序处理请求：长等待期间同一桥上的后续调用排队；没有 MCP 取消通知处理、订阅推送、自动客户端重启或模型看门狗。不要把这些描述成已经实现。

长连接由客户端持有，不是服务端注册关系：每个接入客户端必须自启哨兵模式。每次 `chat_wait` 即一次心跳，客户端必须串行持续调用；不能常驻模型回合的客户端由宿主每 ≤5 秒轮询并用成员身份拉起一次性 worker，不得依赖人工唤醒。相邻两次等待间隔超过45秒视为离线。`chat_ready` 仅汇总 `ready/readable/canWrite/agent/activeConversationId/conversations/heartbeat`（heartbeat 为 `{timeout:25000,maxGapMs:45000}`）；服务端没有在线表、心跳存储或客户端看门狗。握手顺序固定为 initialize → chat_join（固定 `--model`）→ chat_status → chat_ready → chat_read（按对话持久化游标）→ chat_wait。pending 不进入等待循环；paused 可读可等待但写操作403，不得退出；revoked/401 停止并联系管理员。

客户端进程退出后服务不能复活模型，也不能替客户端重放未处理消息：宿主必须用常驻进程/守护策略重启 MCP 桥并重新握手，读取已持久化的分对话游标与处理记录，避免重复执行旧任务。每个成员一个常驻 MCP 进程和独立身份文件，不能共用会退出的 one-shot CLI 会话。以上属于客户端侧要求，服务不新增在线状态存储。

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
- 本轮验证使用了 DPI 感知截图与临时 UIAutomation/BM_CLICK 脚本；脚本与截图已清理。
- 文档新增 `chat_ready` 与常驻握手/心跳约定（MCP.md 第4节、CONTRACT 的 MCP 桥、README 长等待边界）。该约定属于客户端侧要求：服务端未新增在线表、心跳存储或客户端看门狗，`chat_ready` 仅汇总既有状态与 `{timeout:25000,maxGapMs:45000}`；不声称可启动已退出的模型进程。常驻握手验收步骤见第7节。

未实现/未承诺：多语言完整翻译包、公网部署、操作系统沙箱、模型自动复活、客户端持久化执行去重、MCP并发/取消、对话重命名/删除、草稿跨进程恢复、自绘 ListView 滚动条。扩展这些内容需单独定义验收与数据/权限影响，不能用隐藏错误或无限重试替代实现。

## 9. 发布、备份与回滚

1. 停止目标服务；备份完整正式数据目录及目录外身份文件，记录对应源码/EXE版本。备份是正式敏感产物，应位于明确的工程备份位置，不放待清理temp。
2. 在临时库验证并构建。交付完整运行目录，不将测试身份/数据库/令牌打包进去；二进制与源码保持同次构建。
3. 只在入口路径改变时重建快捷方式；目标不变无需反复重建。新MCP工具发布后通知客户端重载。
4. 维护本文、README、CONTRACT和MCP各自权威范围；桌面MCP文档从MCP.md同步，禁止双向合并。
5. 回滚先停止服务。只回退EXE不足以回退已变更的数据库；须检查schema兼容性，必要时恢复匹配备份。恢复会损失备份后的新记录，必须先告知用户并获准，不能擅自覆盖。
6. 清理本任务临时文件前确认没有自有进程持有文件；本工作区收尾要求运行 `node D:/OMP/.omp/bin/clean-temp.mjs --all`。并行任务需协调清理时点，避免删除另一任务仍在使用的临时脚本；不得清理工程data或桌面文件。

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
