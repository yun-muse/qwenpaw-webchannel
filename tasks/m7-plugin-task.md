# M7 plugin task — model listing / switching + status push (plugin side)

You are writing product code in this repo (read AGENTS.md first, plus
tasks/m7-brief.md for the full work order). Model: deepseek-v4.1-flash.
All design choices below are FIXED — implement them exactly; do not
redesign. Step 0 is already done by the coordinator; the findings are
quoted below and the source excerpts are in `.ref_tmp/` for reference.

## Step 0 findings (verified from qwenpaw-ref v2.2.2.post1 source)

- List: `GET /api/models` → `[ProviderInfo]` — each entry has `id`,
  `name`, `enabled`, `models[]` and `extra_models[]` (entries with `id`),
  `hidden_model_ids`, `removed_model_ids`, `is_free_tier`, `is_custom`,
  `base_url`, `require_api_key`, and credential material (`api_key`).
  **The raw provider objects must never be forwarded to the client** —
  the plugin projects them to `{provider, model, active}` items only.
- Active: `GET /api/models/active?scope=effective&agent_id=<id>` →
  `{active_llm: {provider_id, model} | null, effective_max_input_length}`.
  `effective` = the agent's own `active_model` when set, else the global
  fallback. This is what the console chat model selector reads.
- Switch: `PUT /api/models/active` with JSON
  `{provider_id, model, scope: "agent", agent_id}` — exactly what the
  console chat ModelSelector sends (`setActiveLlm`). The server validates
  the slot (`_validate_model_slot`: unknown provider 404; model not in
  the provider's `models + extra_models` — `has_model`, removed ids
  excluded — or a bad `availability_status` → 400), writes
  `agent_config.active_model`, then hot-reloads the agent
  (`schedule_agent_reload`, "Hot reload agent (async, non-blocking)").
  **Per-agent runtime switching exists; no app restart is needed.**
  Success returns ActiveModelsInfo with the new `active_llm`.
- Console eligibility (`buildEligibleProviders`, see
  `.ref_tmp/ref_modelSelectorModels.ts`): skip disabled providers;
  visible models = `models + extra_models`; a provider is eligible when
  it is free-tier or `hub-managed`, or it has models AND (custom →
  `base_url` set; `require_api_key` (default true) → `api_key` non-empty;
  no key required → ok). Mirror this in the plugin.
- Agent name: `GET /api/agents/{agentId}` → AgentProfileConfig with a
  human-readable `name`.
- Full router source: `.ref_tmp/ref_providers_router.py` (see
  `list_all_providers`, `get_active_models`, `set_active_model`,
  `_validate_model_slot`).

## 1. protocol/frames.md — additive documentation

- §2.3 (container → browser) add rows:
  - `models` — `items:[{provider, model, active}]` — reply to a `models`
    request; exactly one item has `active:true` when the agent's current
    (effective) model is known.
  - `model_changed` — `provider`, `model` — a `set_model` succeeded;
    this pair is now the agent's active model.
  - `status` — `agent_name`, `provider?`, `model?` — identity push, sent
    when the agent attaches and whenever a client joins/leaves; the
    header displays it.
- §2.4 (browser → container) add rows:
  - `models` — (no fields) — request the agent's switchable model list.
  - `set_model` — `provider`, `model` — switch the agent's active model.
- §6 add an error-code row: `E_MODEL` — model list unavailable, unknown
  provider/model, or the app rejected the switch; the client shows the
  error and the connection is unaffected.
- Add a §9 "Protocol v3 — model listing and switching" in the style of
  §8: wire examples for the four frames, the eligibility mirror rule
  (plugin projects ProviderInfo, credentials never cross the wire), the
  validate-before-switch rule, and this note verbatim in substance:
  `models` / `model_changed` / `status` are **control frames** — they are
  sent **without `seq`**, are not part of any chat's stream, and are not
  ring-buffered or replayed on `resume`.

## 2. plugin/frames.py — builders

Add (and export in `__all__`):

- `models_frame(items)` → `{"t": "models", "items": items}` (items passed
  through as built by the util helper).
- `model_changed_frame(provider, model)` →
  `{"t": "model_changed", "provider": provider, "model": model}`.
- `status_frame(agent_name, provider=None, model=None)` →
  `{"t": "status", "agent_name": agent_name}` plus `provider` / `model`
  keys only when the argument is a non-empty string.

## 3. plugin/util.py — pure helpers

Per AGENTS.md the pure logic lives here (stdlib only):

- `model_items(providers, active_provider="", active_model="")` →
  list of `{"provider", "model", "active"}` dicts:
  - Tolerate garbage: non-list `providers` → `[]`; skip non-dict entries
    and entries without a non-empty string `id`.
  - Skip a provider whose `enabled` is exactly `False`.
  - Model ids: iterate `models` then `extra_models` (each a list of
    dicts with an `id`), keep non-empty string ids, dedupe preserving
    order, and drop ids listed in `removed_model_ids` or
    `hidden_model_ids`.
  - Eligibility (mirror the console): `id == "hub-managed"` → eligible;
    truthy `is_free_tier` → eligible; no model ids → not eligible;
    truthy `is_custom` → eligible iff `base_url` is a non-empty string;
    otherwise let `req = provider.get("require_api_key", True)` — if
    `req` is truthy, eligible iff `api_key` is a non-empty string; if
    `req` is falsy → eligible.
  - Use ONLY the fields above for filtering. Never copy any other field
    (especially `api_key`) into the output.
  - One item per (provider, model): `active` is True iff the pair equals
    `(active_provider, active_model)`. If both active args are non-empty
    and no item came out active, insert
    `{"provider": active_provider, "model": active_model, "active": True}`
    at index 0.
- `active_llm_of(payload)` → `(provider, model)` tuple of strings read
  from an ActiveModelsInfo-shaped dict (`payload["active_llm"]
  ["provider_id" / "model"]`); any off-shape input → `("", "")`.
- `plan_model_switch(items, active_provider, active_model, provider,
  model)` → `(action, detail)`:
  - provider/model not both non-empty strings →
    `("error", "provider and model are required")`
  - `(provider, model)` not among the items' pairs →
    `("error", "unknown model: <provider>/<model>")`
  - equal to `(active_provider, active_model)` → `("noop", "")`
  - otherwise → `("put", "")`

## 4. plugin/channel.py — handlers (minimal, additive diff)

- Import the new builders/helpers in BOTH import blocks (the
  try/except package-relative pattern), exactly like the existing names.
- `__init__`: add `self._agent_name: Optional[str] = None` (display-name
  cache). Do not touch the archiver construction or any existing wiring.
- `_send_control(frame)`: send a control frame via the relay without
  seq/ring: `relay = self._relay`; if None, debug-log and return; else
  `await relay.send(frame)`. Guard with try/except + warning log so a
  control send can never raise into a handler.
- `_api_json(method, path, params=None, json_body=None)` →
  `(status, payload)`: one `httpx.AsyncClient(timeout=10.0)` request to
  `API_BASE + path` with `headers=self._headers()`. Returns
  `(response.status_code, response.json())` (`payload=None` when the
  body is not JSON); on ANY exception logs a warning and returns
  `(0, None)`. Never raises. (New helper for the model handlers only —
  do not refactor the existing handlers to use it.)
- `_fetch_providers()` → the `GET /api/models` list, or None on
  transport failure / non-2xx / non-list payload.
- `_fetch_active()` → `active_llm_of` the
  `GET /api/models/active` payload with
  `params={"scope": "effective", "agent_id": self._agent_id()}`;
  `("", "")` on any failure.
- `_agent_display_name()` → cached name: on cache miss
  `GET /api/agents/{agent_id}`; a non-empty string `name` is cached and
  returned; anything else returns `self._agent_id()` (not cached).
- `_send_status()`: `status_frame(await self._agent_display_name(),
  provider or None, model or None)` via `_send_control`, using
  `_fetch_active()` for the model. Must never raise.
- `_handle_models(frame)`: providers = `await self._fetch_providers()`;
  None → `_send_control(error_frame("E_MODEL", "model list
  unavailable"))`. Else active = `await self._fetch_active()` and reply
  `_send_control(models_frame(model_items(providers, *active)))`.
- `_handle_set_model(frame)`: read `provider` / `model` (strings,
  default ""). providers/active as above (providers None → E_MODEL
  "model list unavailable"). `plan = plan_model_switch(items,
  active_provider, active_model, provider, model)`:
  - "error" → `_send_control(error_frame("E_MODEL", detail))`.
  - "noop" → `_send_control(model_changed_frame(provider, model))`.
  - "put" → `status, payload = await self._api_json("PUT",
    "/api/models/active", json_body={"provider_id": provider,
    "model": model, "scope": "agent", "agent_id": self._agent_id()})`.
    Non-2xx or status 0 → E_MODEL whose detail is the app's `detail`
    string (truncated to 200 chars) when the payload carries one, else
    `f"model switch rejected (HTTP {status})"` (status 0 →
    `"model switch failed: app unreachable"`). Success → `(p2, m2) =
    active_llm_of(payload)`, falling back to `(provider, model)` when
    empty; send `model_changed_frame(p2, m2)`, then
    `await self._send_status()`.
- Dispatch in `_on_relay_frame`: `models` → `_handle_models`,
  `set_model` → `_handle_set_model`, and the relay's own `ready` and
  `peer` frames → `await self._send_status()` (they currently fall into
  the ignore branch; route them explicitly). No other dispatch changes.
- The Turso archiver wiring, file transfer, approvals, hist, stop and
  streaming code paths must remain byte-identical in behaviour.

## 5. plugin/tests/test_m7.py — plain-python asserts, `main()` → ALL PASS

Run with the plugin-runtime venv python (channel.py needs httpx +
qwenpaw). Cover:

- `model_items`: disabled provider skipped; free-tier without key
  included; key-required without key skipped / with key included;
  custom without base_url skipped / with included; `require_api_key`
  False included without key; models+extra merged with dedupe;
  removed/hidden ids excluded; active pair marked exactly once;
  active-not-listed inserted at index 0 as active; garbage tolerated.
  In every case assert no output dict has keys beyond
  provider/model/active.
- `active_llm_of`: normal / null active_llm / garbage.
- `plan_model_switch`: empty → error; unknown → error; same → noop;
  other → put.
- Frame builders: exact shapes; status omits empty provider/model.
- Handlers, driving the real `WebChannel` (`WebChannel(process=None)`,
  `_agent_id` monkeypatched to return `"agent-1"`, `_api_json`
  monkeypatched with a recording fake app, `_relay` replaced by a
  recording fake): dispatch through `_on_relay_frame` and assert on the
  recorded outbound frames —
  - `models` → one `models` frame, expected items, exactly one active.
  - `models` with the fake app failing (status 0) → one error frame
    `code == "E_MODEL"`; then fix the fake and a second `models`
    succeeds (socket/handler alive after the error).
  - `set_model` to another listed model → the fake recorded exactly one
    PUT with body `{provider_id, model, scope: "agent",
    agent_id: "agent-1"}`; a `model_changed` frame carrying the PUT
    response's active pair; a `status` frame after it.
  - `set_model` to the active pair → no PUT recorded, `model_changed`
    still sent.
  - `set_model` to an unknown pair → `E_MODEL`, no PUT.
  - `set_model` where the PUT answers 400 `{"detail": "Model 'x' not
    found in provider 'y'."}` → `E_MODEL` whose detail contains the
    app's detail; no `model_changed`.
  - `{"t": "peer", "clients": 1}` → a `status` frame whose
    `agent_name` comes from the fake `GET /api/agents/agent-1`
    response and whose provider/model match the fake active model.
  - The constructed channel still has its archiver
    (`channel._archiver is not None`) — M6 wiring intact.

## Out of scope

- No plugin.py config changes, no relay changes, no SPA changes (the
  SPA is a separate task), no changes to existing handlers' behaviour.
