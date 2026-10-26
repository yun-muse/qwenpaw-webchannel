IMPORTANT: You MUST use your file-writing tool to actually create the file, then verify with `ls -la` via your shell tool and paste the real listing. Do not finish with a prose summary; the file on disk is the deliverable.

Workdir: /home/hatch/workspace/qwenpaw-webchannel
Read first: tasks/m1-plugin.md (relay_client.py spec) and plugin/frames.py + plugin/util.py (already on disk — read them so imports match).

THIS CHUNK ONLY — create exactly this 1 file:

plugin/relay_client.py — asyncio WebSocket client, only third-party import is `websockets` (QwenPaw core dep), plus stdlib and the local frames module (try relative import, fall back to plain):
- class RelayClient(relay_url, token, agent_id, on_frame, log=None):
  - async start(): launches background asyncio task running the connection loop.
  - async stop(): cancels cleanly.
  - async send(frame: dict): if check_size fails, log + drop; if connected, ws.send(json); else enqueue into an internal asyncio.Queue(maxsize=1000, drop-oldest on full).
  - connection loop: websockets.connect(relay_url, additional_headers={"Authorization": f"Bearer {token}"}) — check the websockets 15.x API in the ref venv/pyproject (websockets>=15,<16); use the parameter name that version supports (additional_headers is correct for >=14; if unsure use extra_headers fallback via try/except TypeError). On connect, send hello frame {"t":"hello","token":token,"instance":<hostname>,"agent":agent_id} via frames helpers or literal dict.
  - heartbeat: every 25 s send {"t":"ping"} (websockets' built-in ping is also fine but an app-level frame is what the relay echoes as pong — send the app-level frame).
  - inbound: for each message, frames.parse_inbound; dispatch to on_frame(dict) callback (await if coroutine).
  - reconnect: exponential backoff 1s doubling to 30s cap, reset on successful connect; on send-queue, flush queued frames in order after hello.
- Keep it < 200 lines, readable, with a module docstring.

After writing: `python3 -c "import ast; ast.parse(open('/home/hatch/workspace/qwenpaw-webchannel/plugin/relay_client.py').read()); print('parse OK')"` and `ls -la` the file — paste real outputs.
