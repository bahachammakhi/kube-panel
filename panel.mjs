import { cleanOutput, renderLogs, renderYaml, renderEvents } from './viewer.mjs';
const $ = id => document.getElementById(id);
const api = window.orca;
const state = { kind: 'pods', rows: [], selected: null, tab: 'logs', connected: null, contexts: [], generation: 0, detailGeneration: 0 };
let listController, detailController;
let output = null, outputTab = null, autoTimer;
let auto = false, follow = true;
const request = (name, input = {}, signal) => api.plugin.request(`kube.${name}`, input, { timeoutMs: 25000, ...(signal ? { signal } : {}) });
function error(e) { $('error').textContent = e.message || String(e); $('error').hidden = false; }
function clearError() { $('error').hidden = true; }
function option(value, title = value) { const el = document.createElement('option'); el.value = value; el.textContent = title; return el; }
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function selection() { return { context: $('context').value, namespace: $('namespace').value.trim() }; }
function clearDetails() {
  clearTimeout(autoTimer); output = null; outputTab = null;
  document.querySelector('main').classList.remove('details-expanded');
  $('expand').setAttribute('aria-pressed', 'false'); $('expand').textContent = 'Expand';
  state.selected = null; state.detailGeneration++; detailController?.abort(); $('details').hidden = true; $('detail-content').replaceChildren();
}
function disconnect() {
  state.generation++; listController?.abort(); clearDetails(); state.connected = null; state.rows = [];
  $('refresh').disabled = true; $('summary').textContent = 'Selection changed. Connect to load workloads.'; renderRows();
}
function renderRows() {
  const scrollTop = $('workloads').scrollTop;
  const filter = $('filter').value.toLowerCase();
  const rows = state.rows.filter(r => `${r.name} ${r.namespace} ${r.status}`.toLowerCase().includes(filter));
  const nodes = rows.map(row => {
    const button = element('button', '', `workload${row.uid === state.selected?.uid ? ' selected' : ''}`);
    button.setAttribute('aria-pressed', String(row.uid === state.selected?.uid));
    button.title = `${row.name}\n${row.namespace} · ${row.status} · ${row.ready} ready · ${row.restarts} restarts`;
    button.append(element('span', row.name, 'row-title'), element('span', row.ready, 'row-count'), element('span', String(row.restarts), 'row-count'));
    const meta = element('span', '', 'row-meta');
    meta.append(element('span', row.status, `status${row.healthy ? ' healthy' : ''}`), element('span', row.namespace, 'row-namespace'));
    button.append(meta); button.onclick = () => selectRow(row); return button;
  });
  if (!nodes.length) nodes.push(element('div', state.connected ? filter ? 'No workloads match your filter.' : 'No workloads in this namespace.' : 'Your cluster, beside your code.', 'empty'));
  $('workloads').replaceChildren(...nodes);
  $('workloads').scrollTop = scrollTop;
}
async function persist() {
  if ($('workspace').value) await request('preferences', { workspaceId: $('workspace').value, selection: selection() });
}
async function connect() {
  disconnect(); clearError();
  const selected = selection();
  if (!selected.context || !selected.namespace) return error(new Error('Choose a context and namespace.'));
  state.connected = selected;
  try { await persist(); } catch (e) { error(e); }
  if (state.connected !== selected) return;
  $('refresh').disabled = false;
  // Namespace discovery is optional: namespace-scoped RBAC can still browse workloads.
  request('namespaces', selected).then(names => {
    if (state.connected === selected) $('namespaces').replaceChildren(...names.map(n => option(n)));
  }).catch(() => {});
  await refresh();
}
async function refresh() {
  if (!state.connected) return;
  const generation = ++state.generation;
  listController?.abort(); listController = new AbortController();
  $('summary').textContent = 'Loading workloads…'; $('refresh').disabled = true; clearError();
  try {
    const rows = await request('workloads', { ...state.connected, kind: state.kind }, listController.signal);
    if (generation !== state.generation) return;
    state.rows = rows;
    const selected = rows.find(r => r.uid === state.selected?.uid);
    if (state.selected && !selected) clearDetails();
    if (selected) state.selected = selected;
    $('summary').textContent = `${rows.length} ${state.kind} · ${rows.filter(r => !r.healthy).length} need attention`;
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    renderRows();
    if (selected) await detail();
  } catch (e) {
    if (generation !== state.generation) return;
    state.rows = []; clearDetails(); renderRows(); $('summary').textContent = 'Could not load workloads.'; error(e);
  } finally { if (generation === state.generation) $('refresh').disabled = !state.connected; }
}
function selectRow(row) {
  clearTimeout(autoTimer); output = null; outputTab = null;
  $('output-search').value = ''; $('severity').value = 'all';
  state.selected = row;
  if (row.kind === 'deployments' && state.tab === 'logs') state.tab = 'events';
  $('resource-name').textContent = row.name; $('resource-namespace').textContent = row.namespace;
  $('resource-name').title = row.name;
  $('resource-namespace').title = `${state.connected?.context || ''} · ${row.namespace}`;
  $('container').replaceChildren(...row.containers.map(n => option(n)));
  $('previous').checked = false; $('details').hidden = false; $('logs').disabled = row.kind !== 'pods';
  renderRows(); detail();
}
function renderOutput() {
  if (output === null || outputTab !== state.tab) return;
  const root = $('detail-content'), scrollTop = root.scrollTop, scrollLeft = root.scrollLeft;
  const query = $('output-search').value;
  const stats = state.tab === 'logs' ? renderLogs(root, output, { query, severity: $('severity').value })
    : state.tab === 'yaml' ? renderYaml(root, output, query) : renderEvents(root, output, query);
  $('line-count').textContent = `${stats.shown === stats.total ? stats.total : `${stats.shown}/${stats.total}`} ${state.tab === 'events' ? 'events' : 'lines'}`;
  root.scrollTop = state.tab === 'logs' && follow ? root.scrollHeight : scrollTop;
  root.scrollLeft = scrollLeft;
}
function scheduleAuto() {
  clearTimeout(autoTimer);
  if (auto && state.selected && state.tab === 'logs' && !$('previous').checked && !document.hidden) autoTimer = setTimeout(() => detail(true), 3000);
}
async function detail(background = false) {
  if (!state.selected || !state.connected) return;
  clearTimeout(autoTimer);
  const generation = ++state.detailGeneration;
  detailController?.abort(); detailController = new AbortController();
  const tab = state.tab;
  for (const id of ['logs', 'events', 'yaml']) $(id).setAttribute('aria-pressed', String(tab === id));
  for (const id of ['log-options', 'severity', 'auto', 'follow']) $(id).hidden = tab !== 'logs';
  $('auto').disabled = $('previous').checked;
  $('output-search').placeholder = `Find in ${tab}…`;
  $('detail-content').dataset.view = tab;
  $('detail-refresh').disabled = true;
  if (!background) {
    $('detail-status').textContent = 'Loading…';
    if (outputTab !== tab || output === null) { $('detail-content').replaceChildren(element('div', 'Loading output…', 'empty')); $('line-count').textContent = ''; }
  }
  try {
    const data = await request('detail', { ...state.connected, ...state.selected, tab, container: $('container').value, previous: $('previous').checked }, detailController.signal);
    if (generation !== state.detailGeneration) return;
    output = data; outputTab = tab;
    $('detail-status').textContent = tab === 'logs' ? `${auto && !$('previous').checked ? 'Auto · 3s' : 'Snapshot'} · last 200 lines · ${new Date().toLocaleTimeString()}` : `Updated ${new Date().toLocaleTimeString()}`;
    renderOutput();
  } catch (e) { if (generation === state.detailGeneration) { $('detail-status').textContent = e.message || String(e); if (outputTab !== tab || output === null) $('detail-content').replaceChildren(element('div', 'Output could not be loaded. Try Refresh.', 'empty')); } }
  finally { if (generation === state.detailGeneration) { $('detail-refresh').disabled = false; scheduleAuto(); } }
}
$('connect').onclick = connect;
$('refresh').onclick = refresh;
$('filter').oninput = renderRows;
$('close').onclick = () => { clearDetails(); renderRows(); };
$('expand').onclick = () => {
  const expanded = document.querySelector('main').classList.toggle('details-expanded');
  $('expand').setAttribute('aria-pressed', String(expanded)); $('expand').textContent = expanded ? 'Split view' : 'Expand';
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.selected) { clearDetails(); renderRows(); $('workloads').focus(); }
});
for (const kind of ['pods', 'deployments']) $(kind).onclick = () => {
  if (state.kind === kind) return;
  state.kind = kind; state.rows = []; clearDetails(); renderRows();
  for (const id of ['pods', 'deployments']) $(id).setAttribute('aria-pressed', String(kind === id));
  refresh();
};
for (const tab of ['logs', 'events', 'yaml']) $(tab).onclick = () => { state.tab = tab; detail(); };
function changeLogSource() { output = null; outputTab = null; detail(); }
$('container').onchange = changeLogSource; $('previous').onchange = changeLogSource;
$('detail-refresh').onclick = () => detail();
$('output-search').oninput = () => { follow = false; $('follow').setAttribute('aria-pressed', 'false'); renderOutput(); };
$('severity').onchange = renderOutput;
$('auto').onclick = () => { auto = !auto; $('auto').setAttribute('aria-pressed', String(auto)); if (auto) detail(); else { clearTimeout(autoTimer); $('detail-status').textContent = 'Auto refresh paused'; } };
$('follow').onclick = () => { follow = !follow; $('follow').setAttribute('aria-pressed', String(follow)); if (follow) $('detail-content').scrollTop = $('detail-content').scrollHeight; };
$('wrap').onclick = () => { const wrap = $('detail-content').classList.toggle('wrap-output'); $('wrap').setAttribute('aria-pressed', String(wrap)); };
$('detail-content').addEventListener('scroll', () => {
  if (state.tab !== 'logs') return;
  const root = $('detail-content'); follow = root.scrollHeight - root.clientHeight - root.scrollTop < 24;
  $('follow').setAttribute('aria-pressed', String(follow));
});
$('copy').onclick = async () => {
  if (output === null || outputTab !== state.tab) return;
  try {
    await navigator.clipboard.writeText(typeof output === 'string' ? cleanOutput(output) : JSON.stringify(output, null, 2));
    $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  } catch { $('detail-status').textContent = 'Clipboard unavailable. Select output text and copy with Cmd/Ctrl+C.'; }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(autoTimer); else scheduleAuto(); });
$('context').onchange = () => {
  $('namespace').value = state.contexts.find(c => c.name === $('context').value)?.namespace || 'default';
  $('namespaces').replaceChildren(); disconnect();
};
$('namespace').oninput = disconnect;
let preferenceGeneration = 0;
$('workspace').onchange = async () => {
  $('workspace-name').textContent = $('workspace').selectedOptions[0]?.textContent.split(' · ')[0] || 'Choose destination';
  const generation = ++preferenceGeneration;
  disconnect(); clearError();
  if (!$('workspace').value) return;
  try {
    const saved = await request('preferences', { workspaceId: $('workspace').value });
    if (generation !== preferenceGeneration) return;
    if (saved && state.contexts.some(c => c.name === saved.context)) { $('context').value = saved.context; $('namespace').value = saved.namespace; }
  } catch (e) { error(e); }
};
$('k9s').onclick = async () => {
  clearError(); $('k9s').disabled = true;
  try {
    if (!$('workspace').value) throw new Error('Choose an Orca workspace for the k9s terminal.');
    const result = await request('k9s', { ...selection(), kind: state.kind, workspaceId: $('workspace').value });
    if (!result.revealed) {
      $('updated').textContent = 'k9s started in the background.';
      throw new Error(`k9s started, but Orca could not reveal its tab: ${result.message || 'Unknown error'}. Terminal: ${result.terminalId}`);
    }
    $('updated').textContent = 'Showing read-only k9s in the selected workspace.';
  } catch (e) { error(e); } finally { $('k9s').disabled = false; }
};
async function init() {
  renderRows();
  if (!api?.plugin) { error(new Error('Open this panel inside Orca to connect to Kubernetes.')); $('connect').disabled = true; $('k9s').disabled = true; return; }
  try {
    const [config, workspaces, focused] = await Promise.all([request('contexts'), request('workspaces'), api.host.call('workspace.readContext', {})]);
    state.contexts = config.contexts;
    $('context').replaceChildren(...config.contexts.map(c => option(c.name)));
    $('context').value = config.current || config.contexts[0]?.name || '';
    $('namespace').value = config.contexts.find(c => c.name === $('context').value)?.namespace || 'default';
    $('workspace').append(...workspaces.map(w => option(w.id, `${w.name} · ${w.path}`)));
    const matches = workspaces.filter(w => w.name === focused?.displayName);
    if (matches.length === 1) { $('workspace').value = matches[0].id; await $('workspace').onchange(); }
    else $('workspace').closest('details').open = true;
    if (!config.contexts.length) error(new Error('No Kubernetes contexts found. Configure kubectl, then reload the plugin.'));
  } catch (e) { error(e); }
}
init();
