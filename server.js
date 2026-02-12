'use strict';

/**
 * WoL VLAN WebApp
 * - MODE=controller: Web UI + hosts/agents CRUD + wake via local or agent
 * - MODE=agent: /wake endpoint sends WoL on that VLAN
 *
 * Requirements: Node.js >= 18 (for built-in fetch)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const wol = require('wakeonlan');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '64kb' }));

// ---- mode ----
const MODE = (process.env.MODE || 'controller').toLowerCase(); // controller | agent
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || (MODE === 'agent' ? 3001 : 3000));

// agent auth
const AGENT_TOKEN = process.env.AGENT_TOKEN || ''; // required in agent mode

// storage (controller mode only)
const STORE_PATH = path.join(__dirname, 'storage.json');

// API rate limit
app.use('/api/', rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
}));

function isMac(mac) {
  return /^([0-9A-Fa-f]{2}([-:])){5}[0-9A-Fa-f]{2}$/.test(mac);
}

function normalizeMac(mac) {
  return String(mac).trim().replace(/-/g, ':').toLowerCase();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

// ----- storage helpers (controller) -----
function initStoreIfMissing() {
  if (!fs.existsSync(STORE_PATH)) {
    const initial = { agents: [], hosts: [] };
    fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2));
  }
}

function readStore() {
  initStoreIfMissing();
  const raw = fs.readFileSync(STORE_PATH, 'utf8');
  const data = JSON.parse(raw);
  data.agents ||= [];
  data.hosts ||= [];
  return data;
}

// atomic write
function writeStore(data) {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// ------------------- AGENT MODE -------------------
if (MODE === 'agent') {
  if (!AGENT_TOKEN) {
    console.error('ERROR: AGENT_TOKEN is required in agent mode');
    process.exit(1);
  }

  // health check (no auth)
  app.get('/health', (req, res) => res.json({ ok: true, mode: 'agent' }));

  // minimal auth: header X-Agent-Token
  app.post('/wake', async (req, res) => {
    try {
      const token = req.get('X-Agent-Token') || '';
      if (token !== AGENT_TOKEN) return res.status(401).json({ error: 'unauthorized' });

      const mac = normalizeMac(req.body?.mac || '');
      const broadcast = req.body?.broadcast ? String(req.body.broadcast).trim() : undefined;
      const port = req.body?.port ? Number(req.body.port) : undefined;

      if (!isMac(mac)) return res.status(400).json({ error: 'invalid mac' });

      const options = {};
      if (broadcast) options.address = broadcast; // broadcast/IP
      if (port) options.port = port;

      await wol(mac, options);

      res.json({ ok: true, mac, broadcast: options.address ?? null, port: options.port ?? null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.listen(PORT, HOST, () => {
    console.log(`WoL Agent listening on http://${HOST}:${PORT}`);
  });

  return;
}

// ------------------- CONTROLLER MODE -------------------
app.use(express.static(path.join(__dirname, 'public')));

// controller: list hosts + agents
app.get('/api/state', (req, res) => {
  try {
    const store = readStore();
    res.json({
      agents: store.agents.map(a => ({ id: a.id, name: a.name, url: a.url })),
      hosts: store.hosts.map(h => ({ id: h.id, name: h.name, mac: h.mac, agentId: h.agentId || null })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// add agent (VLAN endpoint)
app.post('/api/agents', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const url = String(req.body?.url || '').trim();
    const token = String(req.body?.token || '').trim();

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    if (!token) return res.status(400).json({ error: 'token required' });

    const store = readStore();
    const id = newId('agent');
    store.agents.push({ id, name, url, token });
    writeStore(store);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// update agent (name/url/token)
app.put('/api/agents/:id', (req, res) => {
  try {
    const id = req.params.id;
    const store = readStore();
    const agent = store.agents.find(a => a.id === id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : agent.name;
    const url = req.body?.url !== undefined ? String(req.body.url).trim() : agent.url;
    const token = req.body?.token !== undefined ? String(req.body.token).trim() : agent.token;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return res.status(400).json({ error: 'url must start with http:// or https://' });
    }
    if (!token) return res.status(400).json({ error: 'token required' });

    agent.name = name;
    agent.url = url;
    agent.token = token;

    writeStore(store);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// delete agent
app.delete('/api/agents/:id', (req, res) => {
  try {
    const store = readStore();
    const id = req.params.id;

    // hosts that reference this agent -> null (or you can block deletion)
    store.hosts = store.hosts.map(h => (h.agentId === id ? { ...h, agentId: null } : h));
    const before = store.agents.length;
    store.agents = store.agents.filter(a => a.id !== id);

    if (store.agents.length === before) return res.status(404).json({ error: 'agent not found' });

    writeStore(store);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// agent reachability check
app.get('/api/agents/:id/health', async (req, res) => {
  try {
    const store = readStore();
    const agent = store.agents.find(a => a.id === req.params.id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    const url = agent.url.replace(/\/+$/, '') + '/health';
    const t0 = Date.now();
    const data = await fetchJson(url, { method: 'GET' });
    const ms = Date.now() - t0;

    // expect {ok:true, mode:'agent'}
    res.json({ ok: true, reachable: true, latencyMs: ms, response: data });
  } catch (e) {
    res.json({ ok: true, reachable: false, error: e.message });
  }
});

// add host (name + mac + agentId optional)
app.post('/api/hosts', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const mac = normalizeMac(req.body?.mac || '');
    const agentId = req.body?.agentId ? String(req.body.agentId).trim() : null;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!isMac(mac)) return res.status(400).json({ error: 'invalid mac' });

    const store = readStore();

    if (agentId && !store.agents.some(a => a.id === agentId)) {
      return res.status(400).json({ error: 'agentId not found' });
    }

    // prevent duplicates by mac
    if (store.hosts.some(h => h.mac === mac)) {
      return res.status(409).json({ error: 'mac already exists' });
    }

    const id = newId('host');
    store.hosts.push({ id, name, mac, agentId: agentId || null });
    writeStore(store);

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// update host (edit)
app.put('/api/hosts/:id', (req, res) => {
  try {
    const id = req.params.id;
    const store = readStore();
    const host = store.hosts.find(h => h.id === id);
    if (!host) return res.status(404).json({ error: 'host not found' });

    const name = req.body?.name !== undefined ? String(req.body.name).trim() : host.name;
    const mac = req.body?.mac !== undefined ? normalizeMac(req.body.mac) : host.mac;
    const agentId = req.body?.agentId !== undefined
      ? (req.body.agentId ? String(req.body.agentId).trim() : null)
      : host.agentId;

    if (!name) return res.status(400).json({ error: 'name required' });
    if (!isMac(mac)) return res.status(400).json({ error: 'invalid mac' });
    if (agentId && !store.agents.some(a => a.id === agentId)) {
      return res.status(400).json({ error: 'agentId not found' });
    }

    // prevent duplicates by mac (excluding self)
    if (store.hosts.some(h => h.id !== id && h.mac === mac)) {
      return res.status(409).json({ error: 'mac already exists' });
    }

    host.name = name;
    host.mac = mac;
    host.agentId = agentId || null;

    writeStore(store);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// delete host
app.delete('/api/hosts/:id', (req, res) => {
  try {
    const store = readStore();
    const before = store.hosts.length;
    store.hosts = store.hosts.filter(h => h.id !== req.params.id);
    if (store.hosts.length === before) return res.status(404).json({ error: 'host not found' });
    writeStore(store);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// wake host: if agentId exists -> call agent, else local wake
async function postJson(url, headers, body) {
  return fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

app.post('/api/wake/:hostId', async (req, res) => {
  try {
    const store = readStore();
    const host = store.hosts.find(h => h.id === req.params.hostId);
    if (!host) return res.status(404).json({ error: 'host not found' });

    // optional override (directed broadcast等で使う)
    const overrideBroadcast = req.body?.broadcast ? String(req.body.broadcast).trim() : undefined;
    const overridePort = req.body?.port ? Number(req.body.port) : undefined;

    if (host.agentId) {
      const agent = store.agents.find(a => a.id === host.agentId);
      if (!agent) return res.status(500).json({ error: 'host.agentId is set but agent missing' });

      const url = agent.url.replace(/\/+$/, '') + '/wake';
      const payload = { mac: host.mac };
      if (overrideBroadcast) payload.broadcast = overrideBroadcast;
      if (overridePort) payload.port = overridePort;

      const r = await postJson(url, { 'X-Agent-Token': agent.token }, payload);
      return res.json({ ok: true, via: 'agent', agentId: agent.id, result: r });
    }

    // local wake (same VLAN)
    const options = {};
    if (overrideBroadcast) options.address = overrideBroadcast;
    if (overridePort) options.port = overridePort;

    await wol(host.mac, options);
    res.json({ ok: true, via: 'local', mac: host.mac, broadcast: options.address ?? null, port: options.port ?? null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`WoL Controller listening on http://${HOST}:${PORT}`);
});
