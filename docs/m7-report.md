# M7 report — `/` command palette, model switching, SPA polish （实用档）

Executed 2026-10-27. All product code written by CodeBuddy
(`deepseek-v4.1-flash`) in two sessions (plugin, then SPA) from fixed
specs (`tasks/m7-plugin-task.md`, `tasks/m7-spa-task.md`); the
coordinator verified every diff line-by-line and ran all tests,
builds, the local e2e and the production SPA deploy itself.

## Step 0 findings — the app's model APIs, pinned from source

Source: `~/workspace/qwenpaw-ref` (v2.2.2.post1),
`src/qwenpaw/app/routers/providers.py` — router prefix `/models`,
mounted under `/api`:

- **List**: `GET /api/models` → `List[ProviderInfo]`. ProviderInfo
  (`src/qwenpaw/providers/provider.py` ~line 130): `{id, name, enabled,
  model_count, models: ModelInfo[], extra_models: ModelInfo[],
  discovered_models, hidden_model_ids, removed_model_ids, ...}`.
  **ProviderInfo includes api_key material — the plugin projects it to
  `{provider, model, active}` only and never forwards raw provider
  objects.**
- **Active**: `GET /api/models/active?scope=effective&agent_id=<id>` →
  `ActiveModelsInfo {active_llm: ModelSlotConfig{provider_id, model} |
  null, effective_max_input_length}` (config.py ~line 200). Scopes:
  `effective` = the agent's own `active_model` first, else the global
  fallback; `agent` = the agent's configured only (agent_id required,
  400 without); `global` = ProviderManager global only.
  `_load_agent_model` reads `agent_config.active_model`.
- **Switch**: `PUT /api/models/active`, body `ModelSlotRequest
  {provider_id, model, scope (REQUIRED), agent_id?}`. The console chat
  ModelSelector sends exactly `{provider_id, model, scope:"agent",
  agent_id}` (console/src/api/modules/provider.ts `setActiveLlm`;
  console/src/pages/Chat/ModelSelector/index.tsx `activateModel`).
  Server for scope="agent": `_validate_model_slot` first (404 unknown
  provider; 400 when the model fails `provider.has_model`, or
  `availability_status` ∈ {permission_denied, model_not_found,
  incompatible_api}), then `update_agent_config_async` writes
  `agent_config.active_model = ModelSlotConfig(...)`, then
  **`schedule_agent_reload(request, workspace.agent_id)`** — source
  comment: "Hot reload agent (async, non-blocking)". **Conclusion:
  per-agent runtime model switching EXISTS and takes effect without an
  app restart.** Response: ActiveModelsInfo with the new active_llm.
  scope="global" instead calls `manager.activate_model` — the plugin
  always uses scope="agent" with its own agent_id.
- **Eligibility (mirror the console)**: `buildEligibleProviders`
  (console/src/pages/Chat/ModelSelector/modelSelectorModels.ts): drop
  `enabled === false`; visible models = `models + extra_models`;
  provider eligible if `is_free_tier`, or id "hub-managed", or (has
  models AND (is_custom → base_url non-empty; require_api_key (default
  true) → api key present; require_api_key false → ok)).
  `provider.has_model` (provider.py line 1210) checks extra_models +
  models only, excluding removed_model_ids — consistent with the
  console list composition.
- **Agent name**: `GET /api/agents/{agentId}` → AgentProfileConfig
  `{id, name ("Human-readable agent name"), ...}` (routers/agents.py
  line 613).
- Console selector data flow (modelSelectorApi.ts): listProviders() +
  getActiveModels({scope:"effective", agent_id}) in parallel.

## What was built

**Protocol** (`protocol/frames.md`, additive): `models` / `set_model`
rows in §2.4/§2.3, the `status` frame row in §2.3, error code
`E_MODEL` in §6, and a new §9 "Protocol v3 — model listing and
switching". `models` / `model_changed` / `status` are control frames:
sent **without `seq`**, never ring-buffered or replayed.

**Plugin**:
- `util.model_items(providers, active_provider, active_model)` — pure
  projection + console-eligibility mirror (disabled skipped;
  hub-managed / free-tier always eligible; custom needs `base_url`;
  key-required needs a key; models+extra merged and deduped;
  removed **and hidden** ids excluded — see Deviations). If the
  effective active pair is not in the list it is inserted at index 0
  with `active:true`, so exactly one item is active whenever the
  current model is known. Only `{provider, model, active}` ever
  leaves the plugin. Plus `active_llm_of` and `plan_model_switch`
  (error / noop / put) as pure helpers.
- `frames.py`: `models_frame`, `model_changed_frame`, `status_frame`
  (provider/model keys omitted when unknown).
- `channel.py` (purely additive diff; archiver wiring untouched):
  `_handle_models` / `_handle_set_model` dispatched from
  `_on_relay_frame`; one `_api_json` helper (10 s timeout, never
  raises; status 0 = transport failure). `set_model` validates the
  pair against the freshly built list **before** any PUT (unknown →
  `E_MODEL`, no app call); same-as-active is a no-op that still
  answers `model_changed`; otherwise
  `PUT /api/models/active {provider_id, model, scope:"agent",
  agent_id}` — app rejection surfaces as `E_MODEL` carrying the app's
  `detail` (≤200 chars); success answers `model_changed` with the
  response's active pair, then a fresh `status`. The relay's `ready`
  and `peer` frames (previously ignored) now trigger `_send_status()`:
  `{t:"status", agent_name, provider?, model?}` with the name from
  `GET /api/agents/{id}` (cached; fallback = agent id).
- `plugin/tests/test_m7.py`: 32 tests — helper edge cases (incl. a
  "no field beyond provider/model/active ever leaks" assertion) and
  handler tests driving the real `WebChannel` against a fake app
  transport (exact PUT body asserted; unknown → E_MODEL and no PUT;
  app 400 → E_MODEL with the app's detail; failing app → E_MODEL and
  the handler stays alive; peer/ready → status push; archiver still
  constructed).

**SPA** (`spa/src/App.tsx`, `App.css`; relay.ts untouched):
- Header shows the agent name (from `status`) and the current model;
  the model label is a button opening a picker fed by the `models`
  reply (requested once per connection on `live`, and on picker open
  when empty). Picking a row sends `set_model`; `model_changed`
  updates the header and closes the picker; `E_MODEL` toasts and keeps
  the picker open with the busy state cleared.
- `/` palette: opens when the composer starts with `/` (no whitespace
  yet), prefix-filters, ArrowUp/Down + Enter + Esc + click. Commands:
  `/new` 新建会话， `/stop` 停止生成， `/model` 切换模型， `/rename`
  重命名当前会话， `/delete` 删除当前会话， `/clear` 清空当前会话显示
  （仅本地）, `/theme` 切换深浅色， `/help` 帮助.
- Sidebar: custom chat names persisted at `webchannel.chatNames`
  (title prefers the custom name), inline rename (button / double
  click / `/rename`), per-item delete (native confirm; deleting the
  active chat selects the next or creates a fresh one — local list
  only, no server delete exists), search filter over titles. Help
  dialog from `/help` and a `?` button.
- Messages: `ts` on locally created messages, rendered as `HH:MM`
  when present (history rows have no server timestamp and show
  none); per-message copy button; code-block copy via click
  delegation on `<pre>`; scroll-to-bottom floating button — the
  auto-scroll effect now only follows the tail when already near the
  bottom (or on chat switch / own send).
- Dark mode: theme persisted at `webchannel.theme`, default from
  `prefers-color-scheme`, applied as `data-theme` on `<html>`; CSS
  variables overridden under `:root[data-theme='dark']`. Below
  720 px the sidebar is an off-canvas drawer (hamburger in the
  header); desktop layout unchanged.

## Test evidence (coordinator re-runs)

- Plugin unit suite (venv python): test_diff, test_m2, test_m5,
  test_turso, **test_m7 — all ALL PASS**; `py_compile` clean.
- `tests/e2e_m7.mjs` against the local stack (relay-node :8787 +
  local QwenPaw :8088, updated plugin installed into the LOCAL
  instance only): **E2E_M7 PASS**, 10/10 assertions — status carries
  `agent_name:"Default"` + `kilo/kilo-auto/free`; models returns the
  2 local Kilo models with exactly one active and the exact
  `{provider, model, active}` shape; a **real switch** to
  `kilo/openrouter/free` → `model_changed`, list shows it active, and
  the app's own `GET /api/models/active?scope=agent` agrees;
  switch back → `model_changed`; bogus pair → `E_MODEL`
  ("unknown model: no-such-provider/no-such-model"); a normal chat
  round-trip completes afterwards (reply "ok").
- Regression: `tests/e2e_m2.mjs` → **E2E_M2 PASS** (mandatory
  assertions: trailing msg, hist round-trip, file attach, mid-stream
  resume, bogus approve → E_AUTH).
- SPA build: `npm run build` (tsc --noEmit + vite) clean — JS
  245.99 kB / gzip 81.18 kB.
- Plugin ZIP rebuilt: `dist/webchannel.zip` 38,392 bytes, same
  8-file allowlist (no new modules).
- Production SPA deployed via the Cloudflare connector (wrangler,
  `--branch main`): production root 200; served asset
  `assets/index-0ZgMnyc5.js` (246,584 bytes) contains the production
  `wss://…/ws/client` URL, `set_model`, and the palette strings.

## Deviations and notes

- `model_items` also excludes `hidden_model_ids` (the console's
  picker composition doesn't, but a model the user hid in the console
  should not reappear here; if the hidden model is the active one,
  the insert-at-front rule still surfaces it as the active item).
- **Reload bounce**: a successful switch makes the app hot-reload
  the agent (`schedule_agent_reload`), which bounces the plugin's
  relay socket for a few seconds. Client→agent frames sent in that
  window are dropped by the relay (client frames are not buffered);
  the agent re-attaches and pushes a fresh `status`. The e2e harness
  re-sends `models` / the bogus probe until answered, and records
  this as expected behaviour, not a failure. The SPA re-requests
  `models` on every reconnect, so it self-heals.
- Local test-stack env (not a product issue): the local app must be
  started with BOTH `NO_PROXY` and `no_proxy` set to
  `localhost,127.0.0.1` — the VM's default lowercase `no_proxy`
  contains IPv6 entries that crash httpx's proxy parsing
  (`InvalidURL: Invalid port: ':1]'`) and silently kill every
  plugin→app call. The first local start this run reproduced it
  (`E_MODEL "model list unavailable"`); restarting with both cases
  set fixed it.
- The local default agent's `active_model` is now set
  (`kilo/openrouter/free`, the e2e's switch-back target) where it
  was previously null/global — local fixture only.
- AGENTS.md gained one convention line (control frames go through
  `_send_control`, never `_emit`; raw ProviderInfo never crosses the
  wire).

## Remaining

- Hosted side: install `dist/webchannel.zip` on the hosted `work`
  agent and Restart the instance (per the M5 lesson) — the parent
  agent's step. The hosted agent has more providers configured than
  the local one, so its picker will list more than the 2 local Kilo
  models. Nothing else is outstanding for M7.
