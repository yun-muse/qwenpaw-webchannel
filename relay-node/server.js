'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

const MAX_FRAME_BYTES = 256 * 1024; // protocol limit (checked ourselves so we can reply)
const MAX_WS_PAYLOAD = 2 * 1024 * 1024; // hard ws cap; bigger payloads kill the socket
const MAX_BUFFERED_FRAMES = 500;
const MAX_BUFFERED_BYTES = 1024 * 1024;

/** @type {import('ws').WebSocket | null} */
let agent = null;
/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();
/** client -> agent frames buffered while the agent is offline */
const outbox = [];
let outboxBytes = 0;

const isOpen = (ws) => ws !== null && ws.readyState === 1; // 1 = OPEN
const sendJson = (ws, obj) => {
  if (isOpen(ws)) ws.send(JSON.stringify(obj));
};
const sendError = (ws, code, id) => {
  sendJson(ws, id === undefined ? { t: 'error', code } : { t: 'error', code, id });
};
const sendPong = (ws, frame) => {
  sendJson(ws, frame.id === undefined ? { t: 'pong' } : { t: 'pong', id: frame.id });
};
const clientCount = () => clients.size;
const notifyPeer = () => sendJson(agent, { t: 'peer', clients: clientCount() });

/** Validate the envelope without looking at business fields. */
function readFrame(raw, isBinary) {
  if (isBinary) return { code: 'E_BADFRAME' };
  if (raw.length > MAX_FRAME_BYTES) return { code: 'E_TOOBIG' };

  const text = raw.toString('utf8');
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return { code: 'E_BADFRAME' };
  }
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame) || typeof frame.t !== 'string') {
    return { code: 'E_BADFRAME', id: typeof frame?.id === 'string' ? frame.id : undefined };
  }
  return { frame, text };
}

function bufferForAgent(text) {
  const size = Buffer.byteLength(text);
  outbox.push({ text, size });
  outboxBytes += size;
  while (outbox.length > MAX_BUFFERED_FRAMES || outboxBytes > MAX_BUFFERED_BYTES) {
    outboxBytes -= outbox.shift().size; // drop oldest
  }
}

function flushOutbox() {
  while (outbox.length > 0 && isOpen(agent)) {
    const { text, size } = outbox.shift();
    outboxBytes -= size;
    agent.send(text);
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

function handleAgent(ws) {
  if (isOpen(agent)) agent.close(4000, 'replaced by new agent connection');
  agent = ws;

  sendJson(ws, { t: 'peer', clients: clientCount() });
  flushOutbox();

  ws.on('message', (raw, isBinary) => {
    const { frame, text, code, id } = readFrame(raw, isBinary);
    if (code) return sendError(ws, code, id);
    if (frame.t === 'ping') return sendPong(ws, frame);
    if (frame.t === 'hello') return sendJson(ws, { t: 'ready', agentOnline: true });

    for (const client of clients) {
      if (isOpen(client)) client.send(text);
    }
  });

  ws.on('close', () => {
    if (agent === ws) agent = null;
  });
  ws.on('error', () => {});
}

function handleClient(ws) {
  clients.add(ws);
  sendJson(ws, { t: 'ready', agentOnline: isOpen(agent) });
  notifyPeer();

  ws.on('message', (raw, isBinary) => {
    const { frame, text, code, id } = readFrame(raw, isBinary);
    if (code) return sendError(ws, code, id);
    if (frame.t === 'ping') return sendPong(ws, frame);

    if (isOpen(agent)) agent.send(text);
    else bufferForAgent(text);
  });

  ws.on('close', () => {
    clients.delete(ws);
    notifyPeer();
  });
  ws.on('error', () => {});
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/health') {
    const body = JSON.stringify({ ok: true, agentOnline: isOpen(agent), clients: clientCount() });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  const body = JSON.stringify({ ok: false, error: 'not_found' });
  res.writeHead(404, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/ws/agent') {
    if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, handleAgent);
    return;
  }

  if (pathname === '/ws/client') {
    wss.handleUpgrade(req, socket, head, handleClient);
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`relay-node listening on :${PORT} (agent token: ${AGENT_TOKEN === 'dev-agent-token' ? 'dev default' : 'custom'})`);
});
