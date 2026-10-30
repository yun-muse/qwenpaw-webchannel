# QwenPaw WebChannel · 自建 Web 前端通道

[![CI](https://github.com/yun-muse/qwenpaw-webchannel/actions/workflows/ci.yml/badge.svg)](https://github.com/yun-muse/qwenpaw-webchannel/actions/workflows/ci.yml)

让运行在容器里的 QwenPaw agent 拥有一个可安装到手机的 Web 前端：浏览器只连 relay，插件从容器**主动外连**，不需要开放任何入站端口，也不需要改动 QwenPaw 本体。

**在线实例**：[SPA](https://qwenpaw-webchannel-spa.pages.dev) · [Relay 健康检查](https://qwenpaw-webchannel-relay.yxliwangsheng.workers.dev/health)

## 功能（以 M38 代码为准）

- **流式对话**：`start` / `evt` / `end` / `msg` 逐 delta 推送，思考和正文分成两个 `stream_type`，前端不会把推理内容混进回答（`plugin/channel.py`、`protocol/frames.md` §2.3）。
- **多会话 / 多标签同步**：每个 chat 独立 `seq` 和 400 帧环形缓冲，重连用 `resume` 补发、缺口用 `resync` 重载；relay 把 agent 的帧广播给所有标签页。重连时只自动 resume 当前会话，其他会话在切换过去时重新拉 `hist`。会话列表与删除走服务端（`chats` / `del_chat`），重命名由 `rename_chat` 回执后保存在浏览器本地（`webchannel.chatNames`），置顶与标签也只在本地。
- **会话组织与导航**：侧栏支持置顶分组、标签与筛选、`⌘/Ctrl+K` 命令面板（动作 + 会话），全文搜索命中后能滚到那条消息并闪一下；归档里才存在的命中会明确标注“仅归档”（M19、M23、M26）。
- **按 agent 切换模型**：`models` / `set_model` 复用 QwenPaw 的模型选择逻辑，只把 `{provider, model, active, vision?}` 发到浏览器，凭据字段不出插件（`plugin/util.py::model_items`）。
- **`/` 命令与 `@skill`**：输入框上方的命令面板（模型、技能、新会话、停止、提示词、重命名、删除、清屏、主题、帮助）和 `@` 技能挂载；技能列表优先来自 `/api/skills`（失败时回退到技能注册表 / `agent.json`），也可直接在 SPA 里编辑 `SOUL.md` / `AGENTS.md` / `PROFILE.md` / `MEMORY.md`。
- **推理强度选择**：`default | low | medium | high | max`，`default` 即 QwenPaw 的 `inherit`；budget 模型会换算成 `budget_tokens`，effort 模型只发它声明过的档位，状态以服务端 `chat.meta` 为准；新会话还没建 `ChatSpec` 时（404）静默保留选择，等第一轮结束后再落地。
- **PWA 刷新 + 白屏自愈**：`version.json` 轮询发现新构建后，先让新 Service Worker 接管（`controllerchange`，4 s 上限）再 reload；清缓存由 worker 的 `activate` 负责，页面从不自己删缓存。`index.html` 里另有一段不依赖 bundle 的内联 splash + 12 s 看门狗，bundle 加载失败或超时只自愈一次（10 分钟内不重复），仍失败则显示重试卡片（M29）。
- **30 天免登录**：relay 签发 30 天有效的客户端 token，SPA 存在 localStorage 并本地预检过期时间；连续 3 次握手未打开才回到登录页（`relay-cf/src/index.ts`、`spa/src/relay.ts`）。
- **每轮用量回执 + 上下文仪表 + 用量看板**：`hist.messages[].turn` 和 `usage.last_turn` 给每条回答挂上本轮 token；输入框上方显示上下文占用（≈ 估算），桌面端同时显示会话累计 `↑ ↓`。看板（`stats` 帧）给出全部会话的输入/输出/缓存命中/未命中/命中率、按天分桶（含每日缓存条）、按模型明细与会话排行，没上报缓存的模型显示 `—` 而不是 0%（M24、M28）。
- **导出、批量导出与备份**：单会话 Markdown 走 `export` → `export_begin` / `export_chunk` / `export_end`，分块传输、sha256 校验、上限 10 MB，文档头带元数据与每轮用量脚注；“导出全部”串行导出服务器列表（上限 100，可取消，失败逐条计数）；“备份全部”打成一个 store-only ZIP（`index.md` + `backup.json` + 每个会话的 `.md`，与单会话导出逐字节相同），全程在浏览器里完成（M20、M25、M34）。
- **Turso 归档全文搜索**：插件把对话 best-effort 写入 Turso，`search` 在 `messages` / `chats` 上做参数化 `LIKE`，只回 snippet 和命中位置。
- **心跳自愈**：`hb` / `hb_ack` 端到端探测（15 s 一次、10 s 未回、连续 2 次失败重连），配合连接阶段监管和退避重连；只有 close 4000、`E_AUTH`、HTTP 401/403 或显式 `stop()` 才终止。
- **附件（10 MB 分块 + 历史回看）**：`file_begin` / `file_chunk` / `file_end`，96 KB 一片、sha256 校验、10 分钟暂存；成功后用 `{"ref": id}` 引用。图片以 `FileContent` + `ImageContent` 双 part 交给多模态模型，`hist.messages[].files` 带名称/类型/大小（按 URL 去重、纯附件轮次保留），历史里的缩略图与下载走 `att_get` → `att_begin` / `att_chunk` / `att_end`（opaque ref、10 MB 上限、media_dir 路径守卫）。单条消息最多 10 个附件、合计 10 MB（M31、M35）。
- **数学公式**：行内 `$…$` 与行级 `$$…$$` 由标记扩展解析成惰性占位符，KaTeX 只懒加载一次；代码块/行内代码内不解析、未闭合的公式退回纯文本、`$5 and $10` 这类货币写法有专门守卫（M36）。
- **离线队列与草稿**：浏览器能观测到的离线（socket 不在 `live`，或 `ready` 明确说 agent 离线）里点发送会进入每会话 FIFO 队列（`webchannel.outbox`，每会话 20 条 / 全局 100 条），重连且 agent 在线后按序走同一条 `msg` 路径发出；已经写进 socket 的条目**永不自动重发**，靠历史尾部核对确认送达，其余标“未确认”交给用户重试。带附件的消息离线时明确拒绝排队（暂存 10 分钟会过期），草稿（`webchannel.drafts`）则是“还没发”，两者互不混用（M22、M37）。

## 架构

```mermaid
flowchart LR
  SPA["浏览器 SPA<br/>React + Vite / PWA"] -->|"WebSocket /ws/client"| RELAY["Cloudflare Worker<br/>+ Durable Object（relay-cf）"]
  RELAY -->|"WebSocket /ws/agent<br/>（容器主动外连）"| PLUGIN["QwenPaw 插件<br/>plugin/（WebChannel channel）"]
  PLUGIN -->|"manager 队列<br/>+ 本地 HTTP API :8088"| AGENT["QwenPaw 工作 agent<br/>会话 / 模型 / 工具"]
  PLUGIN -.->|"Turso /v2/pipeline<br/>（可选，best-effort）"| TURSO[("Turso 归档")]
  RELAY -.->|"agent 离线时缓存<br/>client→agent 帧"| STORE[("Durable Object storage")]
```

- 浏览器永远不直接连容器；relay 只做配对和逐字转发，不解析业务帧，也不存储消息内容（唯一的持久化是 agent 离线时的 client→agent 缓冲）。
- 一个容器对应一个 agent socket；`relay-cf` 的单个 Durable Object 持有该租户的全部 socket。
- 本地开发可以用 `relay-node`（`ws` 一个依赖）替代 Cloudflare，SPA 和插件代码不用改。

## 仓库结构

| 目录 | 内容 |
|---|---|
| [`plugin/`](plugin/README.md) | QwenPaw 通道插件（Python）：relay 客户端、帧、流式、附件、模型、推理强度、用量、导出、搜索、Turso 归档 |
| [`relay-cf/`](relay-cf/README.md) | 生产 relay：Cloudflare Worker + Durable Object（TypeScript） |
| [`relay-node/`](relay-node/README.md) | 本地开发 relay（Node.js，仅依赖 `ws`），协议行为与 `relay-cf` 对齐；不做客户端鉴权和限流 |
| [`spa/`](spa/README.md) | 浏览器前端：React 18 + TypeScript + Vite 5，含 PWA 与移动端布局 |
| [`protocol/`](protocol/frames.md) | 帧协议：信封 v1，累加修订到 v10 |
| [`docs/`](docs/README.md) | 设计文档、部署记录与各里程碑报告 |
| [`mock/`](mock/README.md) | 假 agent，用于在没有 QwenPaw 的情况下跑通本地链路 |
| `tools/` | `package_plugin.sh`（可复现 ZIP）、`verify_release.py`（线上发布一致性）、`relay_lockstep.py`（两个 relay 的规则对齐）、`live_spa_probe.mjs`（线上首访行为）、`turso_history.py`（归档回读）、`soak_probe.mjs`（生产探活）、`oc_prompt.py` |
| `tests/` | Playwright / WebSocket 端到端脚本：`e2e_m19.mjs`（SPA 全量）、`e2e_m29.mjs`（PWA）、`e2e_cf.mjs`（relay-cf 本地 workerd）、`mobile_e2e.mjs`（生产移动端） |
| `tasks/` | 各里程碑的任务书（开发过程资料，不是产品文档） |

## 快速开始

每个组件都有独立的 README；最短的本地链路是「relay-node → mock agent → SPA」：

| 组件 | 命令 | 文档 |
|---|---|---|
| 本地 relay | `cd relay-node && npm install && npm start` | [`relay-node/README.md`](relay-node/README.md) |
| 假 agent（可选） | `cd mock && npm install && npm start` | [`mock/README.md`](mock/README.md) |
| SPA | `cd spa && npm install && npm run dev` → http://localhost:5173 | [`spa/README.md`](spa/README.md) |
| QwenPaw 插件 | `bash tools/package_plugin.sh` → 安装 `dist/webchannel.zip` | [`plugin/README.md`](plugin/README.md) |
| relay-cf（本地 wrangler） | `cd relay-cf && npm install && npm run dev` → http://localhost:8788 | [`relay-cf/README.md`](relay-cf/README.md) |

本地默认值：relay 在 `127.0.0.1:8787`，SPA 在 `5173`，插件连 `ws://127.0.0.1:8787/ws/agent`；没有登录门，Turso 归档/搜索默认关闭。

## 部署概要

完整步骤与已验证的输出见 [`docs/m3-deploy-cf.md`](docs/m3-deploy-cf.md)，逐条清单见 [`docs/m3-plan.md`](docs/m3-plan.md)。

1. **Relay**：`cd relay-cf && npx wrangler deploy`。三个 Worker secret 只按名字设置：`AGENT_TOKEN`、`LOGIN_PASSWORD`、`LOGIN_SECRET`（`npx wrangler secret put <NAME>`）。首次部署会应用创建 `RelayDO` 的 `v1` migration（`relay-cf/wrangler.toml`）。部署后用 `GET /health` 确认 `ok:true`。
2. **SPA**：用 `VITE_RELAY_WS` / `VITE_RELAY_HTTP` 指向 relay 后 `npm run build`，再发到 Pages 项目 `qwenpaw-webchannel-spa`：
   ```bash
   cd spa
   VITE_RELAY_WS=wss://<relay-host>/ws/client \
   VITE_RELAY_HTTP=https://<relay-host> \
   npm run build
   npx wrangler pages deploy dist --project-name qwenpaw-webchannel-spa --branch main
   ```
   `--branch main` 不是可选项：不带它时第一次部署会继承本仓库的 git 分支而落到 preview，生产根路径返回 404（`docs/m3-deploy-cf.md`）。
3. **插件（hosted 容器）**：`bash tools/package_plugin.sh` 生成 `dist/webchannel.zip`（`plugin.json` 在 ZIP 根目录），把它发布到 Pages 项目 `qwenpaw-plugin-dist`，即 <https://qwenpaw-plugin-dist.pages.dev/webchannel.zip>；上传后回下载一次比对 MD5，避免装到旧包。已验证的安装路径（最近一次是 M15）：
   1. 在 QwenPaw 控制台的 **Web Terminal** 里 `curl` 下载该 ZIP，解压到容器内的暂存目录；
   2. 控制台 → Plugins → 先 **Uninstall** 旧插件，再打开 **Install**，在 **"or from URL"** 字段里填**本地路径**（该字段接受容器内的本地目录），指向暂存目录（目录根需有 `plugin.json`，解压出来即是）；
   3. 确认 Channels 页面出现 **Web** 卡片、字段无误后，做一次平台 **Restart**。

   装好后 `GET /api/plugins` 里 `webchannel` 应为 `"loaded": true`。**不要**把插件目录直接拷进 `PLUGINS_DIR`（`WORKING_DIR/plugins/webchannel`）再重启：这样会跳过按 agent 的通道注册，**Web** 卡片不会出现，通道会卡死且重启也救不回来——这不是可用的备用路径。详细步骤见 [`plugin/README.md`](plugin/README.md)。
4. **启用通道**：在目标 agent 的 **Web** 卡片填 `relay_url`（hosted 用 `wss://…/ws/agent`）和 `token`（值等于 Worker 的 `AGENT_TOKEN`，只填值，不要写进仓库）。
5. **Turso（可选）**：填 `turso_url` / `turso_token` 后，归档写入与全文搜索才启用；表结构由归档器在启动时 `CREATE TABLE IF NOT EXISTS` 自动创建（`plugin/turso_archive.py`）。
6. **升级顺序**：心跳协议变更时先部署 relay、再重装/重启插件。旧 relay 不会 ack `hb`，会让新插件反复重连（`docs/m7.3-report.md`）。
7. **部署后自检**：`python3 tools/verify_release.py`。它把线上 `version.json` / `sw.js` / 入口 bundle / 内容哈希资源与 HEAD 的新构建比对、
   用确定性重建核对 plugin-dist 的 ZIP、检查 `/health` 与 `/poll`，以及线上 `index.html` 里的内联看门狗标记。
   其中 **“live bundle is relay-wired”** 这一项专门防“构建时忘了带 `VITE_RELAY_WS` / `VITE_RELAY_HTTP`”：
   少了它，页面能打开但首访连的是 127.0.0.1。再用 `node tools/live_spa_probe.mjs` 在真实浏览器里确认首访看到登录框；
   全绿才算发布完成（最近一次结果与一个反例见 [`docs/m38-report.md`](docs/m38-report.md) §0）。

## 协议

[`protocol/frames.md`](protocol/frames.md)：一条 WebSocket 文本消息一个 JSON 对象，必填字符串 `t`，未知字段和未知 `t` 必须忽略。当前是**信封 v1 + 累加修订到 v10**：

| 版本 | 内容 |
|---|---|
| v1 | 基础帧、握手机制、`seq` / `resume` / `resync`、256 KB 上限 |
| v2 | 分块文件上传（10 MB） |
| v3 | 模型列表与切换、`hb` / `hb_ack` 端到端心跳 |
| v4 | 会话推理强度 |
| v5 / v8 | 会话用量与每轮回执 |
| v6 | Markdown 导出 |
| v7 | Turso 归档全文搜索 |
| v9 | 全会话用量看板（含缓存与按模型明细） |
| v10 | 附件的 `hist.files` 投影、`att_*` 回取与 `models.vision` |

`models` / `model_changed` / `status` / `effort` / `usage` / `stats` / `export_*` / `search_results` / `att_*` 是**控制帧**：没有 `seq`、不进环形缓冲、不在 `resume` 时重放。

## 诚实的边界

- **导出只是当前上下文视图**。Markdown 由 `GET /api/chats/{ChatSpec.id}` 的 `ChatHistory` 渲染（`plugin/channel.py::_handle_export`），不是从 Turso 或完整事件日志重建。后端若已压缩上下文，早期轮次以历史接口实际返回为准；附件只记录文件名等元信息，不含内容；单次导出上限 10 MB。文档头部的「导出口径」也写明了这一点（`plugin/util.py::EXPORT_BASIS`）。
- **搜索只覆盖已归档的内容**。归档是 best-effort：有界队列、失败重试后丢弃，所以“搜不到”不等于“没说过”。查询是 `messages JOIN chats` 上的参数化 `LIKE`（不是 FTS 索引），每页最多 50 条，只回 snippet；未归档的轮次不可见（`protocol/frames.md` §13.3）。
- **审批默认是自动放行的**。协议、插件和 SPA 都有审批卡片与 `req_id` 归属校验（A5），但 hosted 的 `work` agent 没有 `tool_guard` / `file_guard`，`approval_level` 是 `AUTO`，所以工具调用根本不会触发审批；真实审批往返至今没有在 hosted 环境观察过（`docs/m3-findings.md`）。
- **用量是估算**。`context_tokens` 取最近一轮的 `last_prompt_tokens` → 状态估算 → `prompt_tokens`（`basis=last_turn_prompt`），不是实时 tokenizer；没有可用记录的轮次没有 `turn`，SPA 显示为“无数据”而不是 0。看板的缓存命中率只统计 provider 明确上报缓存的轮次，未上报的行显示 `—`。
- **离线队列只覆盖浏览器看得见的离线**。两个 relay 都不向浏览器广播 agent 的上下线，所以“socket 还开着、agent 中途掉了”在 SPA 侧无法区分，这段窗口仍靠 relay 自己的离线缓存兜底（node 内存 / DO storage，500 帧 / 1 MB，超限丢最旧）。已经写进 socket 的条目永不自动重发，没被历史证实的只会标成“未确认”，由用户决定重试（M37）。
- **relay 是单租户的**。一个部署一个 `TENANT`（`wrangler.toml`），30 帧/秒的令牌桶由该租户的所有 socket 共享；relay 不持久化消息内容，agent 离线缓冲上限 500 帧 / 1 MB。

## 开发与测试

插件测试是纯 Python 断言脚本，不需要 pytest（21 个套件，需要 `httpx` / `websockets`，CI 里单独安装）：

```bash
cd plugin
for suite in tests/test_*.py; do python3 "$suite" || exit 1; done
# 每个脚本结束打印 ALL PASS；本机没有 httpx 时用带 QwenPaw 依赖的 venv 跑
```

SPA 有 vitest 单元测试（19 个文件，纯逻辑、无 DOM/网络）：

```bash
cd spa && npm test      # 305 tests
```

仓库根目录的 `tests/e2e_*.mjs` 是 Playwright / WebSocket 端到端脚本：

| 脚本 | 覆盖 | 依赖 |
|---|---|---|
| `e2e_m19.mjs` | SPA 全量（desktop + mobile，505 checks） | 会自己 build、起 relay-node + mock agent + vite preview |
| `e2e_m29.mjs` | PWA 冷启动 / 版本接管 / 自愈（26 checks） | 自带可控 503/延迟服务器 |
| `e2e_cf.mjs` | relay-cf 行为（10 断言） | 需要 `wrangler dev --local` 在 :8788 与 `relay-cf/.dev.vars` |
| `mobile_e2e.mjs` | 生产移动端布局与用量回执取证 | 需要登录密码，默认打线上 |

线上发布一致性用 `python3 tools/verify_release.py`，两个 relay 的规则对齐用 `python3 tools/relay_lockstep.py`；
两者的检查项与最近一次结果见 [`docs/m38-report.md`](docs/m38-report.md)。
