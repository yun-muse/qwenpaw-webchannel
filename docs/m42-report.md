# M42 — 停止生成修复 + 消息撤回探查

**结论（先读这段）**

- **A 部分（停止）已修复。** 用户点「停止」后，生成在 QwenPaw 语义允许的范围内停下，已生成的部分回复保留并标记
  「已停止」，composer 立刻恢复可用。根因有两层：
  1. **停止按钮的可见性判据错了**——SPA 用「有没有 `message.streaming` 的气泡」判断是否在生成
     （改动前 `spa/src/App.tsx:4386`、`:6638`）。一个 turn 在首 token 之前、以及每个工具调用期间**没有任何
     streaming 气泡**，所以恰好在这两个最需要停止的阶段按钮不存在。
  2. **停止成功之后没有任何终态帧**——QwenPaw 取消 producer task 时不会调用 channel 的
     `on_streaming_end`（`app/channels/base.py:1026-1036`），而旧插件在 `POST /api/console/chat/stop`
     成功后什么也不发（改动前 `plugin/channel.py:1059-1092`）。浏览器于是永远保留 caret 和「停止」按钮：
     用户看到的就是「停不下来」。
- **B 部分（撤回最后一轮）没有干净路径，按约定一个字的代码都没写。** 决定性证据：QwenPaw v2.2.2.post1 的
  chats/console 路由里**没有**删除消息/截断轮次的 API；官方 console 自己的「重新生成」也不是删除 API，而是
  **仅限 `channel=="console"`**、在 session 加载时按 `request_context.qwenpaw_regenerate_from` 做的一次
  **内存内回退**，且要求该 user 消息带 `qwenpaw_client_message_id`（`runtime/console_turn_state.py:61-118`、
  `hooks/session/session_hook.py:84`）。web 通道两者都不满足。即便硬做，QwenPaw 自己的 durable
  `conversation_history` 没有按轮删除（只有按日期/类型的 `purge`，`agents/context/scroll/history.py:1165`），
  插件的 Turso 归档也没有删除面（`plugin/turso_archive.py:36`、`plugin/turso_search.py:58`），已撤回内容仍可被
  搜索到——这正是 brief 明确禁止的残留。

改动文件见 §9；所有测试计数见 §10。

> A 部分的 QwenPaw 行号均指 `~/workspace/qwenpaw-ref` 的 v2.2.2.post1；本仓库「改动前」行号指 `HEAD`
> （`625950d`）。B 部分的探查在动任何代码之前完成（§8 先于所有 B 结论；本次没有 B 代码）。

---

## 1. 复现：改动前到底发生了什么

方法：`tests/e2e_m19.mjs` 新增 M42 mock turn（`streamStopTurn`），按真实插件的帧序构造：

| 时间 | mock 发出的帧 | 浏览器状态 | 旧 SPA 的「停止」按钮 |
|---|---|---|---|
| t=0 | （无） | 用户消息 + 空 composer | **不存在**（没有 streaming 气泡） |
| t=1.2s | `start(reasoning)` + `evt` + `end(reasoning)` | 思考气泡 | 存在（气泡 `streaming:true`） |
| t=1.7s | `start(message)` + 若干 `evt` | 回答气泡 | 存在 |
| t=2.6s | `end(message)` + `msg(全文本)` + `msg(tool_call part)` | 气泡落定，工具卡片 | **不存在**（`streaming:false`，但工具还在跑） |
| t=5.1s | 第二个 `start(message)` + `evt` + `end` + `msg` | 第二段回答 | 存在（再次出现） |
| t=5.4s | `turn done` | 回合结束 | 不存在 |

旧 SPA 在 **t=0–1.2s** 和 **t=2.6–5.1s** 两个窗口没有停止入口；这两个窗口正是模型首 token 等待和工具执行。

点停止（有按钮的文本阶段）时的现状：

1. SPA 发 `{t:"stop",chat}`（改动前 `spa/src/App.tsx:4951`），**不改变本地任何状态**；
2. relay 正常转发（`relay-node/server.js:179-188`），mock 收到 stop；
3. mock 模拟旧插件：停掉 token 流，**不发 `end`/`msg`/`turn`**；
4. 旧 SPA 因此永久保持 `streaming:true`：caret、`.stop` 按钮、无「已停止」、`发送` 不回来。

红跑证据（`M42_ONLY=1 M42_LEGACY=1 node tests/e2e_m19.mjs`，日志 `tests/out/m42-red.log`）：
**35 checks / 16 failed**（desktop + mobile 各 8 条），关键失败原文：

```
FAIL desktop: M42 停止 is offered before the first token — {"stop":0,...,"text":""}
FAIL desktop: M42 停止 is offered during the tool-call phase — {"phase":"tool","stop":0,...}
FAIL desktop: M42 the stop frame reaches the agent — [...]          ← PASS：帧到了
FAIL desktop: M42 the stream stops after the stop frame — {"stop":1,"carets":1,...}
FAIL desktop: M42 the kept reply is marked 已停止 — []
FAIL desktop: M42 发送 is back right after stop — {"stop":1,"send":0,...}
```

「帧到了 agent」是 PASS——这直接排除了「停止帧被 seq/回放/控制帧规则吞掉」的候选（§3.4）。
修复后在同一个 mock 上改为发终态帧：**35/35 PASS**（`tests/out/m42-green-focused.log`）。

---

## 2. 全链路追踪（file:line）

### 2.1 SPA：按钮何时可见、可点

改动前：

- `spa/src/App.tsx:4386` — `const streaming = messages.some((m) => m.streaming);`
- `spa/src/App.tsx:6638` — `{streaming && state === 'live' ? <button className="stop">…`
- `spa/src/App.tsx:4951-4953` — `const stop = () => { clientRef.current?.send({ t: 'stop', chat: activeChat }); }`

`end` 处理 `spa/src/App.tsx:3681-3700`：只把当前气泡 `streaming:false`，并**不结束 turn**。工具调用的
`msg` 走 `rt.endedId` 分支（`:3706-3745`），还会 `applyPendingEffort`——旧代码把「第一段回答结束」当成了
「回合结束」。因此：

- 首 token 前：`messages` 里只有 user 行，`streaming=false`，按钮不存在；
- 工具阶段：`end(message)` 已把气泡 `streaming` 置 false，按钮消失；
- 点停止后：没有任何本地状态变化，完全依赖服务端发 `end`。

### 2.2 协议 / relay：stop 帧不会被吞

`relay-node/server.js:179-188`（relay-cf 同构）：客户端帧除 `ping`/`hb` 外**原样** `agent.send(text)`；
agent 不在线时进 `bufferForAgent`，不是丢弃。`stop` 是普通业务帧，不在任何控制帧白名单里。
§1 的红跑也实测「帧到达 agent」。**候选 4 排除。**

### 2.3 插件：解析与 API 调用

改动前 `plugin/channel.py:1059-1092`：

- `:_resolve_chat_id` → `GET /api/chats?channel=web` + `session_id` 匹配（`:_resolve_chat_id_state`），
  结果**永久缓存**在 `self._chat_ids`（`channel.py:327`）；
- 无 spec 时直接 `return`（只打 warning）；
- `POST /api/console/chat/stop?chat_id=<ChatSpec.id>`；
- HTTP ≥ 400 只打日志；**成功也什么都不回给浏览器**。

QwenPaw 侧：`app/routers/console.py:555-620`，`chat_manager.get_chat(chat_id)`；找不到时用
`get_chat_id_by_session(session_id=chat_id, channel="console")`——**硬编码 console**，所以 web 会话只能靠
`ChatSpec.id`。然后 `tool_coordinator.cancel_running_for_session(...)` 和
`task_tracker.request_stop(...)`。

### 2.4 QwenPaw：取消时到底发生了什么

1. `task_tracker.request_stop`（`app/task_tracker.py:227-263`）：`task.cancel(reason)`，然后 `await task`。
2. 取消传到 `BaseChannel._stream_with_tracker` 的 `anext`；其 `except asyncio.CancelledError`
   （`app/channels/base.py:1026-1036`）只 log、`aclose()`、`raise`——**不调用 `on_streaming_end`**。
   所以正常流的 `end`/尾随 `msg` 不会出现。
3. 但 runtime 在重新抛出前会走 `except asyncio.CancelledError`（`runtime/runtime.py:172-193`）：
   `_try_save_on_cancel`（`:244-355`，注入 partial 文本/思考、闭合悬空 tool call、`asyncio.shield` 保存
   session），然后 `envelope.cancel_envelope()`（`runtime/envelope.py:843-846`）→ `_finalize_response()`
   （`:858-903`）依次 yield 一个 `status=cancelled` 的 **message**（带已生成内容）和一个 `status=cancelled`
   的 **response**。
4. `_stream_with_tracker` 会处理这两个事件：message 的 `Cancelled` 不匹配任何 streaming 分支；response 走
   `elif obj == "response": await self.on_event_response(request, event)`（`app/channels/base.py:1869-1874`
   是空默认钩子）。**这是插件唯一能拿到「权威 partial 文本 + 确定取消」的官方钩子**。

---

## 3. 四个候选逐一裁定

| 候选 | 裁定 | 证据 |
|---|---|---|
| 1. 按钮在某些阶段不显示/不可点 | **成立，主因之一** | 旧判据 `messages.some(streaming)`；首 token 前与工具阶段都没有 streaming 气泡（§1 表） |
| 2. ChatSpec.id 解析失败/缓存过期（新会话首轮） | **部分成立**：首轮 spec 尚未创建时 stop 被静默丢弃；缓存永不失效，spec 重建后每次 stop 都是 200 `{"stopped":false}` 空操作 | 旧 `channel.py:1062-1070` 无重试、无失效；QwenPaw `console.py:568-585` 的 fallback 硬编码 console |
| 3. stop 只停 token、停不了工具 | **不成立（v2.2.2.post1）**：前台工具调用会被 `cancel_running_for_session(force=True)` 强制取消；边界是 offloaded/background 工作与不响应 cancel 的进程 | `tool_calls/_coordinator.py:459-497,962-972`；`console.py:586-604` |
| 4. 停止帧被 seq/回放/控制帧吞掉 | **不成立**：relay 原样转发；红跑实测帧到达 agent | `relay-node/server.js:179-188`；红跑日志 |

根因收敛为两条：**（a）SPA 的「在生成」判据是段级的，不是轮级的；（b）停止成功后没有任何轮级终态帧。**

---

## 4. 修复设计

### 4.1 协议 v12：一个显式的轮边界

新增/扩展（`protocol/frames.md` §18）：

| 帧/字段 | 方向 | 语义 |
|---|---|---|
| `turn {chat, seq, state:"done"\|"stopped"}` | container → browser | 一个完整 turn 的终点；有 `seq`、进 ring buffer、`resume` 可重放；正常完成/出错/stop 无运行都发 `done`，真正取消发 `stopped` |
| `msg.stopped:true` | container → browser | 被停止回答的最后一段全文；UI 保留文本并标「已停止」 |
| `stop_error {chat, code:"E_STOP", msg?}` | container → browser | stop 请求本身失败（HTTP/传输）；**控制帧**，无 `seq`；turn 仍在跑 |
| `hist.busy:boolean` | container → browser | 镜像 `GET /api/chats/{id}` 的 `status=="running"`；缺省=未知，不默认为 false |
| `status.protocol:12` | container → browser | 插件协议版本；用于 SPA 的向后兼容回退（§4.4） |

为什么不是复用 `end`：一个 turn 内有 reasoning/answer 多段，段间可以隔几分钟的工具执行；`end` 是段边界。
为什么 `turn` 要带 `seq`：停止发生在重连窗口时，客户端必须能通过 `resume` 得知轮已结束。

### 4.2 插件

- `_handle_stop`（`plugin/channel.py:1149`）：
  - **不阻塞 relay reader**：`_on_relay_frame` 用 `create_task` 调度（`channel.py:648-650`），
    因为解析 spec 最多等 4 s，stop POST 还要等运行真正取消；
  - `_stop_chat_id`（`:1109`）在 `GET /api/chats` 可读但无 spec（404）时轮询最多
    `_STOP_SPEC_WAIT_S=4.0s`（200 ms 间隔）；列表本身不可读则立刻放弃；
  - `_post_stop`（`:1133`）用 `_api_json`（可测试、统一 10 s 超时、传输失败 status=0）；
  - HTTP 失败 → `stop_error`，**不动 turn**；
  - `{"stopped":false}` 且 id 来自缓存 → 失效缓存、重解析一次；只有 id 真的变了才重试；
  - `stopped:true` → `_finalize_turn(chat,"stopped", text=_cancel_text)`；`false` → `_finalize_turn(chat,"done")`。
- `_finalize_turn`（`channel.py:1244`）：
  - 按 `<chat>#<serial>` 幂等；cancel 钩子与 stop handler 谁先到都只产出一套帧；旧 turn id 不得关闭新 turn；
  - 对每个打开的段补 `evt` 尾部 → `end`；answer 段再补全文 `msg`（`stopped` 标记）并归档；
  - 最后发 `turn`；清 differ / `_text_msg_sent`；成功后把 `_cancel_text` 清掉（失败则留给 stop handler 重试）。
- `on_event_response`（`channel.py:2493`）：只处理 `status=="cancelled"`，用
  `response_partial_text(event)`（`plugin/util.py`，纯函数）取权威 partial，stash 到 `_cancel_text` 后
  `_finalize_turn(..., turn_id=request.channel_meta.turn_id)`。这覆盖 stop、客户端断开、shutdown 等所有取消来源。
- `_on_process_completed`（`:2522`）→ `turn done`；`_on_consume_error`（`:2532`）先发错误文本再 `turn done`。
- `_handle_hist`（`:1052`）把 `ChatHistory.status` 映射成 `hist.busy`；读不到就**省略**。
- `_handle_msg`（`:758-767`）在 enqueue **之前**写入 `meta.turn_id` 并递增 serial。
- `status_frame` 带 `protocol:12`（`plugin/frames.py:PROTOCOL_VERSION`）。

### 4.3 SPA

- `busyChats` / `stoppingChats`（`App.tsx:2175-2186`），与 `message.streaming` 解耦：
  - 发送成功 / 收到 `start` / `hist.busy:true` → busy；
  - 只有 `turn`、`hist.busy:false`、`resync`、删除会话才清 busy；
- 停止按钮条件 `turnBusy && state==='live' && agentOnline`（`:6845`），label 在请求期间变
  「正在停止…」并 disabled；tooltip 如实写明「后台任务不会取消、已完成操作不回滚」；
- 点停止（`:5120`）→ `canReachAgent()` 校验；失败 toast；成功置 stopping + 12 s watchdog；
  **watchdog 只取消 label，不伪造停止**（toast 让用户重试）；
- `turn` 处理（`:3894`）：`flushNow` → 清 busy/stopping/watchdog → `closeTurn(chat, state==='stopped')`；
  `closeTurn`（`:2482`）冻结本轮所有 assistant 气泡，并把**本轮最后一个** assistant 标 `stopped`；
  首 token 前停止没有 assistant 行，不凭空造消息。
- `stop_error`（`:3911`）：清 stopping、toast，turn 继续；
- `msg.stopped` → 气泡 `stopped:true`（`:3825-3835`）；
- `hist.busy`（`:3992-4001`）：final chunk 采纳；`false` 时冻结残留；
- `.bubble-stopped` 样式（`App.css`）——小圆角标签「已停止」。

### 4.4 向后兼容（部署顺序）

新 SPA + 旧插件：旧插件没有 `turn`，若只认 turn 会让按钮永挂。SPA 从 identity `status.protocol` 判断：
`<12` 时回退到旧规则（answer 段 `end` / 非流式 `msg` 时清 busy）；`status` 无 `protocol` 即视为 0。
relay 的 presence `status`（只有 `agentOnline`、无 `agent_name`）**不得**改这个值。
新插件 + 旧 SPA：旧 SPA 忽略 `turn`/`stop_error`，仍按 `end`/`msg` 渲染；正常回答的尾随全文 `msg` 未变。

---

## 5. QwenPaw 停止语义边界（如实记录）

依据 `~/workspace/qwenpaw-ref` v2.2.2.post1（`console.py`、`task_tracker.py`、`tool_calls/_coordinator.py`、
`runtime/runtime.py`）：

| 对象 | 停得掉？ | 依据 |
|---|---|---|
| agent producer task（模型流、ReAct 循环） | **是**，`task.cancel()` + `await task` | `task_tracker.py:227-263` |
| 该 session/agent 的前台工具调用 | **是**，`cancel_event` + background task cancel，`force=True` | `_coordinator.py:459-497,962-972` |
| 支持 cancel_event 的子进程工具 | **是**，bridge 可拆进程树 | `_apply_force_cancel` 注释 |
| 显式 offload/background 工作 | **否**，设计上排除 | `cancel_running_for_session` docstring |
| 不响应 cancel_event、也不怕 task.cancel 的工具 | **无保证** | 协作式取消 |
| 已经发生的副作用（命令执行、写文件、发消息） | **不回滚** | stop 不是事务 |
| Provider 服务端的生成 | **不可观测**；本地 HTTP 流被中止 | — |
| 已生成的 partial 文本/思考 | **保留**：注入 context 并保存 | `runtime.py:244-355` |
| 悬空 tool call block | **闭合**为 interrupted 结果 | `runtime.py::_close_dangling_tool_calls` |

UI 只在停止按钮 tooltip 和「已停止」标签 tooltip 写这段边界，不宣称「什么都能停」。

**partial 在重载后的持久性**：QwenPaw 的 `_try_save_on_cancel` 会保存 partial，所以刷新后文本还在；
但 `stamp_console_turn`（`runtime/console_turn_state.py:61-68`）在 `request.channel != "console"` 时直接
return，web 通道的 turn 不会带 `qwenpaw_turn_state`，因此**「已停止」徽标只在当前会话有效，刷新后只保留
partial 文本、没有徽标**。这是如实的设计限制，报告不掩饰；要做持久徽标需要 QwenPaw 提供非 console 的
turn-state API（见 §8.9）。

---

## 6. A 部分测试

新增 `plugin/tests/test_m42.py`（14 个用例，纯 assert，无 pytest）：

- ChatSpec.id 作为 `chat_id` 发出；成功时 `end`+`msg(stopped)`+单个 `turn stopped`，二次 stop 不重复；
- 首轮 spec 迟到（前两次 GET 为空）时轮询后成功；
- 缓存 id 失效（`{"stopped":false}`）→ 重解析 → 用新 id 重试；
- HTTP 500 → `stop_error`，turn 保持打开；
- 无任何 spec → `turn done`；
- `stopped:false` → `turn done` 且 `msg` 无 `stopped`；
- runtime cancelled envelope 用权威 partial（含未 flush 尾部）关闭一次；completed 不触发；
- `_on_process_completed` / `_on_consume_error` 发 `turn done`；
- stale turn id 不关闭新 turn；
- `hist.busy` running/idle/缺失三种。

e2e（`tests/e2e_m19.mjs` 新增 `runM42Checks`，desktop + mobile 各 16 条）：

- 首 token 前有 `停止`、工具阶段有 `停止`、正常回合结束后按钮消失且无徽标；
- 文本阶段停止：帧到达、流停、partial 保留、`已停止`、`发送` 回来、composer 可编辑；
- 工具阶段停止：按钮存在、回合结束、已完成气泡被标 `已停止`、stop 帧恰好一次。

红/绿对照（两份红跑的配置不同，读数必须分开看）：

- 存档的 `tests/out/m42-red.log` 是 **16 FAIL / 35**，但它跑的是**改动前的 SPA（HEAD）** + 旧插件 mock
  行为：其中 8 条是旧 SPA 的停止按钮可见性/文案失败（desktop + mobile 各 4），与插件无关。
- 修复后的 `M42_ONLY=1 M42_LEGACY=1`（新 SPA + 旧 mock）是 **10 FAIL / 35**（coordinator 复核）：
  那 8 条可见性检查在 SPA 侧已经通过；另 2 条工具阶段轮结束检查因旧 mock 不发终结帧而**新变得可及**
  并失败；其余 8 条是旧 mock 静默停止导致的既定失败。
- 修复后 `M42_ONLY=1`（新 SPA + 新 mock）→ **35/35 PASS**。

日志留在 gitignored 的 `tests/out/m42-red.log`、`tests/out/m42-green-focused.log`。

---

## 7. B 部分：探查范围与方法

探查对象：QwenPaw v2.2.2.post1（`~/workspace/qwenpaw-ref`）的

1. 所有 `app/routers/*.py` 的路由（方法 + 路径）；
2. `app/chats/{api,manager,session}.py`（chats/session/history）；
3. 官方 console 前端的**全部 API 调用**（`console/src/api/modules/*.ts`）与 Chat 页面逻辑；
4. console 的 locale 文案（功能是否存在于 UI 的直接证据）；
5. runtime 的取消/回滚路径（`runtime/console_turn_state.py`、`hooks/session/session_hook.py`）；
6. durable scroll history 与 recall 工具（`agents/context/scroll/*`）；
7. checkpoints（`app/routers/checkpoints.py`、`checkpoints/service.py`）；
8. 插件自己的 Turso 归档与搜索。

## 8. 证据链与判定

### 8.1 路由清单：没有删除消息/截断轮次的 API

`app/chats/api.py` 的全部端点（`grep "@router."`）：

```
GET    /chats                 list（可 filter channel/archived）
POST   /chats                 create
GET/POST/PUT/DELETE /chats/groups...
POST   /chats/batch-delete    批量删「会话」
POST   /chats/{id}/archive | /unarchive
DELETE /chats/{id}            删 ChatSpec
GET    /chats/{id}            读历史（ChatHistory）
PUT    /chats/{id}            改元数据
GET/PUT /chats/{id}/thinking  思考等级
PUT    /chats/{id}/model
```

- `DELETE /chats/{id}`（`chats/api.py:946-976`）调用 `ChatManager.delete_chats`；后者的 docstring 明确：
  **“This only deletes the spec. Redis session state is NOT deleted.”**（`chats/manager.py:561-586`）。
  会话文件才是历史本体（`chats/session.py:278`），删 spec 后同 `session_id` 再次建 spec 会重新读到旧历史。
- `PUT /chats/{id}` 只改 `name`/`meta` 等元数据（`chats/models.py:99-211`），不改 `state.context`。
- 没有 `DELETE /messages/{id}`、`POST /chats/{id}/truncate`、`POST /turns/{id}/delete` 之类的端点。
- `app/routers/messages.py` 只有 `POST /messages/send`（向 channel 主动发文本），不是历史写。
- `app/routers/console.py` 只有 `POST /console/chat`（启动/重连 SSE）与 `POST /console/chat/stop`。
- `app/routers/fork.py` 是整状态复制到 `sub-*` 子 agent（M25 已探查），不是删除。

### 8.2 console 前端自己的调用：最强反证

`console/src/api/modules/chat.ts` 的 `chatApi` 全部方法：`listChats / createChat / getChat /
getChatStatus / updateChat / deleteChat / batchDeleteChats / archiveChat / unarchiveChat /
batchArchiveChats / batchUnarchiveChats / listGroups / … / stopChat`。
**没有任何 delete-message / delete-turn 调用。** 唯一与「删」有关的是删会话（`deleteChat`，`:135`）。

locale（`console/src/locales/zh.json:4074`）有：

```json
"chat.regenerate": "重新生成",
"chat.regenerateUnavailable": "该历史回合没有请求标识，请发送新消息继续。"
```

即：官方 console 的「重新生成」确实存在，但它**要求该历史回合带请求标识**（`qwenpaw_client_message_id`），
而 web 插件的 user 消息从未写过这个 id（`plugin/channel.py::_handle_msg` 的 `meta` 只有
`chat_id/session_id/turn_id`）。

### 8.3 唯一的「最后一轮回退」：console-only、请求级、内存内

`runtime/console_turn_state.py`：

```python
def prepare_console_regeneration(data, request):
    target = request_context.get(REGENERATE_FROM)          # :96
    if getattr(request, "channel", None) != "console":     # :100
        raise ValueError("Regeneration is only supported for console chats")
    ...
    state["context"] = context[:index]                     # :117 只截到目标 user 之前
    data.pop("scroll", None)                               # :120
```

调用点：`hooks/session/session_hook.py:84`，在 **SessionLoadHook** 里、agent 构建前。也就是说：

- 它不是 `DELETE` 端点，而是「下一次 `POST /console/chat` 带上
  `request_context.qwenpaw_regenerate_from`，在加载 session 时顺手把内存里的 context 截断」；
- **仅 console**；web 通道会直接 `ValueError`；
- 目标 user 消息必须带 `qwenpaw_client_message_id`（`console/src/utils/clientMessageId.ts`），由 console
  的 SDK 写入；web 没有；
- 截断只发生在**内存**，随后新回合的 `SessionSaveHook` 覆盖保存；没有独立的「删除」API 可供插件调用；
- 它还 `data.pop("scroll")`，但不调用任何 history 删除；durable `conversation_history` 的删除面只有
  `purge(before=…, kinds=…)`（`agents/context/scroll/history.py:1165-1232`，按时间/类型），**没有按轮删除**。
  recall 工具搜索的正是这张表（`agents/context/scroll/recall_tool.py:799-829`）。

因此，即使官方 console 的「重新生成」，从「可搜索残留」角度看也不是一次彻底的删除。

### 8.4 会话文件的写面：只有整份保存，且不是 HTTP

`app/chats/session.py`：`save_session_state`（`:278`，整份 state 写 JSON）、`load_session_state`（`:308`）、
`update_session_state`（`:354`，按 key 路径整份读-改-写）。后者是 **in-process Python API**，没有 HTTP 路由；
它不是「删一轮」，而是任意改写整个 session 文件。用它做撤回 = brief 明令禁止的 history surgery，而且
agent 的内存 state 不会同步，等于假撤回。**不做。**

### 8.5 checkpoints：能做时间旅行，但不是撤回

`app/routers/checkpoints.py` / `checkpoints/service.py:734`：按 commit 恢复**整个 session**（可选 memory/
workspace files），需要先有一个早于目标轮的 checkpoint，且会 quiesce 运行中的任务、可回滚文件。它不是
「删最后一轮」的 API，副作用远大于撤回（会连同文件/记忆一起回退），auto checkpoint 也未必每轮都有。
**不采用。**

### 8.6 Turso 归档：删除面不存在，且是异步写

插件自己的归档（M13 搜索的数据源）：

- schema：`messages(id AUTOINCREMENT, chat_id, role, content, created_at)`（`plugin/turso_archive.py:36`）；
- 写：只有 `INSERT`（`_MESSAGE_INSERT_SQL`，`:128`）与 chats upsert；**没有任何 DELETE/UPDATE**；
- 搜索：`LIKE` 扫 `messages.content`（`plugin/turso_search.py:58,246`），不是 FTS5，也没有 turn/消息 id。

如果主历史删了一轮，归档里 user 与 assistant 两行都会留着，搜索仍能命中——**不可接受的残留**。
要把它做成「已处理」，至少需要：

1. 归档 schema 增加 turn/消息身份（现在只有毫秒时间戳）；
2. 一个删除面（`DELETE FROM messages WHERE chat_id=? AND id>=?`）；
3. 一个 per-chat tombstone/epoch：归档是 fire-and-forget（失败重试两次后丢弃），删除与异步追加会竞争，
   晚到的 assistant 批次必须被 tombstone 抑制，否则「删完又长回来」；
4. QwenPaw 自己的 `conversation_history`（scroll）与 checkpoint git 历史同样要处理，而插件对它们没有受支持的
   删除 API。

### 8.7 判定

**没有干净路径。** 直接障碍按重要性排序：

1. **没有删除/截断轮次的受支持 HTTP API**；删会话只删 spec，不动历史本体。
2. 唯一的 last-turn rewind 是 **console-only + 请求级 + 需要 client message id**；web 通道三个条件全不满足。
3. 即便绕过（session 文件 surgery）也是**假撤回**：agent 的内存 context 仍含该轮，模型还能引用；
   而且会破坏 scroll/归档一致性。
4. 可搜索残留没有受支持的同步手段（Turso 无删除面；scroll 只有按日期 purge）。

按 brief 的要求：**Part B 不写任何代码**（没有会话文件手术、没有本地隐藏的假撤回）。A 部分照常交付。

### 8.8 与 M20 结论的关系

M20 的结论是「无受支持的历史改写 API（regenerate/edit）」。本次针对**最后一轮**重核：

- 结论**仍然成立**，但新增一条精确事实：v2.2.2.post1 确实存在一个「最后一轮回退」实现
  （`prepare_console_regeneration`），它不是 HTTP 删除 API，且被 `channel=="console"` 与
  `qwenpaw_client_message_id` 双重门禁；对 web 通道不可用。M20 没有记录这条 console 内部路径，本次补上。

### 8.9 未来重探条件（满足任一即可重新评估）

1. QwenPaw 提供按消息/按轮删除的 HTTP API（如 `DELETE /chats/{id}/messages/{message_id}` 或
   `POST /chats/{id}/turns/truncate`），且不限制 `channel=="console"`；
2. `prepare_console_regeneration` 的 channel gate 移除，并接受显式的目标消息 id（不要求
   `qwenpaw_client_message_id`）；
3. console 的 regenerate 被抽成独立端点，接受 `channel` + `session_id` + 目标消息；
4. QwenPaw 提供 turn-state/删除的插件 API（不是 session 文件格式），并同时提供 scroll history 的按轮删除；
5. 插件侧先给所有 web user 消息写入稳定的 `qwenpaw_client_message_id`，且 QwenPaw 允许 web 通道使用
   regenerate——这是「重新生成」路径，不是「撤回」，但可作为重发的基础。

重探时仍需回答：Turso 归档 + QwenPaw scroll history + checkpoints 三处残留如何同步；本次 §8.6 的方案可作为起点。

---

## 9. 改动文件

| 文件 | 改动 |
|---|---|
| `plugin/channel.py` | stop 异步化、spec 轮询/缓存失效重试、`stop_error`、`_finalize_turn`、`on_event_response` 取消钩子、`_on_process_completed`/`_on_consume_error` 轮边界、`hist.busy`、turn id |
| `plugin/frames.py` | `turn_frame`、`stop_error_frame`、`msg_frame(stopped=)`、`hist_frame(busy=)`、`status_frame(protocol=)`、`PROTOCOL_VERSION=12` |
| `plugin/util.py` | `response_partial_text`、`response_status` 纯函数 |
| `plugin/tests/test_m42.py` | 新增 14 个用例 |
| `plugin/tests/test_m7.py` | status frame 断言补 `protocol:12`（3 处） |
| `spa/src/App.tsx` | busy/stopping 状态、turn/stop_error 处理、closeTurn、已停止徽标、stop 请求/watchdog、protocol 回退、hist.busy |
| `spa/src/App.css` | `.bubble-stopped`、`.stop:disabled` |
| `tests/e2e_m19.mjs` | M42 mock turn（含工具阶段）+ `runM42Checks` + `M42_ONLY`/`M42_LEGACY` + mock status 补 `protocol:12`、peer 重推 status |
| `protocol/frames.md` | v11→v12；§2 表新增 `turn`/`stop_error`/`msg.stopped`/`hist.busy`/`status.protocol`；新增 §18（轮边界、stop 语义边界、兼容性、B 的边界声明） |
| `docs/m42-report.md` | 本文件 |

未构建/未提交插件 ZIP、未部署（按 brief 交给 coordinator）。

---

## 10. 测试结果（本次实测）

| 套件 | 结果 |
|---|---|
| 插件全部套件（22 个 `test_*.py`，含新 `test_m42.py`） | **全部 ALL PASS**；M42 = 14/14 |
| SPA vitest | **312/312**（20 files） |
| e2e_m19 全量 | **621/621**（desktop + mobile；原 589，新增 M42 32 条） |
| e2e_m29 | **26/26** |
| M42 聚焦红跑（旧 SPA HEAD + 旧 mock，存档 `tests/out/m42-red.log`） | **16 FAIL / 35**（含 8 条旧 SPA 的按钮可见性/文案失败） |
| M42 聚焦红跑（新 SPA + 旧 mock，`M42_ONLY=1 M42_LEGACY=1`） | **10 FAIL / 35**（8 条可见性已过；2 条工具阶段轮结束因缺终结帧新可及而失败） |
| M42 聚焦绿跑（`M42_ONLY=1`） | **35/35 PASS** |

运行方式：

```bash
# 插件（需要 QwenPaw venv 里的 httpx）
cd plugin && for f in tests/test_*.py; do ~/workspace/qwenpaw-local/venv/bin/python "$f"; done

# SPA
cd spa && npm test

# e2e（需要先 build）
cd tests && node e2e_m19.mjs
cd tests && node e2e_m29.mjs

# M42 快速复现/验证
cd tests && M42_ONLY=1 M42_LEGACY=1 node e2e_m19.mjs   # 红（10 FAIL；16 FAIL 那份跑的是旧 SPA）
cd tests && M42_ONLY=1 node e2e_m19.mjs                 # 绿
```

---

## 11. 残留风险 / 已知限制

1. **「已停止」徽标不持久**：刷新后 partial 文本保留（QwenPaw cancel-save），徽标消失（web 没有 turn-state
   元数据；`stamp_console_turn` 仅 console）。这是 QwenPaw 侧限制，已在 §5 与 §18.3 写明。
2. **stop 无运行可取消**（`{"stopped":false}`）时前端按 `done` 处理，不标「已停止」；若用户确实看到生成，
   说明 SPA 的 busy 与后端状态短暂不一致，按钮会由后续 `start`/`hist.busy` 纠正。
3. **stop 在 spec 创建前 4 s 窗口内仍可能落空**（消息尚未被 QwenPaw 消费）；此时 SPA 收到 `done`，
   生成若随后开始会重新置 busy，用户可再点一次。4 s 是权衡值，测试覆盖了「迟到 spec」路径。
4. **多消息并发**（上一轮未结束时又发一条）：turn id 以最新消息为准，旧轮不会被误标为新轮的停止；极端的
   「旧轮 stopped、新轮尚未 start」窗口可能让新轮短暂显示旧轮的终态，下一帧会纠正。QwenPaw 的队列串行化
   使该窗口很短。
5. **M42 e2e 的 stop 后半段是 mock 协议实现**，不是真实 QwenPaw 进程；真实取消路径由
   `plugin/tests/test_m42.py` + §5 的源码证据覆盖。生产环境建议 coordinator 用真实 QwenPaw 做一次手工
   stop（长工具调用）复核。
6. **Part B 未实现**：这是有意为之，不是遗漏；重探条件见 §8.9。

---

## 12. 补记：CI 无宿主包环境的 stub 缺口

CI（Python 3.12，只装 `httpx` + `websockets`，无 `qwenpaw` 包）暴露了一个此前被本地 QwenPaw venv
掩盖的问题：`plugin/channel.py` 顶部 `try: from qwenpaw.app.channels.base import ...` 的
`except ImportError` 回退 `BaseChannel` 只实现了 `__init__`，而 M42 的
`WebChannel._on_consume_error`（`channel.py:2544`）会调用
`await super()._on_consume_error(request, to_handle, err_text)`，于是 `test_m42.py`
以一个 `AttributeError: 'super' object has no attribute '_on_consume_error'` 直接失败。

- **产品代码本身没问题**：覆写与真实基类签名一致（`qwenpaw-ref` v2.2.2.post1
  `app/channels/base.py:2003`），缺的只是测试替身。
- **修复**：在回退 stub 中补 `_on_consume_error`（`channel.py:51`）。它不只占位：真实基类默认实现是
  用 `send_content_parts` 把 `err_text` 发出去，而 `test_m42.py::test_consume_error_sends_text_then_done`
  断言帧序为 `["msg", "turn"]`；纯 `pass` 的空实现只能发出 `["turn"]`（已实测失败），所以 stub 按真实
  默认行为镜像发送。
- **核对**：`channel.py` 中 `super().` 调用只有两处 —— `__init__`（`channel.py:325`，stub 早已覆盖）
  与 `_on_consume_error`，回退类现已无缺口。
- **验证**（`plugin/` 下对所有 22 个 `tests/test_*.py` 逐个运行）：
  - 干净 venv（Python 3.12.3 / httpx 0.28.1 / websockets 15.0.1，无 `qwenpaw`）：修复前 **21/22**
    （仅 `test_m42.py` 失败，报上述 `AttributeError`），修复后 **22/22 ALL PASS**。
  - `~/workspace/qwenpaw-local/venv/bin/python`（带宿主包）：修复后 **22/22 ALL PASS**，无回归。

CI 现可直接用纯依赖环境跑插件套件，不必依赖本地 QwenPaw venv。
