# M39 — Agent 在线状态广播（presence）

**结论：** 中继本来就是唯一知道 agent 槽位真相的一方，但两个实现都不把槽位变化告诉浏览器
（`relay-cf/README.md` Behaviour 一节原文：“Clients are **not** told when the agent drops”）。
本里程碑在两个中继上，**只在槽位持有者发生真实转换时**向已鉴权客户端广播
`{"t":"status","agentOnline":<bool>}`（复用 M7 已有的 `status` 控制帧语义），并让 SPA 把它接到页眉与 M37 outbox；
插件零改动。改动后：relay-node smoke PASS、e2e_cf 16/16、e2e_m19 509/509、vitest 305/305、lockstep 14/14、插件 21/21。

> 行号均指**改动前**的提交 `e931747`（M38 收尾）。实现后的行号会移动，引用的是“探查时的事实”。

---

## 1. 探查：今天的真实行为

### 1.1 relay-cf（Durable Object）— 槽位生命周期事件点

| 事件 | 位置 | 做了什么 | 向客户端广播？ |
|---|---|---|---|
| WS upgrade（agent） | `relay-cf/src/index.ts:285-297` | 只校验 `AGENT_TOKEN` 并 `accept('agent')`；**不在 upgrade 时驱逐任何 socket**（295 的注释） | 否 |
| 休眠重建 | `relay-cf/src/index.ts:231-257` | `getWebSockets()` 里取 `started` 最大的 agent 附件为赢家（240-252），再装入 `this.agent`/`this.agentMeta`（253-256）；不关闭任何 socket | 否（此时也还没有“变化”可报） |
| **hello 赢槽（世代更替）** | `relay-cf/src/index.ts:401-445` | 旧世代（`started` 更小）→ `close(4000)` 后 return（408-415）；同一 socket 重 hello → 只刷新元数据并回 `ready`（422-427）；新世代 → 先 `close(4000)` 旧 agent（431-437），再 `this.agent = ws`（438-440），然后 `peer` → `flushOutbox()` → `ready`（442-444） | 否 |
| 槽位空置时的“再收养” | `relay-cf/src/index.ts:368-374` | 休眠后若槽位空，收到非 hello 业务帧的、附件仍是赢家的 socket 会被重新装回 `this.agent` | 否 |
| **持有者 WS close / error** | `relay-cf/src/index.ts:448-454` → `forget()` `508-516` | `ws === this.agent` 时清空 `agent`/`agentMeta`/`agentLastSeenAt`（509-513）；客户端 socket 关闭只更新 `clients` 并通知 agent（515） | 否 |
| hb | `relay-cf/src/index.ts:353-357` | **只有槽位持有者**得到 `hb_ack`；不转发、不盖 `agentLastSeenAt`、不耗桶。中继**没有**任何 hb 超时驱逐逻辑 | 否 |
| `/health` | `relay-cf/src/index.ts:266-273` | `agentOnline: this.agent !== null`（269），`agentLastSeen` 是“最后一帧业务帧”的提示（271），与在线判定无关 | — |
| 客户端接入 | `relay-cf/src/index.ts:299-310` | 令牌校验后 `ready{agentOnline}`（306）——**一次性快照** | 仅给新客户端 |

结论：**槽位状态在 DO 内部是完整可知的**（`this.agent` 就是它），只是没有任何出口。
唯一能表达“agent 在线”的帧是 `ready`（只在连接时发一次），唯一的“反向证据”是插件自己推的 `status`（见 1.3）。

### 1.2 relay-node — 同一组事件点

| 事件 | 位置 | 与 relay-cf 的对应 |
|---|---|---|
| upgrade | `relay-node/server.js:176-184` | 只验 Bearer；同样**不驱逐**（75-77 注释“until then the socket is parked”） |
| hello 赢槽 | `relay-node/server.js:92-116` | 旧世代 `close(4000)` 后 return（96-100）；重 hello 只刷新（102-106）；新世代 `agent.close(4000)`（108）后 `agent = ws`（109），`peer` → `flushOutbox()` → `ready`（112-114） |
| **持有者 close / error** | `relay-node/server.js:125-131` | `if (agent === ws) { agent = null; agentMeta = null; }`；error 只挂空函数（131），靠随后的 close 事件 |
| hb | `relay-node/server.js:86-90` | 与 cf 相同的“只 ack 持有者”，同样无超时驱逐 |
| `/health` | `relay-node/server.js:161-166` | `agentOnline: isOpen(agent)`（`readyState === 1`），即“持有者 socket 还没被观察到关闭” |
| 客户端接入 | `relay-node/server.js:134-137` | `ready{agentOnline: isOpen(agent)}`（136） |
| agent 帧转发 | `relay-node/server.js:118-122` | 逐 client 写；**没有**给浏览器的 presence |

两边语义完全一致（这正是 `tools/relay_lockstep.py` 守护的东西），所以 presence 可以在两边用同一套规则实现。

### 1.3 客户端连接时现在能拿到什么

- **`ready{agentOnline}`**：`relay-cf/src/index.ts:306`、`relay-node/server.js:136`。只在（重）连握手时给一次，
  之后不再更新 —— 这就是 M37 的已知边界（`docs/m37-report.md:172-177`）。
- **`status`（插件身份帧）**：`plugin/frames.py:368-380` 构造 `{t:"status", agent_name, provider?, model?}`；
  插件在收到中继的 `ready` / `peer` 时推（`plugin/channel.py:645-647` → `1270-1281`），中继原样广播给所有 client。
  **内容里没有 `agentOnline`**，时机是“agent attach 后 / 有 client 加入或离开时”，即只能证明“agent 此刻在”，
  永远不证明“agent 走了”。
- **`peer`**：只发给 agent（`relay-cf/src/index.ts:499-501`、`relay-node/server.js:36`），浏览器收不到。

### 1.4 `/health` 的 `agentOnline` 口径

两个中继都是“**槽位是否被占**”，不是“最近有没有 hb”：

- cf：`this.agent !== null`（`relay-cf/src/index.ts:269`），`agentLastSeen` 另行给出（271）。
- node：`isOpen(agent)`（`relay-node/server.js:162`）。

也就是说，`/health` 与“持有者 socket 尚未被观察到关闭”同义。真正让中继观察到关闭的是：
① TCP close/error 事件；② 插件自己判死后的主动关闭。插件侧的判死是 M7.3 的 `hb`：
15 s 一拍、10 s 等 ack、连续 2 次丢失后 `ws.close()`（`plugin/relay_client.py:49,504-564`，常量 `15.0/10.0/2/2.0`），
最坏约 37 s 才会产生一次 close。**中继没有更敏感的判死点，本里程碑也不新增**。

### 1.5 SPA 的在线状态来源

`RelayClient` 内部只有 `agentOnline` 一个布尔（`spa/src/relay.ts:83`），三个入口：

1. `ready`：`spa/src/relay.ts:199-204`（`frame.agentOnline === true`，其余一律 false）；
2. `peer`：`spa/src/relay.ts:207-214`（防御性支持，今天两个中继都不给浏览器发 `peer`）；
3. 连接状态：open 时 `live`（`spa/src/relay.ts:124-133`），close 时把 `agentOnline` 置 false（`268-286`），`close()` 亦然（`156-157`）。

App 侧另有一条**独立**的“在线”证据：插件的 `status` 帧（`spa/src/App.tsx:3976-3984`），收到即认为在线并
`flushOutbox()`。页眉同时显示连接态与 agent 态（`spa/src/App.tsx:6031-6038`）。

**M37 outbox 读的状态**（都要改到同一条线上）：

| 动作 | 位置 | 读什么 |
|---|---|---|
| 入队判定 | `spa/src/App.tsx:2458` `canReachAgent()`；调用点 `5145-5167`（`send`）、`5083-5089`（重新生成） | `connRef === 'live' && agentOnlineRef` |
| 冲刷 | `spa/src/App.tsx:2488-2545`，触发点 `4309-4315`（进入 `live`）、`3980-3983`（插件 `status`） | 同上 |
| 未确认冻结 | `spa/src/App.tsx:4336-4345`（离开 `live`） | 连接态 |
| 对账 | `spa/src/App.tsx:2552-2577`（`histPurpose:"reconcile"`，只要求 `connRef === 'live'`） | 连接态 |

结论：**只要 `agentOnlineRef` 能因 presence 变 false，M39 的“离线直接入队”就是现有代码的自然结果**，
不需要新分支；对账链路也完全不动。

### 1.6 未知 `t` 帧是否安全忽略

安全，且是协议明文：

- `protocol/frames.md:18-19`：“Unknown fields MUST be ignored; unknown `t` values SHOULD be ignored（forward compatible）”。
- SPA：`onFrame` 的 `switch` 末尾是 `default: break;`（`spa/src/App.tsx:4288-4289`）；`relay.ts` 只解释
  `pong/ready/peer/error/resync`，其余原样转交 `onFrame`（`spa/src/relay.ts:185-242`）。
- **旧 SPA 收到新帧的行为**（决定部署顺序）：旧 SPA 的 `case 'status'` 不检查 `agentOnline`，
  收到任何 `status` 都会置“在线”并 `flushOutbox()`（`spa/src/App.tsx:3976-3984`）。
  因此新中继 + 旧 SPA：`status{agentOnline:false}` 被当成“插件又推了一次身份帧”，页眉仍显示在线 ——
  **等同于改动前的行为，不丢消息、不误报错误**；`status{agentOnline:true}` 也等同于现状。
  反过来新 SPA + 旧中继：永远收不到 presence，退化为 M37 行为。**两个方向都安全**，先部署中继更早产生收益。

### 1.7 插件是否需要改

**不需要**，核实如下：

1. presence 只发给 client（`relay-cf/src/index.ts:503-505` 遍历 `this.clients`；`relay-node/server.js:120-122` 遍历 `clients`），
   agent socket 不在其中；插件根本看不到这个帧。
2. 即使看到，插件对未知入站帧只记 debug（`plugin/channel.py:648-649`），不会报错。
3. “插件进程活着但 RelayClient 在重连间隙”：从中继视角看就是**槽位空置**（socket 已关，close 事件已发生），
   与“agent 真死了”不可区分 —— 这恰好就是想要的语义：此刻用户的消息送不到，应该进 outbox。
4. 插件 attach 后仍会推自己的 `status`（`plugin/channel.py:645-647`），M39 不改它，二者在同一 `t` 上共存
   （字段约定见 §2.1）。

---

## 2. 设计

### 2.1 帧：复用 `status`，不新造类型

presence 帧就是协议里已有的控制帧加一个字段：

```json
{"t":"status","agentOnline":true}
```

理由：

1. `status` 已经是“agent 侧状态推给浏览器”的既有语义（M7 身份帧），再加一个 `agentOnline` 是最小增量；
2. 不新造 `t` 意味着旧 SPA 不需要“忽略未知类型”就能保持旧行为（§1.6 的实测结论），部署窗口没有第三种状态；
3. 两个 producer 的字段不相交：**有 `agentOnline` = 中继的槽位状态；没有 = 插件身份帧**（只有 attached 插件能发，故隐含在线）。
   客户端按字段分支即可，互不覆盖。

它是控制帧：没有 `seq`、不进环形缓冲、不在 `resume` 时重放，也**不会发给 agent**（广播只遍历 client 集合）。

### 2.2 触发点：只发边沿

| 边沿 | 代码位置（改动后） | 帧 |
|---|---|---|
| offline → online | 赢槽的 hello 处理里，`peer` → `flushOutbox()` → `publishPresence()` → `ready`（cf `relay-cf/src/index.ts:458`；node `relay-node/server.js:160`） | `agentOnline:true` |
| online → offline | 持有者 socket 的 close/error（cf `forget()` `relay-cf/src/index.ts:547`；node `dropAgent()` `relay-node/server.js:80`） | `agentOnline:false` |

`publishPresence()` 是**唯一**出口（cf `relay-cf/src/index.ts:532-537`、node `relay-node/server.js:68-73`），
内部先比较 `presence` 再广播，所以重复调用（同代 re-hello、世代更替）不产生帧。

以下事件**不会**产生帧（parked / superseded / handover / re-hello / client 加入都有测试；
`ping` / `hb` 在两条代码路径上都在任何广播之前 return，心跳不是状态变化）：

- parked socket（连上但没 hello）与 superseded hello（旧世代收到 4000）：它们从来不是持有者；
- 世代更替：赢家先 `agent = ws`，旧 socket 的 close 事件在其后的事件循环里才到，
  `forget(old)`/`dropAgent(old)` 走的是“非持有者”分支，槽位从未看起来为空；
- 同一 socket 的 re-hello（只刷新元数据）；
- client 加入/离开（那是给 agent 的 `peer`）。

presence 在 `flushOutbox()` **之后**发布：浏览器收到 online 会立刻冲刷自己的队列，
这些新帧必须排在 relay 已经缓存、刚刚写出的帧之后，否则会打乱同一会话的消息顺序。

### 2.3 下线判定：沿用中继既有判死点，不新造

中继的判死点只有 socket 的 close/error（§1.4）。relay-cf 没有 hb 超时，relay-node 也没有；
半开连接最终由插件的 `hb`（15 s/10 s/2 次，最坏约 37 s）转成一次 close。M39 不动这条链路：
`/health`、relay 的 offline buffer、presence 三者对“离线”的定义完全一致。

### 2.4 防抖：不加延迟，允许快速翻转

**选择：离线边沿立即广播，不设宽限。** 理由按重要性排列：

1. **延迟只会扩大危险窗口。** 在“浏览器以为在线、其实 agent 已死”的窗口里，SPA 会把 `msg` 写进 relay 的
   offline buffer；relay-node 的 buffer 在内存里，进程重启即丢，且 500 帧 / 1 MB 会丢最旧 —— 这正是 M37 要消灭的失败模式。
   让浏览器早 1 秒进队列，比让它晚 1 秒安全得多。
2. **快速翻转本身无害。** 离线时发送进 outbox（待发送），在线时按序冲刷；已经写进 socket 的条目永不自动重发。
   一次插件重启最多让页眉闪一下“离线”，不会产生重复或丢失。
3. **宽限期是第二套判活逻辑。** 任务单要求“以中继既有判死点为准，不新造更敏感的判定”。加 2–5 s 宽限
   既不提高准确性（close 已经是事实），又会在宽限内把消息送进上面那个 buffer，与第 1 条矛盾。
4. **去重做在边沿上。** `presence` 记住上次广播值，世代更替/re-hello 根本不会触发，所谓“闪烁”只剩
   “真的先断后连”这一种，而它是事实。

### 2.5 SPA 接入

- `spa/src/relay.ts:205-213`：presence 帧只更新内部 `agentOnline` 并原样交给 `onFrame`，**不触发 `onState`**。
  这一点是测试逼出来的：`onState('live')` 在 open 和 `ready` 各触发一次，第二次正是 M37 重连后冲刷队列的时机；
  把 presence 也做成一次 state 事件，要么让这次冲刷消失（加了“只处理真实转换”的闸门，首轮 M37 全红），
  要么每次上下线都重放整套连接副作用。保持 `onState` 只表达连接状态、presence 由 App 自己消化，语义最干净。
- `spa/src/App.tsx:3976-4003`：`status` 分支按 `agentOnline` 分流 —— `false` 只把页眉置离线；`true`（或缺省，
  即插件身份帧）置在线并调用既有的 `flushOutbox()`（队列为空时是 no-op）。
- 发送路径零改动：`canReachAgent()`（`spa/src/App.tsx:2458`）读的就是这个 ref，于是“离线后新发送”自然进入 outbox。
- 对账链路零改动：`markOutboxUnconfirmed`（离开 `live`）、`siftOutboxAfterReconnect`、`reconcileOutbox` 全部原样保留。

### 2.6 部署顺序

| 组合 | 行为 |
|---|---|
| 新中继 + 旧 SPA | 旧 SPA 把 presence 当身份帧（置在线 + 冲刷），与本里程碑之前完全一致；不丢消息、不报错 |
| 新 SPA + 旧中继 | 收不到 presence，退化为 M37（靠 `ready` + 插件 `status`） |
| 新 + 新 | 页眉即时翻转；离线发送直接入队；在线冲刷 |

两个顺序都安全；先发中继能更早产生边沿。SPA 构建仍必须带 `VITE_RELAY_WS` / `VITE_RELAY_HTTP`（M38 §0）。

## 3. 改动文件

| 文件 | 改动 |
|---|---|
| `relay-cf/src/index.ts` | `presence` 字段（休眠重建时按赢家初始化，不广播）；`publishPresence()`（边沿去重 + 只发 client）；调用点：赢槽（flush 之后）、`forget()` 的持有者分支、休眠后再收养 |
| `relay-node/server.js` | 同上；新增 `broadcast()`（fan-out 内的 send 异常吞掉，close handler 里不能抛）与 `dropAgent()`；转发循环改用 `broadcast` |
| `relay-node/test/smoke.mjs` | 8 条 presence 断言（2 条边沿：离线/上线；5 条静默：client 加入、superseded、handover、parked、re-hello；1 条“持有者 close 只发一次”）+ 末尾 `/health` |
| `spa/src/relay.ts` | presence 帧更新内部 `agentOnline` 并透传 `onFrame`，**不**发 `onState` |
| `spa/src/App.tsx` | `status` 分支按 `agentOnline` 分流（离线只翻页眉；在线/身份帧置在线并 `flushOutbox()`）；`agentOnlineRef` 的注释更新 |
| `tests/e2e_cf.mjs` | 新增 §10：offline / parked 静默 / online / superseded 静默 / handover 静默 + 末尾 health |
| `tests/e2e_m19.mjs` | 重写 M37 §5 为 M39 场景（杀 agent → 页眉离线 → 发送入队 → 重载仍在 → agent 回来 → 在线 + 冲刷一次）；`connectAgent({statusDelayMs})` 让上线断言只可能来自 presence |
| `tools/relay_lockstep.py` | 新增 6 条 presence 规则；`normalize` 去除注释；hello 赢槽顺序改为 `peer → flushOutbox → presence → ready` |
| `protocol/frames.md` | §2.3 / §2.5 的 `status` 行；新增 §16（帧、触发点、判死口径、防抖理由、客户端义务、兼容矩阵） |
| `relay-cf/README.md`、`relay-node/README.md` | 去掉“clients are not told”，补 presence 小节 |
| `README.md`、`docs/README.md`、`docs/m37-report.md` | 协议版本 v10→v11、M39 索引、M37 §7 的已知边界标注为已解决 |
| `AGENTS.md` | M39 的持久约定（`status` 双 producer、`onState` 双触发、不做离线防抖、不冻结 `sent`） |
| `docs/m39-report.md` | 本报告 |

插件（`plugin/`）无任何改动。

## 4. 测试计数

| 套件 | 命令 | 结果 |
|---|---|---|
| relay-node smoke | `cd relay-node && npm test` | **PASS**（1 套；新增 8 条 presence 断言） |
| relay-cf e2e | `wrangler dev --local --port 8788` + `node tests/e2e_cf.mjs` | **16/16 PASS**（mandatory 13；新增 5 条 presence + 1 条 health） |
| SPA e2e（全量） | `OUT_DIR=/tmp/... node tests/e2e_m19.mjs` | **509 checks, 0 failed**（desktop + mobile，219.9 s） |
| SPA e2e（聚焦） | `M37_ONLY=1 ... node tests/e2e_m19.mjs` | **65 checks, 0 failed**（两遍合计） |
| SPA vitest | `cd spa && npx vitest run` | **19 files / 305 tests PASS** |
| relay lockstep | `python3 tools/relay_lockstep.py` | **14 checks, 0 failed**（新增 6） |
| 插件套件 | 21 × `venv/bin/python plugin/tests/test_*.py` | **21/21 ALL PASS**（未改插件，回归确认） |
| 类型检查 | `spa: npx tsc --noEmit`；`relay-cf: tsc --noEmit` | 0 错误 |

一次真实失败值得记录：第一版把 presence 做成 `onState` 事件，并在 App 里加了“只有真实状态转换才跑连接副作用”的闸门，
`M37_ONLY` 立刻在“relay 重启后队列冲刷”处全红 —— 因为重连时 `onState('live')` 会在 open（agentOnline 未知）和
`ready`（agentOnline 已知）各来一次，第二次才是冲刷时机。最终方案（§2.5）不动 `onState`，presence 由 App 自己消化。

## 5. 遗留竞态与边界

1. **帧已写出、agent 随后才死**：presence 只能证明“中继看到了 close”，不能证明最后一帧被处理。
   这类条目在协议里没有逐条回执，仍然是最多一次；M37 的“永不自动重发 + 历史尾部对账”原样保留（重连路径不变的测试：§4 的 M37 全绿）。
   我们**故意没有**在 offline presence 时把 `sent` 条目冻结成“未确认”：`sent` 只保留 8 s（`OUTBOX_SENT_GRACE_MS`），
   而一次普通插件重启会让这 8 s 内发送过的消息全部变成红条，且对账只在“重新进入 live”时触发，页面上会留下无法自愈的假警报。
   代价是：在“中继观察到 close 之前”的最后几毫秒写出的帧，若确实丢了，仍然不可见 —— 与 M37 记录的窗口相同，只是被 presence 缩小了。
2. **presence 是边沿、不重放**：断线期间错过的边沿由重连的 `ready{agentOnline}` 补齐，这是连接快照的职责，不新增游标。
3. **半开连接**：中继没有 hb 超时（M7.3 规矩），offline 要等 socket 真正 close；插件的 2 次 miss（最坏约 37 s）才会产生它。
   想更快只能改插件判死口径，不在本里程碑范围。
4. **relay-cf 休眠**：重建时用赢家初始化 `presence` 且不广播（对象不知道幸存客户端上次被告知了什么）；
   若 agent 在休眠期间关闭，close 事件会唤醒 DO 并发出 offline 边沿。
5. **世代更替**：新 hello 先接管槽位，旧 socket 的 close 之后才到，因此没有 offline 边沿；交接期间客户端的帧仍按原路径
   （旧 buffer flush → 新 agent）投递。
6. **部署未执行**：按任务约束，relay-cf / SPA 的实际部署由协调者完成；因此本报告没有 `live_spa_probe.mjs` /
   `verify_release.py` 的生产读数。`spa/dist` 已按生产 env（`VITE_RELAY_WS` / `VITE_RELAY_HTTP` 指向
   `qwenpaw-webchannel-relay.yxliwangsheng.workers.dev`）重建，本地演示开关字符串已被 DCE（M38 的两条静态判据都满足），
   `dist` 本身被 gitignore。协调者执行：

   ```sh
   # relay first (either order is safe, §2.6)
   cd relay-cf && npx wrangler deploy
   # SPA (rebuild is cheap; keep the env — M38 §0)
   cd spa && VITE_RELAY_WS=wss://<relay>/ws/client VITE_RELAY_HTTP=https://<relay> npm run build
   npx wrangler pages deploy dist --project-name qwenpaw-webchannel-spa
   # then: tools/live_spa_probe.mjs, tools/verify_release.py
   ```

## 6. 复现

```sh
cd relay-node && npm test                     # presence 边沿（node）
python3 tools/relay_lockstep.py               # 两个 relay 的规则一致性
M37_ONLY=1 node tests/e2e_m19.mjs             # 页眉/outbox 快跑
node tests/e2e_m19.mjs                        # 全量
cd spa && npx vitest run
# relay-cf（本地 DO）：
cd relay-cf && npx wrangler dev --local --port 8788 &
node tests/e2e_cf.mjs
```
