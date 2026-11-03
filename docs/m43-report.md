# M43 — 回答进行中发送新消息：排队 / 立即发送

Task: `tasks/m43-busy-queue-task.md`. SPA-only expected.

---

## 1. Probe (Phase 1)

### 1.1 SPA today (what happens if you send while the chat is generating)

**Sending is not blocked at all today.** The send button only checks that there
is text or an attachment:

- `spa/src/App.tsx:5719` — `canSend = (input.trim().length > 0 || attachments.length > 0) && !uploadBlocked`.
  `turnBusy` is *not* part of it.
- `spa/src/App.tsx:6867` — `<button className="send" onClick={send} disabled={!canSend}>`.
  So the button is enabled while a turn runs.
- `spa/src/App.tsx:5327-5422` — `send()` has no busy guard: it builds the
  `{t:"msg"}` frame, checks size (`5358`), then `canReachAgent() ? clientRef.current : null`
  (`5366`) and `client.send(frame)` (`5367`). On success it marks the chat busy
  (`markBusy(chat, true)` at `5391`) and appends the user bubble (`5398`).
- `spa/src/App.tsx:2554` — `canReachAgent = connRef.current === 'live' && agentOnlineRef.current`.
  This is a *connection* gate, not a turn gate: a live socket with an
  in-flight turn passes.
- The composer suppresses no input either; the textarea stays editable and
  only the **stop** button reflects the turn state (`6848`: `turnBusy && state === 'live' && agentOnline`).

So today "send during a turn" == "write a second `msg` frame immediately". No
queue, no warning, no optimistic reordering. The button does not say anything
about what will happen.

Busy sources already available *inside* the SPA (M42, protocol v12):

- `spa/src/App.tsx:2183` `busyChats` / `2185` `stoppingChats` (per-chat sets, state + ref).
- `spa/src/App.tsx:2450` `markBusy` / `2459` `markStopping`.
- `spa/src/App.tsx:4559` `turnBusy = streaming || busyChats.has(activeChat)`
  (used by the composer's stop button and by this feature).
- `spa/src/App.tsx:3894-3909` — `case 'turn'`: the **only** turn-end signal
  (sequenced frame, M42). It clears busy/stopping, closes the turn and is
  emitted for both `state:"done"` and `state:"stopped"`.
- `spa/src/App.tsx:3993-4002` — `hist.busy` (optional boolean) seeds busy
  after a reload; absent means "unknown", never "idle".
- `spa/src/App.tsx:5308/5391` — busy is also set locally the moment a frame is
  written, before the first token.

There is **no** second busy notion anywhere in the SPA, and `turn` is the only
authoritative end-of-turn event.

### 1.2 QwenPaw side — a second message for the same session mid-turn

The plugin is a regular QwenPaw **channel**, not a console-router client:
`plugin/plugin.py:46` `api.register_channel(channel_class=WebChannel, ...)`, and
`plugin/channel.py:305` `class WebChannel(BaseChannel)`. The channel layer is
what decides concurrency.

Path of one `msg` frame:

1. `plugin/channel.py:698` `_handle_msg` builds the native payload
   (`channel_id:"web"`, `sender_id`, `content_parts`, `meta.session_id` =
   `web:web-user:<chat>`, `meta.turn_id = "<chat>#<serial>"`) and hands it to
   the host through `self._enqueue(native)` (`plugin/channel.py:777`).
   `_turn_serial` is bumped and `_turn_closed` cleared at `plugin/channel.py:772-775`.
2. `qwenpaw/app/channels/manager.py:249` `_enqueue_one` classifies the priority
   and builds the queue key; `manager.py:278` `priority_level = get_priority_level(query)`;
   the payload is put on a **per-(channel, session, priority)** queue
   (`manager.py:315` → `unified_queue_manager.py:119 enqueue`).
3. `unified_queue_manager.py:137` `queue_key = (channel_id, session_id, priority_level)`
   — one `asyncio.Queue` and **one consumer task** per key (`unified_queue_manager.py:180-190`).
4. `manager.py:385` `payload = await queue.get()` then `manager.py:421`
   `await _process_batch(ch, batch)`: **the consumer awaits the whole turn
   before it reads the next payload.** One turn at a time per session.
5. `_process_batch` (`manager.py:41-67`) may *merge* a drained batch
   (`merge_native_items`, `channels/base.py:196-226`, concatenates
   `content_parts`), i.e. two messages that are already sitting in the queue
   when the consumer wakes become **one** turn. It never runs two turns
   concurrently.
6. `channels/base.py:567` `attach_or_start(chat.id, ...)`; if a run were
   somehow still alive it returns `is_new=False` and the channel logs
   "Message ignored (task already running)" (`base.py:588-598`) — this is the
   defensive path, not the normal one ("This should not happen with
   UnifiedQueueManager", `base.py:592`).
   `task_tracker.py:262-281` shows the semantics: an existing run is
   *attached to* (its buffer replayed), the new payload is **not** executed by
   that call.

**Verdict: serial queue, not reject and not concurrent.** A second `msg` for a
busy session waits in QwenPaw's per-session queue and runs as the next turn
after the current one finishes. Nothing is lost and nothing errors.

The one place that does reject is the **console router** —
`routers/console.py:498` + `508` returns **HTTP 409** "A task is already
running for this chat" — but the plugin never posts messages there (it only
uses `POST /api/console/chat/stop`, `plugin/channel.py:1153`). It is irrelevant
to the web channel.

Interaction with M42's turn bookkeeping (important for the UX copy):

`plugin/channel.py:772-776` increments `_turn_serial` on *every* accepted user
message. `_finalize_turn` computes `current` from the latest serial
(`plugin/channel.py:1271`) and refuses a frame whose `turn_id` is stale
(`plugin/channel.py:1279-1285`). So if a second message arrives mid-turn, the
running turn ends **without** a `turn` frame; only the last turn of the burst
emits one. Consequence: the SPA stays `busy` for the whole burst — which is the
truth (the backend is still working through the same chat), and it is exactly
the property a local queue needs (we must not flush while QwenPaw still has a
queued turn of ours).

`hist.busy` is derived from QwenPaw's own `ChatHistory.status == "running"`
(`plugin/channel.py:1087-1092`), so it is a genuine post-reload busy source.

### 1.3 Existing signals inventory (no second busy notion allowed)

| Signal | Where | Meaning | M43 use |
| --- | --- | --- | --- |
| `busyChats` (M42) | `App.tsx:2183`, `4559` | a turn is in flight for this chat | **the** busy source |
| `turn {chat,state}` (v12) | `App.tsx:3894` | turn ended, `done` or `stopped` | flush trigger |
| stream `end` | `App.tsx:3796/3887` | one *segment* ended, not the turn | never a flush trigger |
| `hist.busy` | `App.tsx:3993` | post-reload server busy state | gate the post-reload flush |
| `stoppingChats` | `App.tsx:2185` | stop POST in flight | mode control disabled? (no — queue still valid) |
| M37 outbox | `lib/outbox.ts`, `App.tsx:2546-2693` | "send pressed, socket/agent not reachable" | offline handoff target |
| `canReachAgent` | `App.tsx:2554` | live socket **and** agent present | flush precondition |

M37 facts that constrain the design:

- Outbox entry = **text only** (`outbox.ts:187-213` takes `{chat,text,display,raw}`);
  attachments are already refused offline with a notice (`App.tsx:5368-5374`)
  because a chunked `ref` dies with the plugin's 10-minute TTL
  (`plugin/util.py`, `TRANSFER_TTL_S`).
- Flush trigger: `flushOutbox()` on every `live` transition and on an agent
  `status` push (`App.tsx:4150`, `4495`), plus manual retry (`2690`).
- `sent` entries are never auto-resent; a lost connection turns them into
  `unconfirmed`/`failed` (`outbox.ts:253-261, 324-356`).

The busy queue therefore **must** be a separate store from the outbox (it is a
time-ordered backlog for a *connected* chat), but it must not be able to send
the same sentence twice: a queued item that cannot reach the socket is **moved**
into the outbox (removed from the busy queue in the same state update), never
copied.

### 1.4 Decision gate

(b) shows **serial queue** (no reject/drop) for the console-free channel path
the plugin uses. Immediately sending is therefore safe and loses nothing.

**GATE: PASS → Phase 2 implemented in this session.** "立即发送" is honest as a
*label* but must not promise queue-jumping: the second message is written to
the socket right away and QwenPaw runs it **after** the current turn. The UI
copy will say so in its `title`.

Probe evidence deferred to §2 for the implementation and §5 for tests.

---

## 2. 实现

### 2.1 Pure logic — `spa/src/lib/busyQueue.ts`

The module has no React and no relay dependency: one array in, one array out,
so every ordering and cap rule is testable without a DOM.

```ts
interface BusyQueueEntry { id: string; chat: string; text: string;
                           display: string; raw: string; ts: number }
```

`text` is exactly what goes on the wire (a skill's instruction already
prepended), `display` is what the strip and the eventual bubble show, `raw` is
the composer text that 撤销 puts back, and `id` is local only — it never
crosses the wire.

| Function | Rule |
| --- | --- |
| `enqueueBusy` | appends at the end (array order **is** send order); at a cap returns `refused: "full-chat" \| "full-total"` with the untouched array |
| `removeBusyEntry` | drops one entry by local id (single-item 撤销) |
| `takeBusyHead` | atomically takes the first entry of one chat; nothing remains that could be flushed twice |
| `prependBusy` | puts a refused handoff back at the head of its chat |
| `busyFor` / `busyChatsWithWork` | per-chat view / the chats the reconnect flush iterates |
| `removeBusyChat` | drops a deleted chat's backlog |

Persistence: `webchannel.busyQueue` (JSON array) and `webchannel.busyMode`
(last chosen mode). Both load/save paths swallow storage errors (quota,
disabled storage), so a broken `localStorage` degrades to an in-memory queue
for the session instead of breaking the composer.

Caps: `MAX_BUSY_PER_CHAT = 20`, `MAX_BUSY_TOTAL = 100`. A full queue
**refuses** the new message and leaves the composer text in place; it never
drops an older entry. Entries are text-only (see §4, attachments).

### 2.2 `spa/src/App.tsx` wiring

| Concern | Where |
| --- | --- |
| queue + mode state | `:2206` (`busyQueue`), `:2212` (`busyMode`) |
| helpers | `:2723-2819` — `flushBusy`, `flushBusyAll`, `moveBusyHeadToOutbox`, `cancelBusyEntry` |
| `send()` queue branch | `:5526-5563` — the M37 offline branch stays **first**; the 立即发送 path is byte-identical to pre-M43 |
| flush on turn | `:4053` — both `state:"done"` and `state:"stopped"` |
| flush on `hist.busy:false` | `:4149` |
| flush on presence `status` | `:4302` |
| flush on `live` | `:4650` — after `flushOutbox()` |
| legacy pre-v12 clears | `:3930`, `:4024` |
| chat deletion | `:5281` — `removeBusyChat` |
| persistence | `:3544-3557` |
| queue strip | `:6718` |
| mode control | `:7073-7099` |
| styles | `App.css:4803` onward; 44 px targets under `@media (max-width:720px), (pointer:coarse)` |

`flushBusy(chat)` sends **one** entry per call and returns early while
`busyChats` still contains the chat; the next entry is sent from the `turn`
handler that ends the previous one. That is the whole ordering guarantee: send
one, wait for its `turn`, send the next. `moveBusyHeadToOutbox` calls
`queueMessage` first and only removes the entry when the outbox accepted it —
a full outbox leaves the entry in the busy queue, refused but not dropped.

One UI fact matters for every test and for the UX below: while a turn runs,
M42 swaps 发送 for 停止 (test-owned behaviour, unchanged). The mode control
therefore sits beside 停止, and Enter is the send action that applies the
chosen mode while busy.

---

## 3. UX

The control is a two-option segmented group, 排队 / 立即发送, rendered only
while the **active** chat is busy (`turnBusy`). When the chat is idle there is
no control at all: the ordinary send button already means "send now".

- The last choice is remembered in `webchannel.busyMode` and preselected the
  next time a chat is busy; the fallback is 排队.
- 立即发送 is honest about what happens. Its tooltip is
  「本轮结束后接着处理，不打断当前回答」 — the frame is written immediately,
  QwenPaw processes it after the current turn, and it never interrupts the
  answer being generated. 排队's tooltip is
  「先排在这里，本轮结束后按顺序发送」.
- The queue strip (above the composer, outside the composer card, so it
  survives a chat switch) shows 排队中 N · 本轮结束后依次发送, numbered rows,
  and a per-row 撤销.
- 撤销 restores the entry's **raw** composer text: into the composer when the
  entry belongs to the active chat (prepended, ahead of anything typed since,
  never clobbering it), otherwise into that chat's draft — and only when that
  draft is empty.

Screenshot: `tests/out/m19-shots/m19-mobile-m43-busy.png` — 390×844, busy
chat, two queued items, mode control beside 停止.

---

## 4. 边界与一致性

| 边界 | 行为 |
| --- | --- |
| 每会话隔离 | `busyFor` / `takeBusyHead` / `removeBusyChat` are per-chat; a flush only ever touches the chat it was called for. Cross-chat traffic is covered by e2e. |
| 刷新 | The queue persists in `localStorage` and flushes only once the chat is known idle (`busyChats` cleared **and** `hist.busy` not true) after reconnect — never into a running turn, never dropped. |
| 离线优先 | An offline send still goes to the M37 outbox. If a flush finds the socket unwritable, the head entry is **moved** into the outbox (removed from the busy queue in the same update) — moved, never copied, so there is no double-send. |
| 附件 | Refused in 排队 mode with an explicit notice (a staged ref dies after the plugin's 10-minute TTL); the text stays in the composer. |
| 停止 | The M42 `turn` frame with `state:"stopped"` flushes exactly like `"done"`. |
| 上限 | A full queue refuses with a notice and keeps the composer text. |
| 突发 | Per §1.2: messages sent with 立即发送 during a burst keep the chat busy until the **last** turn's `turn` frame (plugin turn-serial), and two messages already waiting in QwenPaw's queue may be merged into one turn by the backend. The SPA queue exists precisely to keep order and separation when that matters. |

---

## 5. 测试

Coordinator-verified counts:

| Suite | Result |
| --- | --- |
| `busyQueue` vitest | 18/18 |
| spa vitest total | 330/330 |
| M43 focused e2e (`M43_ONLY=1`) | 63/63 |
| full `tests/e2e_m19.mjs` | 681/681 — includes the M37 outbox and M42 stop scenarios, no regressions |
| `tests/e2e_m29.mjs` | 26/26 |
| plugin suites | 22/22 — the plugin is untouched by M43 |

Process note, stated honestly: two M43 CodeBuddy sessions died mid-run on
upstream stream errors (`finish_reason=error`) before writing implementation
code. The milestone was completed via scoped fix-up sessions (lib + tests,
then App wiring, then e2e), and all final verification was re-run by the
coordinator.
