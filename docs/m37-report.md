# M37 — 离线/断线发送队列（Outbox）

**结论：纯 SPA 改动即可实现，无需动协议或插件。** 排队消息走的就是 `{t:"msg"}` 正常发送路径，重连后按序发出；
未送达/未确认的条目永不自动重发（协议没有逐条回执，重发即可能出双份）。

改动：`spa/src/lib/outbox.ts`（新，纯逻辑）、`spa/tests/outbox.test.ts`（新，25 个用例）、
`spa/src/App.tsx`、`spa/src/App.css`、`tests/e2e_m19.mjs`（M37 段 + mock 侧记录）、
`tests/probe_m37.mjs`（现状探查脚本）与其证据 `tests/m37-probe-before.{json,log}`。

---

## 1. 探查：改动前的真实行为

方法：`tests/probe_m37.mjs` 起 relay-node + 最小 mock agent + `vite preview`，用 Playwright 在三个状态下真点发送；
`P4 途中断线` 用 `context.routeWebSocket` 劫持浏览器→relay 的 socket，在客户端把 `msg` 写出的那一刻**不转发**并关闭连接，
模拟「帧已出、对端未收、没有任何回执」。改动前的完整证据在 `tests/m37-probe-before.json`
（可用 `M37_SPA_DIR=<旧版 spa 目录> node tests/probe_m37.mjs` 复现）。下面的行号均指改动前的提交 `96ef95e`。

| 状态 | 代码今天做什么 | 证据 | 实际后果 |
|---|---|---|---|
| **WebSocket 断开/重连中** | 发送按钮被禁用（`canSend` 要求 `state === 'live'`）；回车走 `send()` → `client.send()` → `raw()` 在 socket 非 OPEN 时返回 false → `setComposerError('未连接 — 正在重连，请稍后重试。')`，输入框内容保留 | `spa/src/App.tsx:5094`（canSend）、`:4739`（send）、`:4777-4779`（失败分支）、`spa/src/relay.ts:142,160-164` | **不丢，但也不排队**：点击按钮毫无反应（禁用），回车只报一句错；重连成功后这条消息仍未发出，错误文案还留在输入框上方，需要用户再按一次回车（探针 P2：`received` 列表不变、`input` 仍是原文、错误文案持续）。 |
| **已连接、agent 离线（插件重启窗口）** | `client.send()` 返回 **true**（浏览器 socket 是 OPEN），帧被写进 relay；relay 在自己的 outbox 里缓存，等 agent `hello` 时按序 flush | `spa/src/App.tsx:4777`（返回 true 即当成功）、`relay-node/server.js:147-148,56-71,113`、`relay-cf/src/index.ts:557-583,573-585` | **假成功**：气泡立刻以普通消息渲染，没有 pending 标记、没有错误、没有回执；消息实际躺在 relay 内存（node）/ Durable Object storage（cf）里，agent 回来才真正送达（探针 P3：9 秒后才到）。期间：① header 仍显示「Agent 在线」（relay 只把 `peer` 发给 agent，`relay-node/server.js:36,121`、`relay-cf/src/index.ts:499-500`，浏览器永远收不到「agent 掉了」）；② relay-node 的缓存是内存，relay 一重启就没了；③ 超过 500 帧 / 1 MB 会**丢最旧的**（`relay-node/server.js:11-12,56-63`）。 |
| **发送途中断线（帧已出、无回执）** | `send()` 返回 true（写进了浏览器缓冲），TCP 断掉后帧消失；本地气泡已经当成功插入 | `spa/src/App.tsx:4777,4788-4805`；探针 P4 的 `dropped`/`received` | **静默丢失 + 假成功**：气泡在，没有任何错误；刷新后气泡消失（history 里从来没有这条）。用户永远不会知道它没发出去。 |
| 在线、服务端明确拒绝 | 错误帧 → toast | `spa/src/App.tsx:3936` | 正常报错（本次不改；在线失败不进队列）。 |

**根因（协议层）**：`msg` 是 fire-and-forget —— 插件 `_handle_msg` 不产生任何回执
（`plugin/channel.py:651-725`），客户端唯一的「送达证据」是聊天历史（`hist`）。
另外两个 relay 都**不向浏览器广播 agent 在线状态**：`ready{agentOnline}` 只在（重）连握手时给一次，
`status` 是插件自己 attach 后推的（`plugin/channel.py:645-647`），掉了没有反向通知。

**因此**：M37 只在**浏览器可观测**的两种状态下入队 —— ①socket 不在 `live`；②`ready` 说 `agentOnline === false`（含 agent 掉线后重连的场景）。
「socket 还开着、agent 中途死掉」在浏览器侧无法区分（relay 不广播），这一窗口仍由 relay 自己的缓存兜底 —— 第 7 节把它列为已知边界，不假装解决。

---

## 2. 设计

### 2.1 数据模型（`spa/src/lib/outbox.ts`）

```
OutboxEntry {
  id        本地 id（o<time36><rand>，永不上网）
  chat      会话 id
  text      上线用的文本（技能指令已拼好）
  display   气泡显示的文本（`@skill …`）
  raw       原输入框文本，撤销时还回输入框
  status    'queued' | 'sent' | 'failed'
  unconfirmed  sent 期间断线 → true（「不知道送没送到」）
  echo      这条是否已经在消息流里有一枚普通气泡
  attempts  已交给 socket 的次数（上限 3）
  ts        发送时刻（气泡时间）
}
```

存储：`localStorage["webchannel.outbox"]`，一个 JSON 数组；数组顺序就是发送顺序（per-chat FIFO 由它保证，
`enqueueOutbox` 只 append，`reconcile`/`remove` 只删不改序）。写入是 best-effort（配额被拒也不抛），与 M22 drafts 一致。
**只有需要下次访问记住的条目落盘**（`persistableOutbox`）：`queued` / `failed` / `sent+unconfirmed`；
一枚正常的 `sent` 已经显示在屏幕上，只对「本次连接是否断」有意义，不落盘（否则每次断线都会把历史所有消息标成未确认）。

### 2.2 状态机

```
               ┌──────────── 入队（离线/agent 离线，或在线但写 socket 失败）──┐
               ▼                                                            │
           [queued] ──flush（live && agentOnline，正常 {t:"msg"}）──▶ [sent] ─┼─ 8s 内连接一直健康 ─▶ 删除（视为送达）
               ▲                                                            │
               │                                                    断线（离开 live）
               │                                                            ▼
           [failed] ◀── reconcile：历史里找不到 ──────────── [sent + unconfirmed]
               │                                                            │
               │                                                     重连后请求 hist
               └── 用户点「重试」（attempts < 3）                           │
                                                                    历史尾部能对上 → 删除（确认送达）
```

* **入队条件**：`!(state === 'live' && agentOnline)`，或 `client.send()` 返回 false（socket 在状态读取后瞬间关掉）。
  在线且写成功 → 原路径，不碰队列；服务端拒绝 → 原路径报错。
* **flush**：`live && agentOnline` 时按数组顺序把 `queued` 逐条用 `{t:"msg", chat, text}` 发出（与 composer 完全同一条路径，
  不新增任何帧），发完把这条变 `sent` 并给消息流补一枚**普通**用户气泡（就是 `send()` 一直有的本地回显）。
  跨会话也 flush（用户按过发送就是按过），但只在「该会话已加载」或「它就是当前会话」时补气泡 ——
  否则该会话第一次 `hist` 会把服务端那份追加进来，出现双份。
* **确认/放弃**：`sent` 期间断线 → 全部标 `unconfirmed`。重连后延迟 1.2 s 发一次 `hist`（`histPurpose:"reconcile"`），
  回答**只喂 outbox，不进消息流**（否则已加载的会话会整段重复）。历史里最后 k 条用户消息恰好等于队首 k 条 → 这 k 条确认送达、直接删除；
  其余保留为 `failed + unconfirmed`（黄色「未确认」，带撤销/重试），**绝不自动重发**。
* **重试上限**：`attempts` 每交一次 socket +1，`MAX_SEND_ATTEMPTS = 3`。到上限后 flush 不再发、行内只剩「撤销」，
  即「保留在队列、标红交给用户」。手动「重试」不清零计数（否则上限形同虚设）。
* **上限**：每会话 20 条、全局 100 条；超限**拒绝入队并提示**，不丢最旧（丢用户以为发出去的消息正是本功能要避免的）。
* **撤销**：单条删除；未回显的条目把 `raw` 还回输入框（当前会话且输入框为空）或写回该会话草稿（M22），已回显的条目不还文本（屏幕上已有一份）。

### 2.3 UI

待发送消息在消息流末尾以独立行出现（**不进 `messagesByChat`**，因此 `resync` 清空历史也不会带走它）：

* `待发送` + 「连接恢复后自动发出」，虚线气泡，只有「撤销」（`data-outbox-state="queued"`）；
* 未确认/失败：`未确认` / `发送失败`，红底 +「已尝试 N 次」，有「撤销」，未到上限时还有「重试」（`data-outbox-state="unconfirmed"|"failed"`）；
* 已经回显过的条目（`echo:true`）只显示一条**紧凑状态条**（不上重复正文，只给前 40 字预览）——同一句话在屏幕上最多出现一次。
* 手机（≤720px）按钮 44px 高；断线时输入框占位文案改为「断线中 — 发送会先排队，连接恢复后自动发出」；
  断线时发送按钮**不再禁用**（否则没法排队），流式回复中还活着的「停止」按钮只在 `live` 时出现，避免断线后卡在停止状态。

---

## 3. 附件：离线**阻止入队**并明确提示

选择「阻止」而不是「只发文本」，理由（都可查证）：

1. inline 附件是 base64 进 `msg.files[]`，单帧上限 256 KB；放进 localStorage 会挤爆配额且无任何提示；
2. chunked 附件只有一个 `ref`，插件侧 staged 记录 **10 分钟**过期（`plugin/util.py:712` `TRANSFER_TTL_S = 600`），
   过期后 `_resolve_file_entry` 直接「entry dropped」并只记一条 warning（`plugin/channel.py:796-805`）——
   正文照发、附件**静默消失**，正是任务禁止的「静默丢附件」；
3. 因此离线时点发送（带附件）→ `attachNotice`：
   「离线时无法排队带附件的消息：请恢复连接后重试，或移除附件只发送文字。」
   输入框与附件区保持原样，什么都不丢；用户恢复连接后可原样再点发送。

---

## 4. 与既有机制的衔接

* **M22 草稿**：草稿是「没发」、outbox 是「已点发送、待送达」，互不混用。点发送（无论入队还是直接发出）后清空该会话草稿
  —— 这正是两者边界；撤销时把文本还回输入框/草稿（见 2.2），所以「草稿里还有一句话」永远不会同时出现在队列里。
* **M27 思考等级**：完全不碰。排队消息最终走的是同一条 `msg` 路径，QwenPaw 照常建 turn；
  `applyPendingEffort` 仍由「turn 结束」（`end` / 收尾 `msg`）触发（`spa/src/App.tsx:3391,3424,3473`），
  与 flush 时机无关。断线时 `effortSentRef.clear()` 仍照旧执行，重放逻辑不变。
* **seq / resume**：`msg` 是浏览器→agent，本身没有 seq；队列条目从不参与 `lastSeq`，也不会被 ring buffer 重放。
  待发送行是独立渲染，`resume`/`resync` 清空/重写 `messagesByChat` 都带不走它；`resync` 反而会触发一次 `hist`，
  顺带复核队列。`histPurpose` 在断线时清空、每次 `requestHist` 都显式写 `'view'`，避免一次被中断的 reconcile 把后续有人看的 `hist` 吞掉。
* **M35 附件**：见第 3 节（离线阻止入队）。
* **M19 会话列表**：恢复的队列若指向本次没见过的会话，只 `ensureChat` 加入（与 M19「只增不删」一致）。
* **M23/M24/M25/M34/M36**：未触碰其状态机；`hist` 的新分支只在 `histPurpose === 'reconcile'` 时接管。

---

## 5. 去重与「永不双份」的论证

1. 服务端**从不回显**用户消息（`onFrame` 的 `msg` 只处理 assistant，`spa/src/App.tsx:3396-3476`），所以双份只可能来自「本地回显 + 历史」。
2. 排队期间只有待发送行；flush 时它变成普通气泡，并且只变一次（`echo` 标记）。
3. 历史里的同一句话：reconcile 的 `hist` 回答只喂 outbox；正常 `hist` 走 `appendHistory`，其尾部重叠合并沿用 M19/M31 逻辑。
4. 回显过的条目再次出现在队列里（未确认/重试）时，渲染的是状态条而不是第二条正文。
5. **不自动重发任何已写进 socket 的条目** —— 这是「零双份」的硬保证；代价是极少数情况下用户会看到「未确认」，可手动重试。

**残留风险（诚实记录）**：reconcile 用「历史尾部前缀匹配」，文本完全相同（用户连按两次「ok」）且只到一条时，
只能确认前一条，后一条标未确认 —— 选择 at-most-once（宁可在极罕见情况下少确认一条，也不重复显示）。
插件持久化若晚于重连后 1.2 s，也会表现为「未确认」。协议没有逐条 ack，这一点无法在 SPA 内彻底消除。

---

## 6. 测试

| 套件 | 结果 |
|---|---|
| `spa/tests/outbox.test.ts`（新增） | **25/25**：入队/FIFO 跨会话、持久化往返、损坏数据丢弃、每会话 20 / 全局 100 上限、单条撤销、sent/attempts/上限、未确认标记、reconcile 五种形态、落盘过滤、grace 清理 |
| `vitest` 全量 | **304/304**（19 个文件；M36 时 279） |
| 插件套件 `plugin/tests/test_*.py` | **21/21** 套件通过（`~/workspace/qwenpaw-local/venv/bin/python`） |
| `tests/e2e_m19.mjs` 全量（desktop + mobile） | **505/505** checks（M36 时 447；M37 新增 58） |
| `M37_ONLY=1` 单跑 | **61/61** |
| `tests/e2e_m29.mjs` | **26/26** |

M37 的 e2e 覆盖（每一 pass 都跑）：

1. 在线基线：发出、到达 mock、无待发送行、只有一枚气泡；
2. 杀掉 relay（**连 mock 一起下线**，这是浏览器唯一可观测的「后端没了」）→ 连发两条 → 两条都是 `queued` 待发送、输入框已清空、
   无报错、`webchannel.outbox` 里有两条、mock 一条都没收到；
3. **刷新页面** → 两条仍在、仍是 `queued`；
4. 恢复 relay + mock → 两条**按序各到达一次**、待发送行变成普通气泡、**同一文本只出现一次**、落盘队列清空；
5. 「已连接、agent 离线」：先证明 socket 开着时 agent 死了浏览器**看不出来**（header 仍是「Agent 在线」，已知边界），
   再在 agent 掉线时**重连**让 `ready{agentOnline:false}` 成为权威 → 发送进入队列 → 撤销（文本回到输入框、落盘消失）→ 重发 →
   agent 回来推 `status` → 自动发出、只出现一次；
6. 中断发送：预置两条 `sent+unconfirmed`（一条真的在历史里、一条不在）→ 刷新 → reconcile 删掉已送达那条、另一条变成
   「未确认」状态条，且**不新增任何历史行**。

---

## 7. 边界与后续（需要协议/插件才能继续）

1. **agent 中途掉线对浏览器不可见**：两个 relay 都只把 `peer` 发给 agent（`relay-node/server.js:121`、`relay-cf/src/index.ts:499-500`），
   浏览器只能靠 `ready` 与 agent 自己推的 `status` 判断「在线」。要彻底解决，需要 relay 在 agent attach/detach 时向 clients 广播
   一个 presence 帧（协议新增语义）——本次没有做，因为那属于改协议，且现有 relay 缓存已能兜住这一窗口的绝大多数情况。
   该窗口内发消息仍可能：relay 重启（node 内存）丢失、或缓存超 500 帧/1 MB 丢最旧。
2. **没有逐条 ack**：`msg` 无回执，未确认条目只能靠历史判定（第 5 节）。
3. 队列只存文本；带附件的离线发送被明确阻止（第 3 节）。
4. 队列上限是硬拒绝，不是自动清理；极端情况下用户需要先撤销旧条目。

---

## 8. 复现

```sh
# 现状（改动前）行为表
M37_SPA_DIR=<旧版 spa 目录> node tests/probe_m37.mjs   # → tests/m37-probe.json

# 单元
cd spa && npx vitest run tests/outbox.test.ts

# 端到端
M37_ONLY=1 node tests/e2e_m19.mjs
node tests/e2e_m19.mjs
```
