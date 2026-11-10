// Render untrusted cluster output using text nodes only.
const node = (tag, text = '', className = '') => {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
};
export function cleanOutput(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}
export function parseLog(raw, index = 0) {
  const line = cleanOutput(raw);
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))\s(.*)$/);
  const timestamp = match?.[1] || '';
  const body = match?.[2] ?? line;
  let json = null;
  try { const parsed = JSON.parse(body); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed; } catch {}
  const rawLevel = json?.level ?? json?.severity ?? json?.log?.level;
  const levels = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal', warning: 'warn', critical: 'fatal' };
  let level = levels[rawLevel] || String(rawLevel || '').toLowerCase();
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal'].includes(level)) {
    level = (body.match(/\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b/i)?.[1] || '').toLowerCase();
    if (level === 'warning') level = 'warn';
  }
  const message = json?.msg ?? json?.message ?? body.replace(/^\[?(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\]?\s*[:|\-]?\s+/i, '');
  return { index: index + 1, timestamp, time: timestamp ? timestamp.slice(11, 19) : '', level,
    message: typeof message === 'string' ? message : JSON.stringify(message), json, raw: line };
}
function highlight(el, text, query) {
  if (!query) { el.textContent = text; return; }
  let from = 0, at;
  const lower = text.toLowerCase(), needle = query.toLowerCase();
  while ((at = lower.indexOf(needle, from)) !== -1) {
    el.append(document.createTextNode(text.slice(from, at)), node('mark', text.slice(at, at + query.length)));
    from = at + query.length;
  }
  el.append(document.createTextNode(text.slice(from)));
}
export function renderLogs(root, output, { query = '', severity = 'all' } = {}) {
  const raw = cleanOutput(output).replace(/\n$/, '');
  const entries = raw ? raw.split('\n').map(parseLog) : [];
  const filtered = entries.filter(e => (severity === 'all' || (severity === 'error' ? ['error', 'fatal'].includes(e.level) : severity === e.level))
    && e.raw.toLowerCase().includes(query.toLowerCase()));
  const fragment = document.createDocumentFragment();
  for (const entry of filtered) {
    const row = node(entry.json ? 'details' : 'div', '', `log-entry level-${entry.level || 'plain'}`);
    const line = node(entry.json ? 'summary' : 'div', '', 'log-line');
    line.append(node('span', String(entry.index), 'line-number'));
    const time = node('time', entry.time, 'log-time'); time.title = entry.timestamp; line.append(time);
    line.append(node('span', entry.level ? entry.level.toUpperCase() : '—', 'log-level'));
    const message = node('span', '', 'log-message'); highlight(message, entry.message, query); line.append(message);
    row.append(line);
    if (entry.json) { row.title = 'Expand structured log fields'; row.append(node('pre', JSON.stringify(entry.json, null, 2), 'json-fields')); }
    fragment.append(row);
  }
  if (!filtered.length) fragment.append(node('div', entries.length ? 'No log lines match these filters.' : 'No log output yet.', 'empty'));
  root.replaceChildren(fragment);
  return { total: entries.length, shown: filtered.length };
}
export function renderYaml(root, output, query = '') {
  const lines = cleanOutput(output).replace(/\n$/, '').split('\n');
  const fragment = document.createDocumentFragment();
  let shown = 0;
  lines.forEach((line, index) => {
    if (query && !line.toLowerCase().includes(query.toLowerCase())) return;
    shown++;
    const row = node('div', '', 'yaml-line'); row.append(node('span', String(index + 1), 'line-number'));
    const code = node('span', '', 'yaml-code');
    if (query) highlight(code, line, query);
    else {
      const key = line.match(/^(\s*(?:- )?)([\w.\/-]+)(:\s*)(.*)$/);
      if (key) { code.append(document.createTextNode(key[1]), node('span', key[2], 'yaml-key'), document.createTextNode(key[3]), node('span', key[4], /^(true|false|null|\d+)$/.test(key[4]) ? 'yaml-value' : '')); }
      else code.textContent = line;
    }
    row.append(code); fragment.append(row);
  });
  if (!shown) fragment.append(node('div', 'No YAML lines match your search.', 'empty'));
  root.replaceChildren(fragment);
  return { total: lines.length, shown };
}
export function renderEvents(root, events, query = '') {
  const filtered = events.filter(e => `${e.type} ${e.reason} ${e.message}`.toLowerCase().includes(query.toLowerCase()));
  const fragment = document.createDocumentFragment();
  for (const event of filtered) {
    const card = node('article', '', `event ${event.type === 'Warning' ? 'event-warning' : ''}`);
    const header = node('div', '', 'event-heading');
    header.append(node('span', event.type || 'Normal', 'event-type'), node('strong', event.reason || 'Event'), node('span', `×${event.count}`, 'event-count'));
    const message = node('p'); highlight(message, event.message || '', query);
    card.append(header, message, node('time', event.at ? new Date(event.at).toLocaleString() : 'Unknown time', 'hint')); fragment.append(card);
  }
  if (!filtered.length) fragment.append(node('div', events.length ? 'No events match your search.' : 'No events recorded for this resource.', 'empty'));
  root.replaceChildren(fragment);
  return { total: events.length, shown: filtered.length };
}
