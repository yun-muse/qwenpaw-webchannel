You are coding in /home/hatch/workspace/qwenpaw-webchannel. Read docs/design.md sections 4, 5.2, 6, 8, 9 and docs/IMPLEMENTATION_BRIEF.md first.

TASK (M0 relay + protocol only — touch ONLY protocol/ and relay-node/):

1. protocol/frames.md — concise frame protocol spec based on design section 6: envelope, all frame types both directions, handshake sequence, error codes, limits (256KB/frame, 30 frames/s/tenant). Resolve the file-size tension this way: `msg` frames carrying files[] are limited so total frame stays <=256KB; larger files MUST be rejected with E_TOOBIG in v1 (chunked file frames are v2). State this clearly.

2. relay-node/ — a Node.js (>=20) WebSocket relay, local-dev version of the Cloudflare DO relay:
   - package.json with dependency `ws` only (plus no other deps), scripts: start, test.
   - server.js (single file is fine): HTTP server on PORT env (default 8787).
     Routes: GET /ws/agent (requires header Authorization: Bearer <AGENT_TOKEN env, default dev token "dev-agent-token">), GET /ws/client (no auth in local dev, or ?token= anything), GET /health -> {ok:true, agentOnline:bool, clients:n}.
     Behaviour: keep one agent socket + many client sockets; forward frames both ways WITHOUT parsing business payload except: validate it is JSON with a string `t` field and <=256KB, else drop + send {t:"error", code:"E_TOOBIG"|"E_BADFRAME"} to sender. ping frames from either side are answered locally with {t:"pong"} and NOT forwarded. When agent is offline, buffer client->agent frames (max 500 frames / 1MB total, drop oldest) and flush in order when agent reconnects. When agent connects send it {t:"peer", clients:n} on client join/leave changes ({t:"peer-online"}/{t:"peer-offline"} minimal: send {t:"peer", clients:n}). Announce to a newly connected client {t:"ready", agentOnline:bool}.
   - test/smoke.mjs — automated smoke test using ws: starts server on port 18787, connects a fake agent + a fake client, client sends {t:"msg",chat:"c1",text:"hi"}, assert agent receives it; agent sends 20 {t:"evt",chat:"c1",seq:i,data:"x"} frames, assert client receives all 20 in order; print PASS/FAIL and exit code accordingly.
   - README.md in relay-node/ with run instructions.

Keep the code small and readable (~250 lines server max). After writing files, run `npm install` and `npm test` inside relay-node/ and fix failures until the smoke test passes. Report exactly which files you created and the test result.
