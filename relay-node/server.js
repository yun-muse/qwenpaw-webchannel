'use strict';

const http = require('node:http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

const MAX_FRAME_BYTES = 256 * 1024; // protocol limit (checked ourselves so we can reply)
const MAX_WS_PAYLOAD = 2 * 1024 * 1024; // hard ws cap; bigger payloads kill the socket
const MAX_BUFFERED_FRAMES = 500;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const REPLACED_CODE = 4000; // close code: agent slot replaced or hello superseded

/** @type {import('ws').WebSocket | null} */
let agent = null;
/** @type {{ started: number, session: string } | null} */
let agentMeta = null;
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
  // The slot is won at hello time by generation; until then the socket is parked.

  ws.on('message', (raw, isBinary) => {
    const { frame, text, code, id } = readFrame(raw, isBinary);
    if (code) return sendError(ws, code, id);
    if (frame.t === 'ping') return sendPong(ws, frame);

    // M7.3 end-to-end heartbeat, in lockstep with relay-cf: the relay process
    // itself acks, so a dead agent<->relay path is visible to the plugin. Not
    // forwarded, and a parked/superseded socket gets no ack.
    if (frame.t === 'hb') {
      if (ws !== agent) return;
      sendJson(ws, typeof frame.id === 'string' ? { t: 'hb_ack', id: frame.id } : { t: 'hb_ack' });
      return;
    }

    if (frame.t === 'hello') {
      const started = Number.isFinite(frame.started) && frame.started > 0 ? frame.started : 0;
      const session = typeof frame.session === 'string' ? frame.session : '';

      if (agent && agent !== ws && started < agentMeta.started) {
        // An older generation must not disturb the current agent.
        ws.close(REPLACED_CODE, 'superseded by newer agent connection');
        return;
      }

      if (agent === ws) {
        // Re-hello from the current agent: refresh metadata, nothing else.
        agentMeta = { started, session };
        return sendJson(ws, { t: 'ready', agentOnline: true });
      }

      if (agent) agent.close(REPLACED_CODE, 'replaced by new agent connection');
      agent = ws;
      agentMeta = { started, session };

      sendJson(ws, { t: 'peer', clients: clientCount() });
      flushOutbox();
      sendJson(ws, { t: 'ready', agentOnline: true });
      return;
    }

    if (ws !== agent) return;

    for (const client of clients) {
      if (isOpen(client)) client.send(text);
    }
  });

  ws.on('close', () => {
    if (agent === ws) {
      agent = null;
      agentMeta = null;
    }
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
    // Agent-side liveness frames never come from a client and are never
    // forwarded to the agent (M7.3); relay-cf drops `hb` the same way.
    if (frame.t === 'hb') return;

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
