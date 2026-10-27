# M7 brief — 实用档：命令面板、模型切换、界面打磨

Engine: CodeBuddy CLI pinned `--model deepseek-v4.1-flash` (fallback
glm-5.3-flash). Repo AGENTS.md applies. Runs AFTER M6 lands (both touch
plugin/channel.py — no parallel edits).

## Step 0 — feasibility from source (do this first, report in the report)

In ~/workspace/qwenpaw-ref (v2.2.2.post1), find the REST endpoints the
console itself uses to (a) list the models an agent can use (providers +
their models + which is active for this agent) and (b) switch the agent's
active model. Confirm from source whether switching is per-agent and
takes effect without an app restart. If (b) does not exist per-agent,
STOP that part and say exactly what exists (global default switch? config
file edit?) — never fake a switch in the UI.

## Protocol additions (protocol/frames.md, additive)

- C→A `{t:"models"}` → A→C `{t:"models", items:[{provider, model,
  active}]}` (active=true on exactly the agent's current model).
- C→A `{t:"set_model", provider, model}` → on success A→C
  `{t:"model_changed", provider, model}`; on failure the standard error
  frame (`code:"E_MODEL"`), plugin must not crash or drop the socket.
- The agent→client `ready`/status flow should carry `agent_name` and the
  current `model` when cheap to add (SPA header displays them).

## Plugin

- Handlers for `models` / `set_model` calling the app endpoints found in
  Step 0 with the usual `X-Agent-Id` header and localhost base, same
  httpx patterns as the existing handlers.
- Validate provider+model against the listed set before switching;
  unknown → E_MODEL.

## SPA

- Header: agent name + current model; clicking the model opens the model
  picker (list from the `models` frame, active marked); picking one sends
  `set_model`, header updates on `model_changed`, error surfaces as a
  toast/inline error.
- `/` command palette: when the composer input starts with `/`, show a
  candidate list (arrow keys + Enter, Esc closes, click works):
  /new 新建会话, /stop 停止生成, /model 模型选择, /rename 重命名当前
  会话, /delete 删除当前会话, /clear 清空当前会话显示 (local only —
  label it as such), /theme 深浅色切换, /help 帮助 (command list +
  shortcuts dialog).
- Sidebar polish: rename (inline edit), delete, search filter; renames
  persist in localStorage alongside the existing chat persistence.
- Message polish: copy button on messages, copy button on code blocks,
  timestamps, a scroll-to-bottom floating button when scrolled up.
- Dark mode: follow system by default, manual toggle, persisted.
- Narrow screens: sidebar collapsible; do not break the desktop layout.

## Tests (coordinator-run)

- Plugin unit tests (plain python, ALL PASS): models/set_model handlers
  against a fake app transport (list shape, active flag, switch success,
  unknown model → E_MODEL, app error → E_MODEL, socket alive after).
- Local e2e: models frame returns ≥1 item with one active; set_model to
  another listed model; verify via a fresh models frame (and, where the
  API allows, the app-side config) that the active model changed; switch
  back; a normal chat round-trip still works after switching.
- SPA build passes; bundle contains the palette commands and the
  models/set_model strings.
- Regressions: plugin test suite + e2e_m2 still pass.

## Ship

- Rebuild plugin ZIP, rebuild SPA with production env, redeploy SPA to
  Pages (connector wrangler route, --branch main). Relay unchanged.
- docs/m7-report.md (Step 0 findings verbatim, what was built, test
  evidence, deviations), git commit
  "M7: command palette, model switching, UI polish".
- Hosted plugin install + restart is the parent's job afterwards.
