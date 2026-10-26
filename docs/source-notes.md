# Source notes — QwenPaw v2.2.2.post1 reference

Reference clone: `~/workspace/qwenpaw-ref`, HEAD
`b6715daabaa4f966626317452980fb84b8be9ab9` (tag `v2.2.2.post1`), verified
2026-10-26. All line refs below are from that checkout.

## Q1. Is `on_streaming_delta` incremental or cumulative?

**Answer: both layers exist, and they differ — this is the trap.**

- The raw agent **event** is incremental. In
  `src/qwenpaw/app/channels/base.py` `_on_stream_content_delta()`:

  ```python
  delta_text = getattr(event, "text", "") or ""
  streaming_buffers[stream_type] = (
      streaming_buffers.get(stream_type, "") + delta_text
  )
  ```

  i.e. `event.text` is only the new chunk (`event.delta` must be true for
  the path to run at all), and BaseChannel appends it to a per-stream-type
  buffer itself.

- The **`on_streaming_delta` hook receives CUMULATIVE text**, not the chunk.
  The same function then flushes the whole buffer:

  ```python
  display_text = strip_headline(streaming_buffers[stream_type]) or ""
  flush_meta["task"] = asyncio.create_task(
      self._safe_streaming_delta(
          request, to_handle, event, send_meta, stream_type, display_text,
      ),
  )
  ```

  and `_safe_streaming_delta(..., accumulated_text)` forwards that value as
  the `accumulated_text` parameter of `on_streaming_delta`. The hook's own
  docstring (base.py, `on_streaming_delta`) confirms it:

  > Called for each incremental text chunk.
  > ``accumulated_text`` contains all text received so far
  > for this *stream_type*, including the current delta.
  > Useful for channels that overwrite the message bubble
  > with full text on each update (e.g. WeCom).

**Consequence for the WebChannel plugin (M1):**

- If the plugin forwards `accumulated_text` verbatim in an `evt` frame, the
  SPA must **replace** the bubble text, not append.
- If the protocol wants true per-delta frames (design goal: 逐 delta), the
  plugin must diff itself: keep `prev_len` per (chat, stream_type) and send
  `accumulated_text[prev_len:]`. That is cheap and exact because the buffer
  is append-only within a streaming segment (a new segment / content-index
  change resets the buffer via `on_streaming_start` with
  `accumulated_text=""`).
- Throttling note: `_STREAM_DELTA_MIN_INTERVAL_S = 0.0` by default in
  BaseChannel, but the in-flight guard in `_on_stream_content_delta` can
  coalesce: if a previous `_safe_streaming_delta` task is still running,
  the next flush is skipped (`return True`) and the following flush carries
  the fuller cumulative text. With cumulative semantics nothing is lost;
  with naive append-semantics that coalescing would corrupt text — another
  reason the plugin must diff from cumulative, not append event chunks.
- `console/channel.py` does **not** override `on_streaming_delta` at all;
  it consumes `self._process(request)` events directly. It is therefore not
  evidence for hook semantics — base.py is the decisive source.

## Q2. How is `agent_id` carried? Can frames include `agent_id`?

**Answer: a channel instance is bound to exactly one agent (workspace);
there is no `agent_id` field in the channel request path. Multi-agent is
selected at the HTTP layer, not inside a channel message.**

Evidence:

1. Channel → agent binding is per-workspace. `BaseChannel` stores
   `self._workspace`, and code that needs the agent reads it from there
   (base.py, turn-usage path):

   ```python
   agent_id = (
       getattr(workspace, "agent_id", "default")
       if workspace is not None
       else "default"
   )
   ```

   `app/channels/manager.py` likewise does
   `agent_id = self._workspace.agent_id` and then
   `load_agent_config(agent_id)` to find that agent's channel configs —
   one ChannelManager serves one workspace.

2. The request a channel builds carries **no** agent id.
   `build_agent_request_from_user_content()` in base.py returns:

   ```python
   return AgentRequest(
       session_id=session_id,
       user_id=sender_id,
       input=[msg],
       channel=channel_id,
   )
   ```

   `console/channel.py: build_agent_request_from_native()` only adds
   `request.channel_meta = meta` and, if present,
   `meta["request_context"]` → `request.request_context`. Nothing in the
   native-payload path interprets an `agent_id` key in meta.

3. HTTP-layer multi-agent selection (`X-Agent-Id`) lives outside channels,
   in `app/agent_context.py: get_agent_for_request()`, priority:
   explicit `agent_id` argument → `request.state.agent_id` (agent-scoped
   router) → `X-Agent-Id` header → `config.agents.active_agent or "default"`.
   The same header is used by `app/routers/messages.py` and the CLI tools.

**Consequence for the WebChannel protocol / plugin:**

- Frames **may** include `agent_id` as an informational/routing field —
  nothing will break — but the QwenPaw channel layer will **not** route by
  it. A frame arriving at an instance bound to agent `default` cannot be
  redirected to agent `work` by putting `agent_id: "work"` in it.
- Real multi-agent support = **one plugin instance per agent workspace**
  (the normal QwenPaw model: each agent's own config enables the channel),
  each instance dialling the relay with its own identity
  (`hello{instance, agent}` — `agent` = its bound `workspace.agent_id`).
  The relay/SPA then routes by *which agent connection* a frame came from,
  and the SPA agent-switcher (design §13.6) selects among connected agents.
- Where `agent_id` *does* matter inside the plugin is its localhost HTTP
  calls (design §5.1): history/approval endpoints are HTTP APIs, so the
  plugin must send `X-Agent-Id: <its bound agent_id>` there, per
  `agent_context.py` above. If it omits the header it silently gets the
  config's active agent, which may not be the agent the channel belongs to.

## Q3. Frame-size rule (brief §3, decided for v1)

`msg` frames carrying `files[]` (base64) must keep the **total frame**
≤ 256 KB. Anything larger is rejected with `E_TOOBIG` in v1; chunked
`file` frames are deferred to v2. This is stated in `protocol/frames.md`
(produced in M0 chunk 1) and enforced by relay-node (drop + error frame to
sender for oversize frames).
