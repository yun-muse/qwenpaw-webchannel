# M30 · `/poll` 降级通道 — 探查报告

> 范围：仅执行 `tasks/m30-poll-fallback-task.md` 的「探查任务」一节。
> 本会话**未改任何产品代码、未改 AGENTS.md、未提交**。
> 行号基于当前工作区源码（`git status` 里除本文件与既有未跟踪任务书外无改动）。

---

## 0. 结论

**跳过（SKIP）。** `/poll` 不是「补一个 GET 处理函数」的规模，它要求中继从
**无状态广播**变成**有状态队列**，并且必须发明一套 `seq` 之外的投递游标——后者被本任务
明令禁止（`tasks/m30-poll-fallback-task.md:9`「不许另 invent 一套序号」），且仓库自己的
README 早已把它定性为「协议决定，不是中继实现细节」（`relay-cf/README.md:194-196`）。

按决定性排序的障碍（详见 §4–§6）：

1. **中继对浏览器侧零状态。** agent 帧只被投给**当前活着的 socket**
   （`relay-cf/src/index.ts:503-505`），两次长轮询之间的帧直接消失。
   业务帧还能靠插件 ring buffer + `resume` 补回来（`plugin/channel.py:861-878`），
   **控制帧补不回来**——它们按设计不带 `seq`、不入 ring、不随 `resume` 回放
   （`plugin/channel.py:531-539`），而 SPA 的首屏（`models`/`chats`/`skills`）、
   M12 导出、M13 搜索、M24 看板全靠它们。
2. **唯一干净的替代方案是 relay 侧 per-client 游标队列**，那正是第二个序号系统，
   且要新增 DO storage 键、GC 策略和「一次响应回几帧」的批量语义（回放上限
   400 帧 × 256 KB，见 `plugin/channel.py:285`、`relay-cf/src/index.ts:26`）。
3. **架构本钱会被吃掉。** DO 的选型理由**就是** Hibernation WebSocket「空闲连接不产生
   时长计费」（`docs/design.md:196`）。长轮询把 in-flight 请求一直挂在对象上，
   正好取消这个性质。

附带但独立的硬伤：relay-cf 只有 `/api/login` 带 CORS 头
（`relay-cf/src/index.ts:64-68,136-159`），DO 的所有响应都没有
（`relay-cf/src/index.ts:57-62,262-281`）——跨源 SPA 连响应体都读不到，今天能读
`/api/login` 正是因为它特例加了 CORS。

---

## 1. `GET /poll` 501 的位置

| 位置 | 内容 |
|---|---|
| `relay-cf/src/index.ts:274-276` | `if (route === 'GET /poll') return json({ error: 'not_implemented' }, 501);`（注释：v1 只有 WS 一种传输） |
| `relay-cf/README.md:25` | 路由表：`GET /poll` \| `none` \| `501`（deferred） |
| `relay-cf/README.md:188-196` | 「/poll — deferred」整节，含「Any implementation would need cursor semantics for the offline buffer, which is a protocol decision, not a relay implementation detail」 |
| `tasks/m3-relay-task.md:86-88` | M3 时就把它写成 deferral |
| `tests/e2e_cf.mjs:253-258` | e2e **断言** `poll.status === 501`（改实现必须同步改这条断言） |
| `relay-node/server.js:158-171` | relay-node 的 HTTP 面只有 `GET /health`，**没有** `/poll` 路由 |

注意设计文档与任务书的口径已经分叉：`docs/design.md:203,301` 写的降级通道是
**容器侧**长轮询、鉴权「同 agent token」；M30 任务书写的是**浏览器侧**、沿用 client token
（`tasks/m30-poll-fallback-task.md:10`）。下面按任务书（浏览器侧）评估。

---

## 2. Durable Object 到底做了哪些事

### 2.1 路由

- Worker：`OPTIONS` → 204；`POST /api/login` → 自己处理；**其余全部**
  `stub.fetch(request)` 交给租户 DO（`relay-cf/src/index.ts:161-178`）。
- DO：`GET /health`、`GET /poll`、`GET /ws/agent`、`GET /ws/client`，其余 404
  （`relay-cf/src/index.ts:262-281`）。
- 两条升级路径：`upgradeAgent` 只做 Bearer 校验（`index.ts:285-297`），
  `upgradeClient` 校验 client token 后 `accept('client')`、塞进 `clients`、
  回 `{t:"ready",agentOnline}`、通知 agent（`index.ts:299-310`）。

### 2.2 DO 的「帧路由」= 广播，没有序号、没有回放

```
agent 帧 → if (ws === this.agent) { broadcast(message) }      index.ts:383-387
broadcast → for (const client of Array.from(this.clients))    index.ts:503-505
clients   → private clients = new Set<WebSocket>()            index.ts:214
```

- 中继**从不解析业务字段**：文件头写明「forwards frames verbatim (it never parses
  business payloads)」（`index.ts:5-7`），README 同（`relay-cf/README.md:5-7`）。
- DO 里**没有任何 `seq` 概念**：唯一带序的东西是 client→agent 的离线 outbox
  （500 帧 / 1 MB，`index.ts:27-28,557-586`），它按到达顺序 flush，**不带序号**，
  且只覆盖上行。

### 2.3 `seq` / `resume` 的真实所有者是插件（容器侧）

| 事实 | 证据 |
|---|---|
| `seq` 由容器按 chat 递增，从 1 开始 | `plugin/util.py:79-94`（`SeqCounter`） |
| 每帧在 `_emit` 里取 seq → 入 ring → 发 relay | `plugin/channel.py:518-529` |
| per-chat ring buffer 400 帧 | `plugin/channel.py:285`；`plugin/util.py:96-136` |
| `resume{chat,last_seq}` 由插件应答：命中 → 重发 `seq>last_seq`（保留原始 seq）；未命中 → `resync` | `plugin/channel.py:861-878`；`plugin/util.py:114-140` |
| 客户端按 seq 去重，`resync` 时把 `lastSeq` 清零 | `spa/src/relay.ts:221-239` |
| 协议口径：seq 由容器赋值 | `protocol/frames.md:169-171` |

**这既是好消息也是坏消息。** 好消息：`resume` 是一条普通上行帧，和传输无关——POST 上行
天然能发它，业务流续传不需要改协议。坏消息：**回放是从 agent 侧绕回来的**，而 agent 的回放
同样只走 `broadcast()` 到活 socket；轮询者不轮询的那一刻，回放帧也一并丢。

### 2.4 协议里有一整类「不可回放」的帧

`_send_control` 的契约（`plugin/channel.py:531-539`）：**不带 `seq`、不入 ring、
不随 `resume` 回放**。走这条路的帧包括（`plugin/channel.py:580-603` 的分发表）：

`models` / `model_changed` / `status` / `effort` / `usage` / `stats` /
`export_begin|chunk|end` / `search_results` / `chats` / `chat_deleted` /
`chat_renamed` / `prompts` / `prompt_saved` / `skills`。

其中：

- **首屏**：`onState('live')` 时 SPA 立刻发 `get_effort`、`get_usage`、`models`、
  `chats`、`skills`（`spa/src/App.tsx:3320-3336`）——两条腿都必须送达。
- **M12 导出**：多帧、按 40 ms 节奏发送（`plugin/channel.py:203,1701-1713`），
  客户端有 120 s 超时（`spa/src/App.tsx:143`）。任何落在两次 poll 之间的分片都永久
  丢失，只能整体重来；M25 批量导出还会一个接一个跑最多 100 个
  （`spa/src/lib/bulkExport.ts`），放大了这种撕裂。
- **M24 看板 / M13 搜索**：单帧响应，下一次请求还能重来，但 SPA 没有「这一帧丢了」的
  检测——`get_stats` 的 15 s 计时器（`spa/src/App.tsx:182`）报的是「慢」，不是「丢」，
  也从不重发。

---

## 3. 浏览器连接层能不能复用

**接口层面是个好缝，状态机层面是 WS 形状的。**

`RelayClient` 的公开面是传输中立的（`spa/src/relay.ts:79-113,141-158`）：
`connect() / close() / send(frame): boolean / getState() / getLastSeq(chat) /
setActiveChat(chat)`，`RelayOptions` 里也没有 `WebSocket` 类型泄漏
（`relay.ts:44-62`）。所以**理论上**可以抽一个 transport 接口，让 `PollTransport`
顶替 WS。

但真正决定正确性的逻辑都埋在 WS 生命周期里：

| 逻辑 | 位置 | 轮询下要重写的原因 |
|---|---|---|
| 重连退避 500 ms→8 s | `relay.ts:288-292` | 轮询没有「断开」，只有请求失败 |
| `openFailures`→`onAuthFailure`（3 次握手未成功即判鉴权失败） | `relay.ts:264-293` | 轮询下「握手」不存在，阈值语义要重新定义 |
| `ping` 25 s / `pong` 10 s | `relay.ts:295-302` | 没有 socket 可关，存活= HTTP 响应返回 |
| `resumeActive` 只续当前 chat | `relay.ts:178-183` | 需要在**每次** poll 前发一次，否则两次请求之间必丢 |

也就是说：SPA 侧的改造是「小但真实」的，不是零成本；而它解决不了 §2.2 的服务端问题。

---

## 4. 三个候选逐条评估

### 4.1 下行：长轮询 + `last_seq`

**任务约束**：resume 语义必须与 WS 完全一致，不许另发明序号
（`tasks/m30-poll-fallback-task.md:9`）。

- **业务帧：可以做到「语义一致」。** 每次 poll 前（或随 poll 请求带 `last_seq`）
  让 relay 代发一条 `resume`，插件从 ring 重放 `seq>last_seq`，客户端用既有去重逻辑
  （`relay.ts:221-226`）吞掉重复。这一支不需要动 `SeqCounter`/`RingBuffer`——
  但要注意中继今天**从不合成业务帧**（"it never parses business payloads"，
  `index.ts:5-7`），代发 `resume` 本身就是一条新的职责边界。
- **但它买不到「不丢帧」。** 插件重放的前提是它知道 `last_seq`，而 `resume` 的
  响应是 `broadcast()` 出去的（`index.ts:383-387`）——relay 需要为每个 poll 会话
  捕获一份，否则 `resume` 的结果在下一个 poll 开始前就丢了。捕获就必须有
  **per-session 队列**，队列就必须有**游标**。
- **游标不能用 `seq`。** 十几种控制帧根本没有 `seq`（§2.4）；一个按 `seq` 索引的队列
  会把它们全部丢掉，而首屏正是靠它们。用「到达序号」= 第二个序号系统 = 本任务红线；
  仓库也早就把这一点写成「协议决定」（`relay-cf/README.md:194-196`）。
- **一次响应装不下回放。** ring 上限 400 帧 × 单帧上限 256 KB
  （`plugin/channel.py:285`、`relay-cf/src/index.ts:26`）——最坏 100 MB。
  轮询响应必须再发明「本次回几帧 / 剩余怎么办」的传输层批处理协议。这是第三套协议层。

**结论：不是「让 `/poll` 返回 JSON」的改动，而是给中继增加一个与 WS 并行的、
带持久游标和批量语义的投递层。**

### 4.2 上行：普通 POST 发送帧

这一半**技术上成立**，但仍有三个具体缺口：

1. **鉴权可复用。** `verifyClientToken` 已是纯函数（`index.ts:111-128`），POST 走
   同一把 client token 没有障碍；而且 POST 能用 `Authorization` 头，比 WS 把 token
   放在 `?token=`（`index.ts:299-301`）更干净。
2. **CORS 是硬缺口。** `json()` 只设 `content-type`（`index.ts:57-62`），CORS 头
   `CORS_HEADERS`（`index.ts:64-68`）**只**在 `handleLogin`（`index.ts:141-158`）和
   `OPTIONS`（`index.ts:166-168`）里用。DO 的响应（含 `upgradeClient` 的 401）
   `index.ts:262-310` 一个 CORS 头都没有。SPA 跨源读 `/api/login` 的 JSON 能成功
   正是因为这个特例（`spa/src/App.tsx:1574-1580`）；新的 poll/POST 路由如果不加
   CORS，浏览器会在读响应体时直接失败。
3. **错误语义要换。** `E_BADFRAME`/`E_TOOBIG`/`E_BUSY` 现在是「推回发送者的 socket」
   （`index.ts:491-497,532-537`），`E_AUTH` 则根本不由帧承载、而是在 HTTP 升级时以
   401 拒绝（`protocol/frames.md:216-219`）。
   POST 必须同步回在响应体里，且 `E_BUSY` 的「每桶每秒只提示一次」
   （`index.ts:32,531-537`）在请求-响应模型下含义变了。

另外，上行帧最终仍要**喂进 `webSocketMessage(ws, message)`**——它的签名绑死了
`WebSocket`（`index.ts:323`），`roleOf` / `isOpen` / `sendText` / `forget` 全部以
socket 为键（`index.ts:456-474,508-516`）。要复用只能把核心分发重构成
`handleFrame(role, frame, sender)`，那已经是「改核心状态机」。

### 4.3 心跳 / 保活 / 槽位世代

**这是整个探查里唯一「免费」的部分，而且方向被搞反了：轮询根本不需要碰它。**

- `hb`/`hb_ack` 是**容器 ↔ 中继**的端到端心跳：插件每 15 s 发 `hb`，由 relay 进程
  自己 ack，只有槽位持有者被 ack，不转发、不计桶、不打 `agentLastSeen`
  （`relay-cf/src/index.ts:346-357`；`plugin/relay_client.py:503-564`；
  `protocol/frames.md:38-57`）。
- **槽位世代 `started` 抢占 + close 4000** 只作用于 agent socket
  （`index.ts:39-41,401-445`；`plugin/relay_client.py:68,346-352`）。
- 浏览器腿的存活证据是 `ping`/`pong`（`relay.ts:295-302`，且 `{"t":"ping"}` 由
  `setWebSocketAutoResponse` 在边缘直接回答，`index.ts:233-235`）——这一条在轮询下
  自然作废：**HTTP 请求返回本身就是存活证据**，不需要等价帧。

所以 M7.1/M7.3 不变量**不需要为轮询改动**，前提是 agent 腿保持 WS。这一点必须写清楚，
免得以后有人以为「降级通道要动槽位」。

---

## 5. 与既有不变量逐条对照

| 不变量 | WS 下的实现 | 轮询下是否成立 | 是否需要改 core |
|---|---|---|---|
| M7.1 槽位在 `hello` 时按 `started` 抢占，旧代 4000、不驱逐持有者 | `index.ts:401-445` | **成立，完全不受影响** | 否 |
| M7.1 升级时不做驱逐 | `index.ts:285-297` | 成立 | 否 |
| M7.1 被 4000 关闭即终止、永不重连 | `relay_client.py:346-352` | 成立 | 否 |
| M7.3 `hb` 由中继自己 ack，只有槽位持有者被 ack，不转发/不计桶/不 stamp | `index.ts:346-357` | 成立（agent 腿仍是 WS） | 否 |
| M7.3 浏览器腿存活 = `ping`/`pong` | `relay.ts:295-302`；`index.ts:233-235` | **不成立**（无 socket、无 pong） | 需要「响应即存活」，但这是新语义而非改动 |
| 控制帧不占序号、不入 ring、不随 `resume` 回放 | `channel.py:531-539` | **不成立**：两次 poll 之间的控制帧永久丢失 | **是**（游标，本任务禁止） |
| agent→client 全量广播、多标签同流 | `protocol/frames.md:24-25`；`index.ts:503-505` | 只有正在轮询的会话收得到 | **是**（per-session 捕获） |
| 客户端按 seq 去重、`resync` 清零 | `relay.ts:221-239` | 业务帧成立；但要求每次 poll 都发 `resume` | 客户端改动，可行 |
| 单帧 ≤256 KB、租户 30 帧/s 桶 | `index.ts:26,359-362` | 轮询响应要自定「一包几帧」；桶的归属要重新决定 | **是** |

---

## 6. 核心状态机要改多少

`clients` 是 `Set<WebSocket>`（`index.ts:214`），且**同时**是「是否打开」的判据：

```
isOpen(ws)  → ws === this.agent || this.clients.has(ws)      index.ts:472-474
broadcast   → Array.from(this.clients)                        index.ts:503-505
forget      → this.clients.delete(ws) → notifyPeer()          index.ts:508-516
notifyPeer  → agent 收 {t:"peer", clients:n}                  index.ts:499-501
```

把轮询会话塞进这个集合会让 `peer` 随每次请求起落而抖动，而插件对
`ready`/`peer` 的反应是重推 `status`（`plugin/channel.py:604-606`），
`_send_status` 里要做两次真实查询（`plugin/channel.py:1129-1138` 的
`_fetch_active` + `_agent_display_name`）。也就是说**抖动的 presence 会变成对 agent API
的持续压力**。正确做法是租约式会话 + presence 去抖——又是一层新状态。

再加上 hibernation：DO 因为 Hibernation WebSocket 才被选中、并以此论证「空闲连接不产生
时长计费、免费额度 10 万请求/日 / 13000 GB-s/日」（`docs/design.md:196`）。in-flight 的
长轮询请求会让对象常驻（这是平台语义，仓库内不可验证，但 `setWebSocketAutoResponse`
存在的理由正是「不要为心跳唤醒对象」，`index.ts:232-235`）。一个网页开着就换取
「DO 永不休眠」，是这个计费模型的反面。

---

## 7. 安全面变化（若实现）

- 现状 README 把 `/poll` 的鉴权写成 `none`（`relay-cf/README.md:25`）。任何实现**必须**
  先 `verifyClientToken`（`index.ts:111-128,299-302`），否则一个未鉴权的长轮询端点就是
  把 DO 钉住的 DoS 放大器。
- `GET` 只能把 token 放 query（和 WS 现状一样，`index.ts:299-301`），会进 CF 日志与
  Referer；`POST` + `Authorization` 头是更干净的口径。这意味着上下行**鉴权位置不一致**
  （WS 在 query，POST 在头），需要新写一节安全说明。
- 租户令牌桶是**内存态、按租户、休眠即重置**（`index.ts:520-529`；
  `relay-cf/README.md:184-186`）。轮询请求算不算帧、要不要计桶、`E_BUSY` 怎么回传，
  都得重新定义。

---

## 8. lockstep 与测试成本

- relay-node **没有** HTTP 客户端鉴权：`/ws/client` 升级不做任何校验
  （`relay-node/server.js:186-189`），HTTP 面只有 `/health`（`158-171`）。
  按仓库规矩两实现必须 lockstep（`AGENTS.md:17,19`），所以要么给 relay-node 新增一套
  轮询 + 鉴权，要么接受两实现行为分叉——两者都不是「小改动」。
- `tests/e2e_cf.mjs:253-258` 断言 501；`tests/e2e_m19.mjs` 里 mock agent 也只有 WS。
  新增的 poll 冒烟要覆盖「发消息→流式回复→resume 补帧」两遍（任务书 §若实现），
  等于把整条 e2e 跑两遍，且 m19 的 mock 需要第二个传输入口。

---

## 9. 被否决的「最小方案」

值得记录，因为它是唯一看起来便宜的路：

> `/poll` 只做「取走本次请求期间到达的帧」+ `resume`，不做持久游标；控制帧靠
> `onState('live')` 重请求。

它仍然倒在三点上：

1. **竞态不可消除**：`resume` 的回放帧和 `export_chunk` 都可能落在两次 poll 之间；
   前者靠重放恢复，后者永久丢失（`plugin/channel.py:1623-1631,1701-1714`）。
2. **首屏/功能帧要逐个重请求**，且 SPA 没有任何「这一帧丢了」的检测手段
   （`spa/src/App.tsx:3320-3336` 只在 state 变 `live` 时发一次）。
3. 仍然要给 DO 加「谁在轮询」的会话表，`peer` 抖动问题照旧（§6）。

也就是说：**省掉的是游标，不是复杂度；代价是功能不可靠。**

---

## 10. 什么条件下值得重探

按可信度排序，满足任意一条再开：

1. **协议加上「可回放控制帧」**（例如给控制帧也分配 `seq`，或引入显式的
   `since`/`ack` 游标字段并写成协议一节）。这会直接消掉 §4.1 的核心障碍——
   这是唯一能让方案变「干净」的变化。
2. **中继换了计费/运行模型**，不再依赖 DO hibernation（例如自建常驻 relay、
   或 Cloudflare 提供可长期挂起且不计时长的请求）。此时 §6 的成本论证失效。
3. **出现真实用户证据**：确有用户网络「WS 被掐、25 s 挂起 GET 放行」。目前这条前提
   在仓库里没有任何工单/日志支撑，只有 `docs/design.md:301` 的一行设想。
4. **降级目标改成「只读回看」**：不承诺发消息、不承诺导出/搜索/看板，只承诺
   `hist` + ring 回放。这个子集**确实**可以只用 `resume` 实现，代价是能力受限——
   但那是另一个产品决定，不是「WS 的降级通道」。
5. relay-node 与 relay-cf 的 HTTP 面统一（例如 relay-node 也上 client token），
   使 lockstep 成本从「两套」降到「一套」。

**不要**在没有 1 或 2 的情况下重探：这次的结论不是「没时间做」，而是「做出来必然带
不可回放的控制帧缺口」。

---

## 11. 本次改动的文件

只有本文件（`docs/m30-report.md`）。产品代码、测试、`AGENTS.md` 均未改动，未提交。

任务书的「若跳过」还要求往 `AGENTS.md` 追加一行结论；本会话按指令**没有**改
`AGENTS.md`，留给协调者复核后按 §10 的措辞补入。
