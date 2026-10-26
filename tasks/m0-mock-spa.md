You are coding in /home/hatch/workspace/qwenpaw-webchannel. Read docs/design.md sections 5.3, 6 and protocol/frames.md first. The relay in relay-node/ already exists and its smoke test passes — do not modify relay-node/ or protocol/.

TASK (M0 mock agent + SPA skeleton — touch ONLY mock/ and spa/):

1. mock/mock_agent.mjs — Node script (use the `ws` package, add mock/package.json):
   Connects to relay as agent: ws://127.0.0.1:8787/ws/agent with Authorization Bearer dev-agent-token.
   On receiving {t:"msg", chat, text}: stream a reply for that chat — send {t:"start", chat, seq} then one {t:"evt", chat, seq, data} PER CHARACTER (or per 1-3 chars) of a canned reply text (include the received text echoed, ~120 chars, markdown sample with **bold** and a code word), ~30ms apart, seq monotonically increasing per chat, then {t:"end", chat, seq} and a final {t:"msg", chat, seq, parts:[{type:"text", text:<full reply>}]}. Also handle {t:"stop"} by cancelling the in-flight stream for that chat. Log frames sent.
   Run instruction in mock/README.md.

2. spa/ — minimal Vite + React + TypeScript app:
   - package.json (react, react-dom; devDeps vite, typescript, @vitejs/plugin-react), vite.config.ts, tsconfig.json, index.html, src/main.tsx, src/App.tsx, src/relay.ts.
   - relay.ts: WebSocket client to ws://127.0.0.1:8787/ws/client with state machine idle->connecting->live->resuming->resync (design 5.3), auto-reconnect, sends {t:"resume", chat, last_seq} on reconnect, dedupes by seq.
   - App.tsx: single chat view — message list, input box + send button; on send, append user bubble and send {t:"msg", chat:"default", text}; on evt frames, append/update the assistant bubble INCREMENTALLY, coalescing renders with requestAnimationFrame; on end, finalize. Show connection status. Minimal inline CSS, no external UI libs, no markdown lib yet (render plain text with white-space: pre-wrap).
   - It must build: run `npm install` in spa/ and `npm run build` and fix errors until build succeeds.

Report exactly which files you created and the build result. Keep code compact and readable.
