# M7 SPA task — header identity, model picker, `/` palette, UI polish

You are writing product code in this repo (read AGENTS.md first, plus
tasks/m7-brief.md for the full work order and protocol/frames.md §9 for
the model-control wire format). Model: deepseek-v4.1-flash. All design
choices below are FIXED — implement them exactly; do not redesign.
Files in scope: `spa/src/App.tsx`, `spa/src/App.css`, and (only if a
type must grow) `spa/src/relay.ts`. No relay.ts behaviour changes.

## Protocol facts (from plugin §9, already implemented)

- C→A `{t:"models"}` → A→C `{t:"models", items:[{provider, model,
  active}]}` — control frame, no `chat`, no `seq`. Exactly one item has
  `active:true` when the current model is known.
- C→A `{t:"set_model", provider, model}` → success A→C
  `{t:"model_changed", provider, model}`; failure A→C the standard error
  frame with `code:"E_MODEL"` (and a `detail` string).
- A→C `{t:"status", agent_name, provider?, model?}` — pushed when the
  agent attaches and on client join/leave; `provider`/`model` may be
  absent when unknown. Also arrives right after a successful switch.

## 1. Header identity + model picker

- New state: `agentName` (string, default ''), `modelItems`
  (`{provider, model, active}[]`, default []), `currentModel`
  (`{provider, model} | null`), `modelBusy` (bool), `pickerOpen`
  (bool).
- Frame handling in `onFrame`:
  - `status`: set `agentName` from `frame.agent_name` when a non-empty
    string; when `frame.provider` and `frame.model` are non-empty
    strings, set `currentModel` to that pair.
  - `models`: replace `modelItems`; set `currentModel` to the item
    with `active === true` (or null when none); close nothing.
  - `model_changed`: set `currentModel` to the frame's pair; mark the
    matching item active in `modelItems` (all others inactive); set
    `modelBusy` false; close the picker.
  - `error` with `code === "E_MODEL"`: set `modelBusy` false and show
    the existing toast with the code/detail (the generic error path
    already toasts — make sure E_MODEL also clears `modelBusy` and
    does not close the picker).
- On reaching `live` (the existing `onState` path, next to
  `maybeRequestHist`), also send `{t:"models"}` once per connection —
  guard with a ref so reconnects re-request but state changes within
  one connection do not spam it.
- Header (`.top`): left shows the chat title as today; add an identity
  block: agent name (or `agent` placeholder while unknown) and a model
  button labelled `<provider> / <model>` (or `model —` while unknown).
  Clicking the model button toggles the picker and, if `modelItems` is
  empty, sends `{t:"models"}`.
- Picker UI: an anchored dropdown under the header listing
  `modelItems` grouped in frame order (no regrouping needed — render
  sequentially, provider shown per row), each row
  `model` + small `provider`, the active row marked (e.g. `●` /
  `aria-current`), rows disabled while `modelBusy`. Clicking a
  non-active row sends `{t:"set_model", provider, model}`, sets
  `modelBusy` true, and keeps the picker open until `model_changed`
  (close) or `E_MODEL` (stay open, toast shows). Clicking the active
  row just closes. Esc / click-outside closes. An empty list shows
  `No models available`.

## 2. `/` command palette

- Commands (id, label, hint):
  - `/new` 新建会话 — run the existing `newChat()`.
  - `/stop` 停止生成 — run the existing `stop()` (harmless when idle).
  - `/model` 切换模型 — open the model picker (same as clicking the
    header model button); clear the composer.
  - `/rename` 重命名当前会话 — start the sidebar inline rename for the
    active chat (see §3); clear the composer.
  - `/delete` 删除当前会话 — run the sidebar delete for the active
    chat (§3).
  - `/clear` 清空当前会话显示（仅本地） — clear the active chat's
    local message list only (`updateChat(chat, () => [])`); label in
    the palette must say it is local-only.
  - `/theme` 切换深浅色 — toggle the theme (§4).
  - `/help` 帮助 — open the help dialog (§3).
- Behaviour: when the composer value starts with `/` (and contains no
  space yet), show the palette above the composer: commands filtered
  by the typed prefix (match on the command name without the slash,
  case-insensitive). ArrowUp/ArrowDown move the highlight (wrap),
  Enter runs the highlighted command INSTEAD of sending, Esc closes
  (and suppresses until the text changes), mouse click runs. Running
  a command clears the composer (except where the command itself
  needs it — none do). When the palette is closed or the text no
  longer starts with `/`, Enter keeps its current send behaviour.
  The palette never appears for multi-line input (any `\n` in value).
- Implement inside the existing composer/textarea wiring
  (`onKeyDown` already handles Enter) with a `paletteIndex` state and
  a derived `paletteItems` list. Keep the Chinese labels above.

## 3. Sidebar + dialogs polish

- Chat names: new persisted map `webchannel.chatNames`
  (Record<chatId, string>) in localStorage, loaded like the other
  persisted state and saved on change. `titleOf(id)` returns the
  custom name when present, else today's derived title.
- Rename: each sidebar chat item gets a rename affordance (a small
  `✎` button and double-click on the title both start it): the title
  becomes an inline text input prefilled with the current title;
  Enter/blur commits (trim; empty → remove the custom name), Esc
  cancels. `/rename` starts it for the active chat (the item must
  exist — it does).
- Delete: each item gets a `×` button; deleting asks for confirmation
  via the native `confirm()` (keep it simple) with the chat title.
  Deleting removes the id from `chatIds`, its messages and its custom
  name; deleting the active chat selects the first remaining chat, or
  creates a fresh one when none remain (reuse the existing helpers so
  persistence and the relay's active-chat tracking stay consistent).
- Search: a filter input at the top of the sidebar filters the visible
  chat items by title (custom or derived) substring, case-insensitive.
  Filtering never mutates `chatIds`.
- Help dialog: a `<div className="help-dialog">` modal (fixed overlay,
  close button + Esc + overlay click) listing the `/` commands with
  their labels and the shortcuts (Enter 发送 · Shift+Enter 换行 ·
  `/` 命令面板 · Esc 关闭面板/对话框). Opened by `/help` and by a
  small `?` button in the sidebar footer.
- Message polish:
  - `ChatMessage` gains `ts?: number` (ms epoch). Set it when a
    message object is created locally: user sends, new assistant
    bubbles, approvals, history appends (history rows have no server
    timestamp — leave `ts` undefined there).
  - Render a small timestamp (`HH:MM`, local time) in the bubble
    footer area when `ts` is present.
  - Copy button on every message bubble (copies `message.text`;
    for parts messages copies the text part content): a small
    `Copy`/`Copied` button using `navigator.clipboard.writeText`
    with a textarea fallback; failure is silent (or a toast).
  - Code blocks: after markdown render, code blocks are the existing
    `<pre>` elements — add a delegated copy: render markdown as today,
    and in `MessageView` wrap rendered markdown in a container whose
    `<pre>` blocks get a hover `Copy` button. Implement with a small
    React component that, on click of a button positioned over the
    block, copies the block's `innerText`. Simplest robust route: in
    the markdown container's onClick, if the click target is inside
    a `pre`, copy that pre's text and flash the button state. If that
    proves fiddly, a per-message "copy" of the raw text (already
    required above) is the floor — but do implement the pre-level
    button via event delegation as described.
- Scroll-to-bottom: track whether the message list is scrolled near
  the bottom (onScroll on `.messages`, threshold ~80px). The existing
  auto-scroll effect only auto-scrolls when already near the bottom
  (change it so a user reading history is not yanked down; new own
  messages still scroll). When scrolled up, show a floating `↓`
  button over the list that smooth-scrolls to the bottom.

## 4. Theme + responsive

- Theme state: `'light' | 'dark'`, persisted at `webchannel.theme`.
  Default: stored value, else `prefers-color-scheme` media query.
  Apply via `document.documentElement.dataset.theme` in an effect.
  CSS: `:root` keeps today's light variables and `color-scheme:
  light`; add `:root[data-theme="dark"]` overriding the same variables
  with a coherent dark palette and `color-scheme: dark`. `/theme`
  and a small toggle button in the header (☾/☀) both flip it.
- Responsive: below 720px the sidebar becomes an overlay drawer:
  hidden by default (translated off-canvas), a hamburger button in
  the header toggles it; selecting a chat closes it. Desktop layout
  (≥720px) must be visually unchanged. Implement with a
  `sidebarOpen` state + CSS media query; the `.app` gets a class when
  open.

## Out of scope / must not break

- No changes to: login gate, chunked upload flow, approval cards,
  streaming/render pipeline, hist/resume logic, message size rules or
  their Chinese error strings.
- The build (`npm run build`, which runs `tsc --noEmit`) must pass
  with no type errors.
