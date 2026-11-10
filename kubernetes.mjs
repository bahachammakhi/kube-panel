import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export function binary(name) {
  // GUI applications on macOS may not inherit Homebrew's PATH.
  for (const directory of (process.env.PATH || '').split(':').concat(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'])) {
    if (directory && existsSync(`${directory}/${name}`)) return `${directory}/${name}`;
  }
  return name;
}

export function execute(file, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { signal, timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, PATH: `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin` } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      if (error.name === 'AbortError') return reject(Object.assign(new Error('Request cancelled.'), { code: 'cancelled' }));
      const message = error.code === 'ENOENT' ? `${file} was not found. Install kubectl and k9s, then restart the plugin.`
        : error.killed ? 'The cluster did not respond within 20 seconds. Check your VPN and cluster credentials.'
        : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'The response is too large. Choose a smaller namespace.'
        : (stderr.trim() || error.message).slice(0, 2000);
      reject(Object.assign(new Error(message), { code: 'action_failed' }));
    });
  });
}

function text(value, label, pattern = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/) {
  if (typeof value !== 'string' || value.length > 253 || !pattern.test(value)) {
    throw Object.assign(new Error(`Choose a valid ${label}.`), { code: 'invalid_params' });
  }
  return value;
}
export function target(input) {
  const context = text(input.context, 'context', /^[^\s\x00-\x1f\x7f]+$/);
  if (context.startsWith('-')) throw new Error('Invalid context.');
  const namespace = input.namespace === '*' ? '*' : text(input.namespace, 'namespace');
  return { context, namespace };
}
function scope(input) {
  const { context, namespace } = target(input);
  return [`--context=${context}`, '--request-timeout=15s', ...(namespace === '*' ? ['--all-namespaces'] : [`--namespace=${namespace}`])];
}
function resource(input) {
  if (!['pods', 'deployments'].includes(input.kind)) throw new Error('Unsupported resource type.');
  if (input.namespace === '*') throw new Error('Choose the resource namespace.');
  return [input.kind, text(input.name, 'resource name')];
}
export function summarize(item) {
  const pod = item.kind === 'Pod';
  const statuses = item.status?.containerStatuses || [];
  const waiting = statuses.find(s => s.state?.waiting)?.state.waiting.reason;
  const terminated = statuses.find(s => s.state?.terminated && s.state.terminated.exitCode !== 0)?.state.terminated.reason;
  const desired = pod ? (item.spec?.containers || []).length : (item.spec?.replicas ?? 1);
  const ready = pod ? statuses.filter(s => s.ready).length : (item.status?.readyReplicas || 0);
  const status = item.metadata.deletionTimestamp ? 'Terminating' : pod ? (waiting || terminated || item.status?.phase || 'Unknown')
    : desired === 0 ? 'Scaled to zero' : ready >= desired ? 'Available' : 'Progressing';
  return { kind: pod ? 'pods' : 'deployments', name: item.metadata.name, namespace: item.metadata.namespace,
    uid: item.metadata.uid, status, ready: `${ready}/${desired}`, restarts: statuses.reduce((n, s) => n + (s.restartCount || 0), 0),
    createdAt: item.metadata.creationTimestamp, containers: pod ? (item.spec?.containers || []).map(c => c.name) : [],
    healthy: pod ? status === 'Succeeded' || status === 'Running' && ready === desired : ready >= desired };
}
export function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
export function k9sCommand(input) {
  const { context, namespace } = target(input);
  return [binary('k9s'), '--context', context, ...(namespace === '*' ? ['--all-namespaces'] : ['--namespace', namespace]),
    '--command', input.kind === 'deployments' ? 'deployments' : 'pods', '--readonly'].map(shellQuote).join(' ');
}
export function createKubernetes(run = (args, options) => execute(binary('kubectl'), args, options)) {
  const json = async (args, options) => JSON.parse(await run(args, options));
  return {
    async contexts(options) {
      // Only retain context names and namespace defaults; never return credentials to the panel.
      const data = await json(['config', 'view', '-o', 'json'], options);
      return { current: data['current-context'] || '', contexts: (data.contexts || []).map(c => ({ name: c.name, namespace: c.context?.namespace || 'default' })) };
    },
    async namespaces(input, options) {
      const { context } = target(input);
      const data = await json([`--context=${context}`, '--request-timeout=15s', 'get', 'namespaces', '-o', 'json'], options);
      return (data.items || []).map(n => n.metadata.name).sort();
    },
    async workloads(input, options) {
      if (!['pods', 'deployments'].includes(input.kind)) throw new Error('Unsupported resource type.');
      const data = await json([...scope(input), 'get', input.kind, '-o', 'json'], options);
      return (data.items || []).map(summarize);
    },
    async detail(input, options) {
      const ref = resource(input), args = scope(input);
      if (input.tab === 'yaml') {
        const yaml = await run([...args, 'get', ...ref, '-o', 'yaml', '--show-managed-fields=false'], options);
        if (Buffer.byteLength(yaml) > 512 * 1024) throw new Error('Resource YAML exceeds the 512 KiB display limit. Inspect it in k9s.');
        return yaml;
      }
      if (input.tab === 'events') {
        const data = await json([...args, 'get', 'events', `--field-selector=involvedObject.uid=${text(input.uid, 'resource UID')}`, '-o', 'json'], options);
        return (data.items || []).map(e => ({ type: e.type, reason: e.reason, message: e.message,
          count: e.count || 1, at: e.lastTimestamp || e.eventTime || e.metadata.creationTimestamp })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
      }
      if (input.tab !== 'logs' || input.kind !== 'pods') throw new Error('Select a pod to view logs.');
      const container = text(input.container, 'container');
      return run([...args, 'logs', input.name, `--container=${container}`, '--tail=200', '--limit-bytes=65536', '--timestamps=true', ...(input.previous ? ['--previous'] : [])], options);
    }
  };
}
