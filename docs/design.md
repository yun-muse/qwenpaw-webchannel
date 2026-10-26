# QwenPaw 自建 Web 前端通道 · 设计文档

| 项 | 内容 |
|---|---|
| 版本 | v0.1（待实现） |
| 日期 | 2026-10-26 |
| 目标读者 | 作者本人 / 后续实现者 |
| 一句话 | 把 QwenPaw 当 agent 引擎，自建一个 ChatGPT 形态的网页，通过「容器出站 WS + 公网会合点」拿到**逐 delta 流式** |

---

## 1. 背景与目标

### 1.1 问题

官方免费托管实例（platform.agentscope.io）只提供浏览器 console 作为主界面，实际使用过慢。根因不在通道协议，而在前端：

- `console/src` 体积约 17MB（含 Monaco、Lexical、antd 全家桶）
- 聊天页 `console/src/pages/Chat/index.tsx` 单文件 **4821 行**
- 每个 SSE 事件都会触发大量 React re-render

### 1.2 目标

1. 自己的 SPA，形态对齐 muse.ai / ChatGPT：左侧会话列表，中间消息流，工具调用卡片，审批按钮，附件与产物预览。
2. **逐 delta 流式**（不是 1.5 秒一跳的分块刷新）。
3. QwenPaw 保持为唯一后端与唯一记忆体，不重写 agent 逻辑。
4. 前端可长期托管（静态站），容器侧改动最小。

### 1.3 硬约束

容器**没有任何入站端口**，外部无法向它发起 HTTP/WS 请求。所有连接必须由容器主动拨出。

> 这决定了架构：必须存在一个「双方都能连、且能转发增量帧」的公网会合点（下称 relay）。

---

## 2. 已验证事实（含证据）

| # | 事实 | 证据 | 对方案的影响 |
|---|---|---|---|
| F1 | 容器出站 WS 可用 | 实测：容器内 `websockets.connect('wss://ws.postman-echo.com/raw')` 回显成功 | relay 方案成立 |
| F2 | 通道是插件化注册的 | `app/channels/registry.py:18-37`（18 个内置 key）、`plugins/api.py:1551 register_channel` | 可写自有通道，不必 fork |
| F3 | 通道能拿到原始事件流 | `console/channel.py:434` `async for event in self._process(request)` | 插件可直接转发事件 JSON |
| F4 | **流式粒度因通道而异** | `base.py:597` `_STREAM_DELTA_MIN_INTERVAL_S = 0.0`；`telegram/channel.py:91` `_STREAM_EDIT_INTERVAL_S = 1.5` | 逐 delta 只能靠自定义通道或 console |
| F5 | 会话登记 / 停止 / 挂回是白拿的 | `base.py:524 _consume_with_tracker()` → `chat_manager.get_or_create_chat` + `task_tracker.attach_or_start` | 插件不用自己实现会话表 |
| F6 | 走 manager 队列会自动触发流式钩子 | `base.py:1374 consume_one` → `_run_process_loop` → `on_streaming_*` / `send()` | 插件只需"接线" |
| F7 | 内置 MQTT 通道无流式 | `mqtt/channel.py` 无 `streaming_enabled`、无 `on_streaming_delta`，只有整段 `client.publish` | 排除 MQTT 路线 |
| F8 | 假 Bot API 的流式是 1.5s 一块 | 同 F4，且最终渲染走 `sendRichMessage`（`do_api_request`） | 降级为备选 |
| F9 | localhost 请求免认证 | `docs/api-tutorial.zh.md`「Localhost 自动免认证」 | 插件可直调内部 HTTP API |
| F10 | 存在 Cloudflare 隧道能力 | `tunnel/cloudflare.py`（`cloudflared tunnel --url http://localhost:PORT`），当前仅 voice 通道使用 | 备胎方案 P3 的依据 |

---

## 3. 方案选型

| 方案 | 流式粒度 | 容器侧工作量 | 依赖 | 结论 |
|---|---|---|---|---|
| **P1：自定义 channel 插件** | **逐 delta** | ~200 行 Python | 插件安装权限 | **采用** |
| P2：假 Bot API（`base_url` 指向自有服务） | 1.5s/块 | 300+ 行 + 协议模仿 | 无需装插件 | 备胎（P1 装不上时） |
| P3：容器内跑 cloudflared 反曝 8088 | 逐 delta（复用 console SSE） | 容器零代码 | 进程保活、URL 会漂 | 应急验证用 |
| P4：内置 MQTT + 公共 broker | 无 | 零代码 | 公共 broker | 已排除（无流式） |

P1 被选中的核心理由：只有它同时满足「逐 delta」「重启自恢复」「不依赖 URL 漂移」「能接审批回调」。

---

## 4. 总体架构

```
┌────────────────────────────┐
│  容器（QwenPaw 实例）       │
│  ┌──────────────────────┐  │
│  │ WebChannel 插件      │  │   出站 WSS（主动拨，可穿越 NAT）
│  │  ├ 入站: enqueue     │──┼──────────┐
│  │  ├ 出站: send/stream │  │          │
│  │  └ ring buffer(seq)  │  │          │
│  └──────────────────────┘  │          ▼
│  Agent / tools / memory    │   ┌──────────────────┐
└────────────────────────────┘   │ relay            │
                                 │ (CF Worker + DO) │
                                 │ ├ 配对           │
     浏览器 ────────────────────▶ │ ├ 转发           │
     (SPA, Vercel/CF/WorkBuddy)  │ ├ 离线缓冲       │
                                 │ └ 鉴权           │
                                 └──────────────────┘
```

三条连接，两段 WS：

1. 容器 → relay：常驻，带 token，断线指数退避重连。
2. 浏览器 → relay：页面开着就连，带会话凭证。
3. relay 只做配对与转发，**不解析业务语义、不落盘消息内容**。

---

## 5. 组件设计

### 5.1 容器侧：WebChannel 插件

#### 目录结构

```
qwenpaw-webchannel/
├── plugin.json        # type: "channel"
├── plugin.py          # register_channel(...)：注册 config 字段
├── channel.py         # WebChannel(BaseChannel)
├── relay_client.py    # WS 客户端：重连、心跳、帧编解码
└── frames.py          # 帧 schema（与前端共用一份定义）
```

#### plugin.json 关键字段

```json
{
  "id": "webchannel",
  "type": "channel",
  "entry": { "backend": "plugin.py" },
  "dependencies": [],
  "qwenpaw_version": { "min": "2.2.0", "max": "2.3.0" }
}
```

> `dependencies` 为空是刻意的：`websockets>=15.0.1,<16` 本身就是 QwenPaw 的核心依赖（`pyproject.toml`），直接 `import websockets` 即可，**零新增依赖**，安装不会触发 pip。

#### 类骨架

```python
class WebChannel(BaseChannel):
    channel = "web"
    uses_manager_queue = True      # 交给 manager 排队，按 session 串行
    streaming_enabled = True       # 打开逐 delta 钩子
    _STREAM_DELTA_MIN_INTERVAL_S = 0.0   # 不节流，由前端合帧

    @classmethod
    def from_config(cls, process, config, on_reply_sent=None,
                    display_config=None, workspace_dir=None):
        # 注意：插件通道的 config 是 SimpleNamespace，必须 getattr 安全读取
        return cls(process=process,
                   relay_url=getattr(config, "relay_url", ""),
                   token=getattr(config, "token", ""), ...)

    def resolve_session_id(self, sender_id, channel_meta=None):
        meta = channel_meta or {}
        return f"web:{sender_id}:{meta.get('chat_id', 'default')}"
```

#### 入站（浏览器 → 容器）

收到 `msg` 帧后只做一件事：拼 native payload 丢进队列。

```python
native = {
    "channel_id": "web",
    "sender_id": user_id,
    "content_parts": [TextContent(type=ContentType.TEXT, text=text)],
    "meta": {"session_id": f"web:{user_id}:{chat_id}", "chat_id": chat_id},
}
self._enqueue(native)
```

之后 `manager → consume_one → _consume_with_tracker → _run_process_loop` 会自动完成：建 chat 记录、注册 task_tracker、调用流式钩子、调用 `send()`。**插件不需要自己写事件循环。**

#### 出站（容器 → 浏览器）

| 钩子 / 方法 | 发出的帧 | 前端行为 |
|---|---|---|
| `on_streaming_start` | `start` | 创建消息气泡（带 seq 起点） |
| `on_streaming_delta` | `evt`（累积文本或 delta） | 增量渲染 + 合帧 |
| `on_streaming_end` | `end` | 定格、渲染 markdown、落历史 |
| `send` / `send_content_parts` | `msg` | 非流式消息、工具结果、附件 |
| `send_approval_notification` | `approval` | 弹出批准/拒绝按钮 |

#### 复用内部 API（关键简化）

插件跑在容器内，可直接走 `127.0.0.1:8088`，按 F9 **免认证**：

| 需求 | 内部调用 |
|---|---|
| 拉历史消息 | `GET /api/chats/{chat_id}` |
| 审批准入 | `POST /api/approval/approve` / `deny` |
| 文件上传落盘 | `POST /api/console/upload`（或直接写 media_dir） |
| 会话列表 | `GET /api/chats` |

这样可以避免直接依赖 `ApprovalService` / `chat_manager` 的内部对象签名，升级时更抗改。

#### ring buffer 与补帧

- 每个 `chat_id` 一个 `deque(maxlen=400)`，存 `(seq, frame)`。
- `seq` 每 chat 单调递增，随帧下发。
- 浏览器重连带 `{t:"resume", chat, last_seq}`：
  - 命中缓冲 → 补发 `seq > last_seq` 的帧；
  - 未命中（间隔过久/容器重启）→ 回 `{t:"resync", chat}`，前端改拉 `/api/chats/{id}` 全量重建。

### 5.2 relay：Cloudflare Worker + Durable Object

选型理由：DO 的 **Hibernation WebSocket API** 让「一对空闲连接」不产生时长计费，且免费计划已包含 SQLite 版 DO（10 万请求/日、13000 GB-s/日）。

| 路由 | 用途 | 鉴权 |
|---|---|---|
| `GET /ws/agent` | 容器接入 | `Authorization: Bearer <agent_token>` |
| `GET /ws/client` | 浏览器接入 | 短期签名 cookie / JWT |
| `POST /api/login` | 换会话凭证（单用户口令） | 口令 |
| `GET /poll?cursor=` | 降级通道（容器侧长轮询） | 同 agent token |

DO 设计要点：

- 一个 DO 实例 = 一个 tenant（`idFromName(tenant_id)`），内部维护 `agent` 与 `clients[]` 两组 socket。
- 用 `state.acceptWebSocket()`（而非 `ws.accept()`）保证可休眠；角色信息用 `serializeAttachment({role})` 存，因为休眠会清内存。
- `setWebSocketAutoResponse(ping → pong)`，让心跳不唤醒对象，真正零成本。
- agent 掉线期间的客户端上行帧存 DO storage（上限 500 帧 / 1MB），agent 重连后按序补投。
- 所有转发都不解析 payload，只做 `role` 校验与大小限制。

### 5.3 前端 SPA

- 技术栈：Vite + React + TS；消息渲染建议直接用 `@agentscope-ai/chat`（官方 console 同款，npm 公开），省掉 markdown/代码块/工具卡片的地基。
- 托管：纯静态，Vercel / CF Pages / WorkBuddy 应用托管均可（不承担长连接）。
- 状态机：`idle → connecting → live → resuming → resync`，`resync` 时拉历史全量重建。
- 合帧：服务端不节流（`0.0`），前端用 `requestAnimationFrame` 合并高频 delta，避免每个 token 一次 setState。
- 上传：v1 走 base64 塞进 `msg` 帧（限制 10MB），容器侧解码落盘；v2 再考虑分片或直传。

---

## 6. 协议规范

### 6.1 帧格式

统一信封：`{ "t": "<type>", "id": "<可选>", ... }`，UTF-8 JSON，单帧上限 256KB（超出走附件）。

| 方向 | t | 字段 | 说明 |
|---|---|---|---|
| 容器→relay | `hello` | `token, instance, agent` | 接入握手 |
| 容器→浏览器 | `evt` | `chat, seq, data` | 原始 event JSON（与 console SSE 同构） |
| 容器→浏览器 | `msg` | `chat, seq, parts[]` | 完整消息 / 工具结果 / 附件引用 |
| 容器→浏览器 | `approval` | `chat, req_id, tool, severity, summary` | 待审批 |
| 容器→浏览器 | `resync` | `chat` | 缓冲未命中，请拉历史 |
| 容器→浏览器 | `pong` | — | 心跳应答 |
| 浏览器→容器 | `msg` | `chat, text, files[]` | 发消息 |
| 浏览器→容器 | `stop` | `chat` | 中断生成 |
| 浏览器→容器 | `approve` / `deny` | `chat, req_id` | 审批 |
| 浏览器→容器 | `resume` | `chat, last_seq` | 补帧 |
| 浏览器→容器 | `hist` | `chat, before?, limit?` | 拉历史 |
| 任一方 | `ping` | — | 心跳，25s |

### 6.2 握手与首帧

```
容器            relay            浏览器
 │ hello(token)   │                 │
 ├───────────────▶│                 │
 │   ready        │                 │
 │◀───────────────┤                 │
 │                │◀── login ───────┤
 │                │─── token ──────▶│
 │                │◀── ws/client ───┤
 │                │  attach client  │
 │                ├────────────────▶│ ready
 │◀── peer-online ─┤                 │
```

### 6.3 错误码

| code | 场景 | 处理 |
|---|---|---|
| `E_AUTH` | token 失效 | 容器侧停止重连并记日志；浏览器侧跳登录 |
| `E_BUSY` | 同 chat 已在生成 | 前端提示，不重发 |
| `E_TOOBIG` | 单帧超限 | 转附件通道 |
| `E_RESYNC` | 缓冲未命中 | 前端拉历史重建 |

---

## 7. 关键设计决策

| 决策 | 理由 | 代价 |
|---|---|---|
| 必须有 relay | 公共 broker 只转文本；1.5s 分块不满足"逐字"；容器无入站 | 多一个 150 行左右的 Worker |
| delta 不在服务端节流 | `0.0` 保留原始粒度，节流交给前端 | 带宽略高，靠前端合帧吸收 |
| 插件走 localhost 内部 API | 免认证、不绑定内部对象签名 | 依赖内部 API 稳定 |
| ring buffer 400 帧 | 覆盖一次典型长回答 + 短暂断网 | 内存占用约几 MB |
| v1 用 base64 传文件 | 不引入对象存储与签名流程 | 10MB 上限，大文件后续再说 |
| relay 不落盘内容 | 隐私与合规；DO storage 只存待投递帧 | 不支持跨设备长期历史（历史本就在容器里） |

---

## 8. 安全

1. **容器→relay**：`agent_token`（32 字节随机），首次配对时哈希存入 DO storage，后续比对。
2. **浏览器→relay**：单用户口令换短期 JWT（24h），HttpOnly cookie，`SameSite=Lax`。
3. **审批动作**：必须带 `req_id` + 会话绑定，容器侧校验 `req_id` 是否属于该 session，防越权批准。
4. **限流**：relay 侧按 tenant 限 30 帧/秒，单帧 256KB；容器侧对 `msg` 长度做二次校验。
5. **不暴露内部地址**：relay 无需知道容器的任何地址，纯 socket 配对。

---

## 9. 可靠性与降级

| 场景 | 行为 |
|---|---|
| 容器重启 | 插件随进程启动自动拨号；ring buffer 清空 → 前端收到 `resync` 后拉历史 |
| 浏览器刷新 | 重连带 `last_seq`，命中缓冲则无缝续流 |
| relay 侧 DO 被驱逐 | socket 保持、内存清空；靠 `serializeAttachment` 恢复角色，帧按需重建 |
| 企业网络掐 WS | relay 提供 `/poll?wait=25` 长轮询，容器侧自动降级（延迟 +150~200ms） |
| 双端同时打开 | 一个 chat 一个 run，多端广播同一份 `evt`（只读端降级为观察） |
| 消息重复投递 | 帧带 `seq`，前端按 `seq` 去重 |

---

## 10. 里程碑

| 阶段 | 内容 | 验收 | 估时 |
|---|---|---|---|
| **M0** | relay（本地 Node 版）+ 协议 + 前端骨架 + mock 容器客户端 | 浏览器看到逐字流式 | 0.5–1 天 |
| **M1** | 真插件接本地 QwenPaw（docker） | 真实 agent 逐 delta 流式 | 1–2 天 |
| **M2** | 审批、文件、历史、断线补帧 | 工具审批可点、刷新续流 | 1–2 天 |
| **M3** | relay 上 CF DO，插件热装到托管实例 | 公网可用、闲置不计费 | 0.5–1 天 |
| **M4** | 打磨：会话列表、明暗主题、移动端 | 日常可用 | 1–2 天 |

M0 不依赖容器，可立即开工；M3 依赖 §12 的两个待验证项。

---

## 11. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| ~~托管实例不允许装插件~~ | ~~中~~ | ~~高~~ | **已消除**（V2–V5：接口通、root、热装、零依赖） |
| 平台后续限制自定义插件 | 低 | 中 | 保留 P2/P3 备胎；插件是纯客户端插件，无特权行为 |
| **技能被通道白名单静默过滤** | **高** | 中 | 通道名固定 `web`；逐个 skill 补 `channels:["web"]`；前端做技能状态面板（§13.3） |
| 容器出站被限速/掐断 | 低 | 中 | 退长轮询；F1 已证 WS 可用 |
| CF 在中国大陆访问不稳 | 中 | 中 | relay 换 VPS（$3/月），协议不变 |
| 内部 API 升级变更 | 中 | 低 | 只用 4 个稳定端点，集中封装 |
| 平台条款不允许长期隧道/常驻连接 | 低 | 高 | P1 只是普通客户端连接，风险远低于 P3 隧道 |

---

## 12. 可行性验证（已完成）

| # | 验证项 | 结果 | 依据 |
|---|---|---|---|
| V1 | 容器出站 WS | ✅ 可用 | 容器内 `websockets.connect('wss://ws.postman-echo.com/raw')` 回显成功 |
| V2 | 插件系统在线 | ✅ 可用 | `GET localhost:8088/api/plugins` 返回已加载插件列表 |
| V3 | 容器权限 | ✅ root | 可直接写插件目录、重启进程，不受 UI 限制 |
| V4 | 插件热安装 | ✅ 无需重启 | `routers/plugins.py:410` 描述 "loaded immediately — no restart required"，安装后后台 reload 全部 agent |
| V5 | 插件依赖 | ✅ 零新增 | `websockets` 已在 QwenPaw 核心依赖中 |

### 12.1 安装方式（三选一，都可行）

```bash
# A. 远程 ZIP 热装（推荐，source 支持 http(s) URL）
curl -X POST localhost:8088/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"https://<你的静态托管>/webchannel.zip","force":true}'

# B. 本地目录热装（先把目录写进容器）
curl -X POST localhost:8088/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"/root/qwenpaw-webchannel","force":true}'

# C. root 直接落盘（最省事，但需重启进程）
cp -r qwenpaw-webchannel ~/.qwenpaw/plugins/   # PLUGINS_DIR = WORKING_DIR/plugins
```

装完在 Console → Control → Channels 会出现一张新的频道卡片，填 `relay_url` + `token` 并启用即可。

### 12.2 仍待验证（仅影响备胎方案）

- 容器能否跑 `cloudflared`（P3 应急路径用，主路径不依赖）。

---

## 13. 角色、系统提示词与技能（决定前端要预留什么）

### 13.1 系统提示词不是一个文件，是工作区里几个 md 拼出来的

`agents/prompt.py:50` 的拼装顺序：`AGENTS.md` → `SOUL.md` → `PROFILE.md`，再按配置开关注入 heartbeat 段与 memory 段（`_process_heartbeat_section` / `_process_memory_section`）。

实际文件在**每个 agent 自己的工作区**里：

```
~/.qwenpaw/workspaces/<agent_id>/
├── AGENTS.md     # 工作流、规则、工具使用规范（最长的一段）
├── SOUL.md       # 核心身份与行为原则（"你是谁"）
├── PROFILE.md    # agent 身份 + 用户画像
├── MEMORY.md     # 长期笔记（工具设置等）
├── BOOTSTRAP.md  # 首次见面流程
├── HEARTBEAT.md  # 定时自检清单
└── CONTACTS.md / MAIL_TRIAGE.md
```

模板在 `agents/md_files/zh/`（首次初始化时复制过去）。**改人格、改工作流 = 改这些 md，不用碰代码**，Console → Files 里可以直接编辑。

### 13.2 多角色 = 多 agent，不是同一 agent 换 prompt

| 层级 | 存放位置 | 内容 |
|---|---|---|
| 根配置 | `config.json` 的 `agents.profiles[]`（`config.py:2093`） | 只有 `id` / `workspace_dir` / `enabled` / `pinned` |
| 每 agent | `workspaces/<id>/agent.json`（`AgentProfileConfig`，`config.py:2451`） | 模型、channels、skills、记忆、权限 |

**建议：新建一个 agent（如 `work`）专供新前端，`default` 留给 console。** 理由不是洁癖：

- 记忆按 workspace 隔离（ReMe 知识库在 workspace 内），混用会互相污染
- 通道配置独立，避免 console 会话和你前端的会话混在一张列表里
- 模型路由可以不同（重活用强模型，随手问用便宜的）

### 13.3 ⚠️ 技能是按「通道白名单」过滤的（最容易踩的坑）

```python
# skill_system/registry.py:1261
def resolve_effective_skills(workspace_dir, channel_name) -> list[str]:
    ...
    channels = entry.get("channels") or ["all"]
    if "all" not in channels and channel_name not in channels:
        continue          # ← 静默跳过，不报错
```

通道名取自 `request.channel`，缺省 `"console"`（`runtime/builtin_commands.py:746`）。

**后果**：新通道命名为 `web` 之后，**每个要用的 skill 都必须在 manifest 的 `channels` 里加上 `"web"`（或直接写 `"all"`）**，否则在前端里怎么问都调不出来，而且现象是「静默失效」——不报错、不提示，只有日志里一行。

除了 `channels`，还有三个会静默 skip 的开关：`enabled`、`preload`、`requires.env`（缺依赖直接跳过）。

→ 前端侧应提供一个「技能状态」面板，把 `enabled / channels / 依赖缺失` 三类原因显式展示出来，否则排查成本极高。

### 13.4 联网搜索开箱可用

- 内置工具 `web_search` + `web_fetch`（`agents/tools/web_search.py`）
- 默认后端 **Tavily，源码注释写明是 keyless**（免费、有速率限制）；可切 `anysearch` / `firecrawl`（per-agent 配置）
- 被限流时返回提示，让模型退回 `curl`（`_SEARCH_FALLBACK_HINT`）
- 需要 JS 渲染的页面走 `browser` 工具（Playwright）或 `browser-*` skill

结论：**"能联网搜索"不需要额外 API Key，开箱就能用**，只要该 agent 的 `web_search` 工具没被禁用。

### 13.5 「work 模式」怎么落

代码里**没有**内置的 work mode，只有 `coding_mode` / `advisor_mode`（`app/routers/`）。而 `plugins/modes.py` 的 `ModeSpec` 是给插件的「模式包」：

```python
ModeSpec(
    name="work",
    is_active=lambda ctx: ctx.mode_name == "work",
    tools=(...), commands=(...), hooks=(...), prompts=(...),
    on_turn_start=...,
)
```

两条实现路径：

| 路径 | 做法 | 成本 | 适用 |
|---|---|---|---|
| **轻（先做）** | 建 agent `work` + 写一套 md（AGENTS 写工作流、SOUL 写语气）+ 打开所需 skill | 半小时，零代码 | 90% 的效果 |
| 重 | 写插件注册 `ModeSpec`，按会话激活，动态加工具/提示 | 半天~1 天 | 要"同一 agent 内切模式" |

### 13.6 前端必须预留的入口

| 入口 | 为什么必须 |
|---|---|
| Agent 切换（`X-Agent-Id`） | 否则只能跑 `default`，多角色白建 |
| 工具调用卡片 | 不然"调 skill / 联网搜索"完全不可见，用户以为没生效 |
| 审批按钮 | shell / browser 类能力会触发 tool_guard，不接就卡死 |
| 技能状态面板 | §13.3 的静默失效只能靠它暴露 |
| （v2）产物文件面板 | work 场景的交付物是文件 |
| （v2）AGENTS/SOUL 在线编辑 | 调人格不用开 Console |

---

## 附录 A：内部 API 速查（localhost 免认证）

| 用途 | 方法与路径 |
|---|---|
| 发消息（替代品，非本方案） | `POST /api/console/chat` |
| 停止生成 | `POST /api/console/chat/stop?chat_id=` |
| 上传 | `POST /api/console/upload` |
| 会话列表 / 详情 | `GET /api/chats`、`GET /api/chats/{id}` |
| 审批 | `POST /api/approval/approve`、`/deny`、`GET /api/approval/list` |
| 工具调用详情 | `GET /api/tool_calls/{session}/{tool_call_id}` |

## 附录 B：源码索引

| 主题 | 位置 |
|---|---|
| 通道注册表 | `src/qwenpaw/app/channels/registry.py` |
| 通道基类（流式钩子 / tracker / 序列化） | `src/qwenpaw/app/channels/base.py:83,524,597,1149` |
| console 通道（参考实现） | `src/qwenpaw/app/channels/console/channel.py:368` |
| 插件 API | `src/qwenpaw/plugins/api.py:1551` |
| 插件示例（通道） | `plugins/channel/azure_bot/` |
| 事件入库 / 会话 | `src/qwenpaw/app/chats/manager.py:132` |
| 审批服务 | `src/qwenpaw/app/approvals/service.py:116` |
| 隧道能力 | `src/qwenpaw/tunnel/cloudflare.py` |
| 官方前端（可参考的渲染层） | `console/src/pages/Chat/index.tsx`、`console/src/api/modules/chat.ts` |
| 系统提示词拼装 | `src/qwenpaw/agents/prompt.py:50,209` |
| 提示词 md 模板 | `src/qwenpaw/agents/md_files/zh/`（AGENTS/SOUL/PROFILE/MEMORY…） |
| Agent 配置模型 | `src/qwenpaw/config/config.py:2093`（profiles）、`:2451`（AgentProfileConfig） |
| 技能生效规则（通道过滤） | `src/qwenpaw/agents/skill_system/registry.py:1261` |
| 技能注入 Toolkit | `src/qwenpaw/agents/react_agent.py:636`、`runtime/builder.py:177` |
| 联网搜索 | `src/qwenpaw/agents/tools/web_search.py`、`tools/websearch/factory.py` |
| 插件模式包 | `src/qwenpaw/plugins/modes.py`（`ModeSpec`） |
