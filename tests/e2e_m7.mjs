// E2E M7: model list / switch / status against the LOCAL stack
// (relay-node :8787 + local QwenPaw :8088, plugin installed there).
//
// Asserts the §9 control-plane behaviour end to end:
//   1. a `status` push arrives with a non-empty agent_name
//   2. `models` returns >= 1 item with exactly one active
//   3. `set_model` to another listed model -> `model_changed`, a fresh
//      `models` shows it active, and the app's own
//      GET /api/models/active?scope=agent agrees (real switch, hot)
//      ...or, when only one model is listed locally, the same-model
//      no-op path still answers `model_changed`
//   4. switching back restores the original active model
//   5. a bogus `set_model` yields E_MODEL and the socket stays alive:
//      a normal chat round-trip completes afterwards
//
// Run: node tests/e2e_m7.mjs   (prints ASSERT lines, then E2E_M7 PASS)

import { createRequire } from 'node:module';

const require = createRequire(new URL('../mock/package.json', import.meta.url));
const WebSocket = require('ws');

const CLIENT_URL = 'ws://127.0.0.1:8787/ws/client';
const APP_ACTIVE_URL =
  'http://127.0.0.1:8088/api/models/active?scope=agent&agent_id=default';

const frames = [];
let failures = 0;

function assert(name, cond, extra = '') {
  console.log(`ASSERT ${name}: ${cond ? 'PASS' : 'FAIL'}${extra ? ` (${extra})` : ''}`);
  if (!cond) failures += 1;
  return cond;
}

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) {
        return reject(
          new Error(`timeout waiting for ${label}; got: ${frames
            .map((f) => f.t)
            .join(',')}`),
        );
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

const ws = new WebSocket(CLIENT_URL);
const send = (obj) => ws.send(JSON.stringify(obj));
ws.on('message', (data) => {
  try {
    frames.push(JSON.parse(data.toString()));
  } catch {
    /* ignore */
  }
});

// A model switch hot-reloads the agent, which bounces the plugin's relay
// socket for a few seconds; a `models` request sent in that window is
// lost. Re-send until the reply lands (or give up after ~45 s).
async function requestModels(label) {
  const t0 = Date.now();
  for (;;) {
    frames.length = 0;
    send({ t: 'models' });
    try {
      return await waitFor((f) => f.t === 'models', 6000, label);
    } catch {
      if (Date.now() - t0 > 45000) throw new Error(`timeout waiting for ${label}`);
    }
  }
}

async function appActive() {
  const res = await fetch(APP_ACTIVE_URL);
  if (!res.ok) throw new Error(`app active check HTTP ${res.status}`);
  const body = await res.json();
  return body.active_llm || null;
}

try {
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // 1. status push (peer on our join, or ready) with an agent name.
  const status = await waitFor((f) => f.t === 'status', 20000, 'status frame');
  assert(
    'status.agent_name',
    typeof status.agent_name === 'string' && status.agent_name.length > 0,
    `agent_name=${JSON.stringify(status.agent_name)} status has provider=${status.provider} model=${status.model}`,
  );

  // 2. models list: >= 1 item, exactly one active.
  const models1 = await requestModels('models frame');
  const items = Array.isArray(models1.items) ? models1.items : [];
  const actives = items.filter((i) => i.active === true);
  assert('models.nonempty', items.length >= 1, `${items.length} item(s)`);
  assert('models.exactly_one_active', actives.length === 1, `${actives.length} active`);
  assert(
    'models.shape',
    items.every(
      (i) =>
        typeof i.provider === 'string' &&
        typeof i.model === 'string' &&
        typeof i.active === 'boolean' &&
        Object.keys(i).sort().join(',') === 'active,model,provider',
    ),
    'items are exactly {provider, model, active}',
  );
  const original = actives[0];
  const other = items.find(
    (i) => i.provider !== original.provider || i.model !== original.model,
  );

  if (other) {
    // 3. real switch to another listed model.
    frames.length = 0;
    send({ t: 'set_model', provider: other.provider, model: other.model });
    const changed = await waitFor(
      (f) => f.t === 'model_changed',
      30000,
      'model_changed frame',
    );
    assert(
      'switch.model_changed',
      changed.provider === other.provider && changed.model === other.model,
      `${changed.provider}/${changed.model}`,
    );
    const models2 = await requestModels('models after switch');
    const active2 = (models2.items || []).find((i) => i.active === true);
    assert(
      'switch.list_shows_new_active',
      active2 && active2.provider === other.provider && active2.model === other.model,
      active2 ? `${active2.provider}/${active2.model}` : 'none',
    );
    const appNow = await appActive();
    assert(
      'switch.app_side_agent_scope',
      appNow &&
        appNow.provider_id === other.provider &&
        appNow.model === other.model,
      appNow ? `${appNow.provider_id}/${appNow.model}` : 'null',
    );

    // 4. switch back to the original.
    frames.length = 0;
    send({ t: 'set_model', provider: original.provider, model: original.model });
    const back = await waitFor(
      (f) => f.t === 'model_changed',
      30000,
      'model_changed (switch back)',
    );
    assert(
      'switch_back.model_changed',
      back.provider === original.provider && back.model === original.model,
      `${back.provider}/${back.model}`,
    );
  } else {
    // Single-model environment: exercise the no-op path instead.
    console.log(
      `NOTE single-model environment: only ${original.provider}/${original.model} listed; exercising same-model set_model`,
    );
    frames.length = 0;
    send({ t: 'set_model', provider: original.provider, model: original.model });
    const changed = await waitFor(
      (f) => f.t === 'model_changed',
      30000,
      'model_changed (no-op)',
    );
    assert(
      'noop.model_changed',
      changed.provider === original.provider && changed.model === original.model,
    );
  }

  // 5. bogus model -> E_MODEL, socket alive, chat still works.
  // (Re-send while the switch-back reload bounce may still be settling:
  // a lost bogus frame is harmless, it can never switch anything.)
  let err = null;
  {
    const t0 = Date.now();
    while (!err) {
      frames.length = 0;
      send({ t: 'set_model', provider: 'no-such-provider', model: 'no-such-model' });
      try {
        err = await waitFor(
          (f) => f.t === 'error' && f.code === 'E_MODEL',
          6000,
          'E_MODEL error frame',
        );
      } catch {
        if (Date.now() - t0 > 45000) throw new Error('timeout waiting for E_MODEL');
      }
    }
  }
  assert('bogus.E_MODEL', Boolean(err), `detail=${err.detail || ''}`);

  const chatId = `m7chat-${Date.now().toString(36)}`;
  frames.length = 0;
  send({ t: 'msg', chat: chatId, text: 'M7 check: reply with the single word ok' });
  const finalMsg = await waitFor(
    (f) => f.t === 'msg' && f.chat === chatId,
    90000,
    'chat reply after model error',
  );
  // The trailing msg frame carries parts[] (same shape e2e_m2 asserts on).
  const replyText = Array.isArray(finalMsg.parts)
    ? ((finalMsg.parts.find((p) => p.type === 'text') || {}).text ?? '')
    : (finalMsg.text ?? '');
  assert(
    'chat_after_error.roundtrip',
    typeof replyText === 'string' && replyText.length > 0,
    `reply: ${JSON.stringify(String(replyText).slice(0, 60))}`,
  );
} catch (err) {
  failures += 1;
  console.log(`ERROR ${err.message}`);
} finally {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
}

if (failures === 0) {
  console.log('E2E_M7 PASS');
  process.exit(0);
} else {
  console.log(`E2E_M7 FAIL (${failures} failure(s))`);
  process.exit(1);
}
