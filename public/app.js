const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t; };

async function api(path, opts) {
  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

let lastState = null;

function agentNameById(id) {
  if (!id) return 'local';
  const a = lastState?.agents?.find(x => x.id === id);
  return a ? `${a.name} (${a.id})` : id;
}

async function refresh() {
  msg('loading...');
  const state = await api('/api/state');
  lastState = state;

  // agents list
  const agentsDiv = $('agents');
  agentsDiv.innerHTML = '';
  state.agents.forEach(a => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight:600">${esc(a.name)} <span class="badge" id="badge_${esc(a.id)}">unknown</span></div>
          <div class="muted">id: <code>${esc(a.id)}</code> / url: <code>${esc(a.url)}</code></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="ghost" data-health="${esc(a.id)}">到達確認</button>
          <button class="ghost" data-edit-agent="${esc(a.id)}">編集</button>
          <button class="danger" data-del-agent="${esc(a.id)}">削除</button>
        </div>
      </div>
    `;

    // health check
    div.querySelector('button[data-health]').addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-health');
      e.target.disabled = true;
      try {
        msg(`checking agent ${id}...`);
        const r = await api(`/api/agents/${encodeURIComponent(id)}/health`);
        const badge = document.getElementById(`badge_${id}`);
        if (r.reachable) {
          badge.textContent = `OK ${r.latencyMs}ms`;
          badge.className = 'badge ok';
        } else {
          badge.textContent = 'NG';
          badge.className = 'badge ng';
        }
        msg(JSON.stringify(r, null, 2));
      } catch (err) {
        msg('ERROR: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });

    // edit agent (prompt-based)
    div.querySelector('button[data-edit-agent]').addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-edit-agent');
      const cur = state.agents.find(x => x.id === id);
      if (!cur) return;

      const name = prompt('Agent name', cur.name);
      if (name === null) return;
      const url = prompt('Agent url (http://.../)', cur.url);
      if (url === null) return;
      const token = prompt('Agent token (shared secret)', ''); // allow blank to keep? we will keep if blank
      if (token === null) return;

      e.target.disabled = true;
      try {
        const body = { name, url };
        if (token.trim() !== '') body.token = token.trim();
        else body.token = prompt('token is empty. keep current token? (OK=keep / Cancel=abort)', '') === null ? null : cur.token;

        await api(`/api/agents/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: body.name, url: body.url, token: body.token }),
        });
        await refresh();
        msg('Agent updated.');
      } catch (err) {
        msg('ERROR: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });

    // delete agent
    div.querySelector('button[data-del-agent]').addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-del-agent');
      if (!confirm(`Agent ${id} を削除しますか？（関連ホストは local に戻ります）`)) return;
      e.target.disabled = true;
      try {
        await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refresh();
        msg('Agent deleted.');
      } catch (err) {
        msg('ERROR: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });

    agentsDiv.appendChild(div);
  });

  // agent select
  const sel = $('hostAgent');
  sel.innerHTML = `<option value="">（同一VLAN: ローカル送信）</option>`;
  state.agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.name} (${a.id})`;
    sel.appendChild(opt);
  });

  // hosts list
  const hostsDiv = $('hosts');
  hostsDiv.innerHTML = '';
  state.hosts.forEach(h => {
    const agentLabel = h.agentId ? `agent: <code>${esc(h.agentId)}</code>` : 'local';
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div class="row">
        <div>
          <div style="font-weight:600">${esc(h.name)}</div>
          <div class="muted">
            id: <code>${esc(h.id)}</code> / mac: <code>${esc(h.mac)}</code> / ${agentLabel}
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button data-wake="${esc(h.id)}">起動</button>
          <button class="ghost" data-edit="${esc(h.id)}">編集</button>
          <button class="danger" data-del="${esc(h.id)}">削除</button>
        </div>
      </div>
    `;

    // wake
    div.querySelector('button[data-wake]').addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-wake');
      e.target.disabled = true;
      try {
        msg(`waking ${id}...`);
        const r = await api(`/api/wake/${encodeURIComponent(id)}`, { method: 'POST' });
        msg(JSON.stringify(r, null, 2));
      } catch (err) {
        msg('ERROR: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });

    // edit host (prompt-based)
    div.querySelector('button[data-edit]').addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-edit');
      const cur = state.hosts.find(x => x.id === id);
      if (!cur) return;

      const name = prompt('Host name', cur.name);
      if (name === null) return;
      const mac = prompt('MAC address (00:11:22:33:44:55)', cur.mac);
      if (mac === null) return;

      // agent selection via prompt
      const agentPrompt = `Agent id (空=local)\n` +
        state.agents.map(a => `- ${a.id}: ${a.name}`).join('\n') +
        `\n\ncurrent: ${cur.agentId || '(local)'}`;
      const agentIdRaw = prompt(agentPrompt, cur.agentId || '');
      if (agentIdRaw === null) return;
      const agentId = agentIdRaw.trim() === '' ? null : agentIdRaw.trim();

      e.target.disabled = true;
      try {
        await api(`/api/hosts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mac, agentId }),
        });
        await refresh();
        msg('Host updated.');
      } catch (err) {
        msg('ERROR: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });

    // delete host
    div.querySelector('button[data-del]').addEventListener('click', async (e) => {
      const id = e.target.getAttribute('data-del');
      if (!confirm(`Host ${id} を削除しますか？`)) return;
      e.target.disabled = true;
      try {
        await api(`/api/hosts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await refresh();
        msg('Host deleted.');
      } catch (err) {
        msg('ERROR: ' + err.message);
      } finally {
        e.target.disabled = false;
      }
    });

    hostsDiv.appendChild(div);
  });

  msg('ready.');
}

// add agent
$('addAgent').addEventListener('click', async () => {
  const name = $('agentName').value.trim();
  const url = $('agentUrl').value.trim();
  const token = $('agentToken').value.trim();

  $('addAgent').disabled = true;
  try {
    const r = await api('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, token }),
    });
    msg('Agent added: ' + r.id);
    $('agentName').value = '';
    $('agentUrl').value = '';
    $('agentToken').value = '';
    await refresh();
  } catch (err) {
    msg('ERROR: ' + err.message);
  } finally {
    $('addAgent').disabled = false;
  }
});

// add host
$('addHost').addEventListener('click', async () => {
  const name = $('hostName').value.trim();
  const mac = $('hostMac').value.trim();
  const agentId = $('hostAgent').value || null;

  $('addHost').disabled = true;
  try {
    const r = await api('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mac, agentId }),
    });
    msg('Host added: ' + r.id);
    $('hostName').value = '';
    $('hostMac').value = '';
    $('hostAgent').value = '';
    await refresh();
  } catch (err) {
    msg('ERROR: ' + err.message);
  } finally {
    $('addHost').disabled = false;
  }
});

refresh().catch(e => msg('ERROR: ' + e.message));
