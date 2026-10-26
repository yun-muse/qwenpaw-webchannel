// Mock container-side agent for M0. Streams a canned reply per chat through relay-node.
import WebSocket from 'ws';

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:8787/ws/agent';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';
const CHUNK_DELAY_MS = 30;

/** @type {WebSocket | null} */
let ws = null;
let reconnectTimer = null;

/** seq is monotonic per chat */
const seqs = new Map();
const nextSeq = (chat) => {
  const n = (seqs.get(chat) ?? 0) + 1;
  seqs.set(chat, n);
  return n;
};

/** chat -> in-flight stream state */
const streams = new Map();

function send(frame) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[mock] drop (socket not open):', JSON.stringify(frame));
    return;
  }
  ws.send(JSON.stringify(frame));
  console.log('→', JSON.stringify(frame));
}

/** Split into 1-3 char pieces (per-delta streaming, not throttled). */
function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + (i % 3);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}

function cancelStream(chat, notify) {
  const state = streams.get(chat);
  if (!state) return false;
  state.cancelled = true;
  clearTimeout(state.timer);
  streams.delete(chat);
  console.log(`[mock] cancel stream chat=${chat}`);
  if (notify) send({ t: 'end', chat, seq: nextSeq(chat) });
  return true;
}

function streamReply(chat, text) {
  cancelStream(chat, true); // a new message replaces an in-flight reply

  const echo = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  const reply =
    `Echo: "${echo}" — **streaming works**. ` +
    'Each `evt` frame carries a few chars through the relay; ' +
    'the final `msg` frame holds the whole reply.';

  const chunks = chunkText(reply);
  const state = { timer: null, cancelled: false };
  streams.set(chat, state);

  send({ t: 'start', chat, seq: nextSeq(chat) });

  let i = 0;
  const tick = () => {
    if (state.cancelled) return;
    if (i >= chunks.length) {
      send({ t: 'end', chat, seq: nextSeq(chat) });
      send({ t: 'msg', chat, seq: nextSeq(chat), parts: [{ type: 'text', text: reply }] });
      streams.delete(chat);
      return;
    }
    const piece = chunks[i++];
    send({ t: 'evt', chat, seq: nextSeq(chat), data: { type: 'text_delta', text: piece } });
    state.timer = setTimeout(tick, CHUNK_DELAY_MS);
  };
  tick();
}

function onFrame(raw) {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!frame || typeof frame.t !== 'string') return;

  if (frame.t === 'msg' && typeof frame.chat === 'string') {
    if (typeof frame.text !== 'string') return;
    console.log(`[mock] ← msg chat=${frame.chat} text=${JSON.stringify(frame.text)}`);
    streamReply(frame.chat, frame.text);
    return;
  }
  if (frame.t === 'stop' && typeof frame.chat === 'string') {
    cancelStream(frame.chat, true);
    return;
  }
  if (frame.t === 'peer') {
    console.log(`[mock] peer clients=${frame.clients}`);
    return;
  }
  if (frame.t === 'ready') {
    console.log(`[mock] relay ready agentOnline=${frame.agentOnline}`);
    return;
  }
  // resume/hist/approve/deny are M2; unknown frames are ignored.
}

function connect() {
  console.log(`[mock] connecting to ${RELAY_URL}`);
  const socket = new WebSocket(RELAY_URL, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
  });
  ws = socket;

  socket.on('open', () => {
    console.log(`[mock] connected (token: ${AGENT_TOKEN === 'dev-agent-token' ? 'dev default' : 'custom'})`);
    send({ t: 'hello', instance: 'mock-agent', agent: 'default' });
  });
  socket.on('message', onFrame);
  socket.on('error', (err) => console.error('[mock] ws error:', err.message));
  socket.on('close', (code) => {
    if (ws !== socket) return;
    ws = null;
    for (const state of streams.values()) {
      state.cancelled = true;
      clearTimeout(state.timer);
    }
    streams.clear();
    console.log(`[mock] disconnected (${code}), retrying in 1s`);
    reconnectTimer = setTimeout(connect, 1000);
  });
}

process.on('SIGINT', () => {
  console.log('\n[mock] shutting down');
  if (reconnectTimer) clearTimeout(reconnectTimer);
  for (const state of streams.values()) clearTimeout(state.timer);
  ws?.close();
  process.exit(0);
});

connect();
