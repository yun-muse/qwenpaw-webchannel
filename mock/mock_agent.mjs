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

let activeModel = { provider: 'openai', model: 'gpt-4o' };
const mockModels = [
  { provider: 'openai', model: 'gpt-4o' },
  { provider: 'openai', model: 'o3-mini' },
  { provider: 'anthropic', model: 'claude-3-7-sonnet' },
  { provider: 'local', model: 'qwen3-32b' },
];
const mockChats = new Map([
  ['default', { chat: 'default', title: 'Welcome to QwenPaw Web', updated_at: new Date().toISOString() }],
  ['demo-research', { chat: 'demo-research', title: 'Architecture & Relay Notes', updated_at: new Date(Date.now() - 3600_000).toISOString() }],
]);
const mockSkills = [
  { id: 'web_search', name: 'Web Search', description: 'Search the live web and summarize citations' },
  { id: 'python_exec', name: 'Python Sandbox', description: 'Run isolated Python snippets and inspect outputs' },
  { id: 'file_reader', name: 'Workspace Reader', description: 'Read and analyze files in the agent workspace' },
  { id: 'memory_recall', name: 'Memory Recall', description: 'Query long-term notes from MEMORY.md' },
];
const mockPrompts = {
  'SOUL.md': '# Soul\nYou are QwenPaw, a thoughtful and concise AI pair programmer.\n',
  'AGENTS.md': '# Agent Guidelines\n- Prefer clear, incremental solutions.\n- Verify changes with automated tests.\n',
  'PROFILE.md': '# User Profile\n- Prefers concise technical answers with code examples.\n',
  'MEMORY.md': '# Long-Term Memory\n- Project uses WebChannel v2 protocol over WebSocket relay.\n',
};

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
    if (!mockChats.has(frame.chat)) {
      mockChats.set(frame.chat, {
        chat: frame.chat,
        title: frame.text.slice(0, 32) || frame.chat,
        updated_at: new Date().toISOString(),
      });
    }
    streamReply(frame.chat, frame.text);
    return;
  }
  if (frame.t === 'stop' && typeof frame.chat === 'string') {
    cancelStream(frame.chat, true);
    return;
  }
  if (frame.t === 'peer') {
    console.log(`[mock] peer clients=${frame.clients}`);
    send({ t: 'status', agent_name: 'QwenPaw Mock Agent', provider: activeModel.provider, model: activeModel.model });
    return;
  }
  if (frame.t === 'ready') {
    console.log(`[mock] relay ready agentOnline=${frame.agentOnline}`);
    send({ t: 'status', agent_name: 'QwenPaw Mock Agent', provider: activeModel.provider, model: activeModel.model });
    return;
  }
  if (frame.t === 'models') {
    send({
      t: 'models',
      items: mockModels.map((m) => ({
        provider: m.provider,
        model: m.model,
        active: m.provider === activeModel.provider && m.model === activeModel.model,
      })),
    });
    return;
  }
  if (frame.t === 'set_model') {
    if (typeof frame.provider === 'string' && typeof frame.model === 'string') {
      activeModel = { provider: frame.provider, model: frame.model };
      send({ t: 'model_changed', provider: activeModel.provider, model: activeModel.model });
      send({ t: 'status', agent_name: 'QwenPaw Mock Agent', provider: activeModel.provider, model: activeModel.model });
    }
    return;
  }
  if (frame.t === 'chats') {
    send({ t: 'chats', items: Array.from(mockChats.values()) });
    return;
  }
  if (frame.t === 'del_chat' && typeof frame.chat === 'string') {
    mockChats.delete(frame.chat);
    send({ t: 'chat_deleted', chat: frame.chat });
    return;
  }
  if (frame.t === 'rename_chat' && typeof frame.chat === 'string') {
    const title = String(frame.title || '').trim();
    const existing = mockChats.get(frame.chat) || { chat: frame.chat, updated_at: new Date().toISOString() };
    mockChats.set(frame.chat, { ...existing, title, updated_at: new Date().toISOString() });
    send({ t: 'chat_renamed', chat: frame.chat, title });
    return;
  }
  if (frame.t === 'skills') {
    send({ t: 'skills', items: mockSkills });
    return;
  }
  if (frame.t === 'get_prompts') {
    send({ t: 'prompts', files: { ...mockPrompts } });
    return;
  }
  if (frame.t === 'set_prompt' && typeof frame.file === 'string' && typeof frame.content === 'string') {
    if (Object.prototype.hasOwnProperty.call(mockPrompts, frame.file)) {
      mockPrompts[frame.file] = frame.content;
      send({ t: 'prompt_saved', file: frame.file });
    } else {
      send({ t: 'error', code: 'E_PROMPT', detail: 'invalid prompt file or content' });
    }
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
    send({ t: 'hello', instance: 'mock-agent', agent: 'default', session: `mock-${Date.now()}`, started: Date.now() * 1000 });
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
