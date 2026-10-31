import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 18787;
const HOST = '127.0.0.1';
const AGENT_URL = `ws://${HOST}:${PORT}/ws/agent`;
const CLIENT_URL = `ws://${HOST}:${PORT}/ws/client`;
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Use a raw TCP socket: Node's http/fetch honour HTTP_PROXY, which must not hijack localhost.
function getHealth() {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: HOST, port: PORT });
    let data = '';
    socket.setEncoding('utf8');
    socket.setTimeout(500);
    socket.on('connect', () => {
      socket.write(`GET /health HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => {
      const body = data.slice(data.indexOf('\r\n\r\n') + 4);
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('timeout', () => socket.destroy(new Error('health request timeout')));
    socket.on('error', reject);
  });
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitUntil(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function waitHealth(predicate, label, timeoutMs = 5000) {
  let last;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      last = await getHealth();
      if (predicate(last)) return last;
    } catch {
      // server not up yet
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${label} (last health: ${JSON.stringify(last)})`);
}

async function connect(url, options) {
  const ws = new WebSocket(url, options);
  ws.inbox = [];
  ws.on('message', (raw) => ws.inbox.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  return ws;
}

async function waitFor(ws, predicate, label, timeoutMs = 3000) {
  let found;
  await waitUntil(() => {
    const index = ws.inbox.findIndex(predicate);
    if (index === -1) return false;
    [found] = ws.inbox.splice(index, 1);
    return true;
  }, label, timeoutMs);
  return found;
}

function hello(ws, started, session) {
  ws.send(JSON.stringify({
    t: 'hello',
    token: 'dev-agent-token',
    instance: 'smoke',
    agent: 'default',
    started,
    session,
  }));
}

function closeCode(ws) {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

async function main() {
  const server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), AGENT_TOKEN: 'dev-agent-token' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (d) => logs.push(d.toString()));
  server.stderr.on('data', (d) => logs.push(d.toString()));

  let agent;
  let client;
  try {
    const health = await waitHealth((h) => h.ok === true, 'server start');
    check(health.agentOnline === false, 'health should report agentOnline=false initially');
    check(health.clients === 0, 'health should report 0 clients initially');

    // 1. agent connects (Bearer token) -> hello wins the slot -> peer frame with client count
    agent = await connect(AGENT_URL, { headers: { Authorization: 'Bearer dev-agent-token' } });
    hello(agent, 1000, 'smoke-a');
    const firstPeer = await waitFor(agent, (f) => f.t === 'peer', 'agent peer frame');
    check(firstPeer.clients === 0, `expected 0 clients, got ${firstPeer.clients}`);

    // 2. client connects -> ready{agentOnline:true}; agent sees peer{clients:1}
    client = await connect(CLIENT_URL);
    // M39: every presence edge the client is told about, in order.
    const presence = [];
    client.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.t === 'status' && typeof frame.agentOnline === 'boolean') {
        presence.push(frame.agentOnline);
      }
    });
    const ready = await waitFor(client, (f) => f.t === 'ready', 'client ready frame');
    check(ready.agentOnline === true, 'client ready should say agentOnline=true');
    const peer = await waitFor(agent, (f) => f.t === 'peer', 'peer after client join');
    check(peer.clients === 1, `expected 1 client, got ${peer.clients}`);
    // Joining is not a slot edge: `ready` carries the snapshot, nothing is broadcast.
    await sleep(120);
    check(presence.length === 0, `client join must not broadcast presence, got ${JSON.stringify(presence)}`);

    // 3. client -> agent
    client.send(JSON.stringify({ t: 'msg', chat: 'c1', text: 'hi' }));
    const delivered = await waitFor(
      agent,
      (f) => f.t === 'msg' && f.chat === 'c1' && f.text === 'hi',
      'agent to receive client msg',
    );
    check(delivered.text === 'hi', 'agent got wrong msg payload');

    // 4. agent -> client, 20 evt frames in order
    const evts = [];
    client.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.t === 'evt') evts.push(frame);
    });
    for (let i = 0; i < 20; i += 1) {
      agent.send(JSON.stringify({ t: 'evt', chat: 'c1', seq: i, data: 'x' }));
    }
    await waitUntil(() => evts.length >= 20, '20 evt frames on client');
    check(evts.length === 20, `expected 20 evt frames, got ${evts.length}`);
    evts.forEach((frame, i) => {
      check(frame.seq === i, `evt out of order at index ${i}: seq=${frame.seq}`);
      check(frame.chat === 'c1' && frame.data === 'x', `evt ${i} corrupted`);
    });

    // 5. offline buffering: client frame waits for the agent and is flushed in order
    agent.close();
    await waitHealth((h) => h.agentOnline === false, 'agent disconnect');
    // M39: the holder left -> exactly one offline edge.
    await waitUntil(() => presence.length === 1 && presence[0] === false, 'offline presence frame');
    client.send(JSON.stringify({ t: 'msg', chat: 'c1', text: 'buffered' }));

    agent = await connect(AGENT_URL, { headers: { Authorization: 'Bearer dev-agent-token' } });
    hello(agent, 2000, 'smoke-a2');
    const replayed = await waitFor(
      agent,
      (f) => f.t === 'msg' && f.text === 'buffered',
      'buffered msg replay after agent reconnect',
    );
    check(replayed.chat === 'c1', 'buffered msg lost chat field');
    // ...and coming back is exactly one online edge, after the flush.
    await waitUntil(() => presence.length === 2 && presence[1] === true, 'online presence frame after reconnect');

    // 6. generation gating: older hellos are refused, newer ones take the slot
    const stale = await connect(AGENT_URL, { headers: { Authorization: 'Bearer dev-agent-token' } });
    const staleClosed = closeCode(stale);
    hello(stale, 500, 'stale');
    check((await staleClosed) === 4000, 'stale agent hello should be closed with code 4000');
    check((await waitHealth((h) => h.agentOnline === true, 'agent online after stale hello')).agentOnline === true,
      'health should still report agentOnline=true after a stale hello');
    // M39: a parked socket was never the holder, so its close is not an edge.
    await sleep(150);
    check(presence.length === 2, `a superseded hello must not broadcast presence, got ${JSON.stringify(presence)}`);

    agent.send(JSON.stringify({ t: 'evt', chat: 'c1', seq: 99, data: 'y' }));
    const undisturbed = await waitFor(
      client,
      (f) => f.t === 'evt' && f.chat === 'c1' && f.seq === 99,
      'client to receive evt after stale hello',
    );
    check(undisturbed.data === 'y', 'evt after stale hello corrupted');

    const previous = agent;
    const previousClosed = closeCode(previous);
    const newer = await connect(AGENT_URL, { headers: { Authorization: 'Bearer dev-agent-token' } });
    hello(newer, 3000, 'newer');
    check((await previousClosed) === 4000, 'previous agent should be closed with code 4000');
    agent = newer;

    client.send(JSON.stringify({ t: 'msg', chat: 'c1', text: 'after-newer' }));
    const routed = await waitFor(
      newer,
      (f) => f.t === 'msg' && f.chat === 'c1' && f.text === 'after-newer',
      'newer agent to receive client msg',
    );
    check(routed.text === 'after-newer', 'newer agent got wrong msg payload');
    // M39: the slot never appeared empty during the handover -> still two edges.
    await sleep(150);
    check(presence.length === 2, `a generation handover must not broadcast presence, got ${JSON.stringify(presence)}`);

    // 7. M39 presence edges -------------------------------------------------
    // A parked socket (connected, never hello) is not the holder: its close is silent.
    const parked = await connect(AGENT_URL, { headers: { Authorization: 'Bearer dev-agent-token' } });
    parked.close();
    await sleep(200);
    check(presence.length === 2, `a parked socket must not broadcast presence, got ${JSON.stringify(presence)}`);

    // The holder leaves -> exactly one offline edge, and no repeat on a second
    // close event for the same socket.
    agent.close();
    await waitUntil(() => presence.length === 3 && presence[2] === false, 'offline presence for the holder');
    await sleep(200);
    check(presence.length === 3, `the holder's close must broadcast exactly once, got ${JSON.stringify(presence)}`);

    // Returning -> one online edge; a re-hello on the same socket -> none.
    agent = await connect(AGENT_URL, { headers: { Authorization: 'Bearer dev-agent-token' } });
    hello(agent, 4000, 'smoke-a3');
    await waitUntil(() => presence.length === 4 && presence[3] === true, 'online presence after the holder returns');
    hello(agent, 4000, 'smoke-a3');
    await sleep(250);
    check(presence.length === 4, `a re-hello must not broadcast presence, got ${JSON.stringify(presence)}`);
    check(
      (await waitHealth((h) => h.agentOnline === true, 'agent online at the end')).agentOnline === true,
      'health should report agentOnline=true after the presence run',
    );

    if (stale.readyState === WebSocket.OPEN) stale.close();

    console.log('PASS');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    if (logs.length > 0) console.error(`--- server output ---\n${logs.join('')}`);
    process.exitCode = 1;
  } finally {
    if (client) client.close();
    if (agent) agent.close();
    server.kill('SIGTERM');
  }
}

await main();
