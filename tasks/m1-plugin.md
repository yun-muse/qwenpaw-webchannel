You are coding in /home/hatch/workspace/qwenpaw-webchannel. This is M1: the real QwenPaw WebChannel plugin (Python).

READ FIRST (in this order):
1. docs/design.md sections 5.1, 6, 8, 9 and docs/IMPLEMENTATION_BRIEF.md
2. docs/source-notes.md — decisive findings: on_streaming_delta receives CUMULATIVE text (you MUST diff); agent_id is per-workspace binding, NOT routing; localhost API calls need X-Agent-Id header.
3. Reference source at /home/hatch/workspace/qwenpaw-ref (QwenPaw v2.2.2.post1, do NOT modify it):
   - src/qwenpaw/app/channels/base.py — BaseChannel (class at line 83; from_config ~1261; resolve_session_id ~1271; on_streaming_start/delta/end ~1729-1776; send ~2264; send_approval_notification ~2312). Match its REAL signatures exactly.
   - src/qwenpaw/app/channels/console/channel.py — reference channel implementation.
   - src/qwenpaw/plugins/api.py register_channel (~689) and one example channel plugin under plugins/channel/azure_bot/ — match the plugin packaging/registration pattern they use.
   - src/qwenpaw/app/channels/registry.py — channel keys.

TASK — create the plugin under plugin/ ONLY (do not touch other dirs):
- plugin/plugin.json: id "webchannel", type "channel", entry backend "plugin.py", dependencies [], qwenpaw_version min 2.2.0 max 2.3.0.
- plugin/plugin.py: registers the channel via register_channel with config fields relay_url (string, default "ws://127.0.0.1:8787/ws/agent") and token (string, default "dev-agent-token"), following the azure_bot example's pattern.
- plugin/frames.py: frame builders/parsers matching protocol/frames.md exactly (envelope {t,...}, 256KB limit check helper).
- plugin/relay_client.py: asyncio WebSocket client using `websockets` (already a QwenPaw core dep; no new deps): connect with Authorization Bearer token, send hello{token, instance, agent}, heartbeat ping every 25s, exponential backoff reconnect (1s -> 30s cap), send queue, callback for inbound frames.
- plugin/channel.py: class WebChannel(BaseChannel) with channel="web", uses_manager_queue=True, streaming_enabled=True, _STREAM_DELTA_MIN_INTERVAL_S=0.0:
  * from_config classmethod matching BaseChannel's real signature; read config via getattr (SimpleNamespace).
  * resolve_session_id -> f"web:{sender_id}:{chat_id or 'default'}".
  * Inbound: on relay msg frame -> build the native payload exactly the way base/console channels expect and call self._enqueue(native) (verify the real method name/shape from base.py; adapt to what actually exists). stop frame -> use the real stop mechanism if one exists, else log.
  * Outbound hooks: on_streaming_start -> {t:"start"}; on_streaming_delta -> DIFF cumulative accumulated_text against stored prev per (chat, stream_type) and send {t:"evt", chat, seq, data:{text:<only the new chunk>}} (send nothing if chunk empty); on_streaming_end -> {t:"end"} and clear prev. send()/send_content_parts (match real base signatures) -> {t:"msg", chat, seq, parts:[...]} serialising content parts to plain dicts defensively (getattr-based). send_approval_notification -> {t:"approval", chat, req_id, ...} using fields that actually exist on the object (inspect base.py).
  * seq: per-chat monotonic counter; ring buffer deque(maxlen=400) of (seq, frame) per chat; inbound {t:"resume", chat, last_seq} -> resend buffered frames with seq>last_seq, or {t:"resync", chat} if last_seq is older than the buffer.
  * approve/deny inbound frames -> POST to http://127.0.0.1:8088/api/approval/approve|deny with header X-Agent-Id set to the bound workspace agent_id (get it the way base.py does: getattr(self._workspace, "agent_id", "default") — verify attribute name in source). Use httpx or aiohttp ONLY if already a core dep (check pyproject.toml in the ref); otherwise use urllib in a thread executor. State which you used and why.
  * Lifecycle: start the relay client when the channel starts (find the real start/stop hook names in BaseChannel, e.g. start/stop methods) and stop it cleanly.
- plugin/tests/test_diff.py: pure-python unit tests (no QwenPaw imports — factor the diff/seq/ring-buffer logic into a small importable helper inside frames.py or a util module so it is testable standalone): cumulative->delta diffing incl. coalesced jumps and segment reset; seq monotonicity; ring buffer resume hit + miss. Run them with python3 -m pytest or plain python and make them pass.
- plugin/README.md: install instructions (local dir + ZIP hot-install from design 12.1), config fields, how the diffing works.

Keep it compact (channel.py target < 400 lines). If a base.py signature contradicts docs/design.md, FOLLOW THE SOURCE and note the deviation in plugin/README.md. Report: files created, test results, every deviation from the design doc you had to make, and which HTTP library you used for approval calls.
