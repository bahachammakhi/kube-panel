import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKubernetes, k9sCommand, summarize, execute } from '../kubernetes.mjs';
import activate, { revealTerminal } from '../worker.mjs';

test('all cluster reads pin context and never run a shell or mutate kubeconfig', async () => {
  const calls = [];
  const kube = createKubernetes(async args => { calls.push(args); return JSON.stringify({ items: [] }); });
  const input = { context: 'my-cluster;$(id)', namespace: 'demo', kind: 'pods', name: 'app-123', uid: 'a-b-123', container: 'app' };
  await kube.namespaces(input); await kube.workloads(input);
  for (const tab of ['logs', 'events', 'yaml']) await kube.detail({ ...input, tab });
  for (const args of calls) {
    assert.equal(args[0], `--context=${input.context}`);
    assert.ok(args.includes('--request-timeout=15s'));
    assert.ok(!args.includes('use-context'));
    assert.ok(args.includes('get') || args.includes('logs'));
  }
  assert.ok(calls.at(-3).includes('--tail=200'));
});
test('rejects unsupported resources and flag injection', async () => {
  const kube = createKubernetes(() => assert.fail('must reject before executing'));
  await assert.rejects(kube.workloads({ context: 'x', namespace: 'demo', kind: 'secrets' }));
  await assert.rejects(kube.detail({ context: 'x', namespace: 'demo', kind: 'pods', name: '--help', tab: 'yaml' }));
});
test('k9s uses shell escaping and read-only mode', () => {
  const command = k9sCommand({ context: "cluster'one", namespace: '*', kind: 'pods' });
  assert.ok(command.includes("'cluster'\\''one'"));
  assert.ok(command.includes("'--readonly'"));
  assert.ok(command.includes("'--all-namespaces'"));
});
test('context response excludes credentials', async () => {
  const kube = createKubernetes(async () => JSON.stringify({ users: [{ token: 'do-not-return' }], contexts: [{ name: 'dev', context: { namespace: 'apps', user: 'secret' } }], 'current-context': 'dev' }));
  assert.deepEqual(await kube.contexts(), { current: 'dev', contexts: [{ name: 'dev', namespace: 'apps' }] });
});
test('waiting pods and scaled-to-zero deployments have accurate readiness', () => {
  assert.equal(summarize({ kind: 'Pod', metadata: { name: 'bad' }, spec: { containers: [{}] }, status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } }, restartCount: 5 }] } }).status, 'CrashLoopBackOff');
  const deployment = summarize({ kind: 'Deployment', metadata: { name: 'off' }, spec: { replicas: 0 } });
  assert.equal(deployment.status, 'Scaled to zero'); assert.equal(deployment.healthy, true);
});
test('actual child process abort propagates as cancellation', async () => {
  const controller = new AbortController();
  const result = execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: 'cancelled' });
});
test('worker refuses k9s terminal creation in remote or unknown workspaces', async () => {
  const handlers = new Map();
  const calls = [];
  const revealed = [];
  activate({ panels: { handle: (name, handler) => handlers.set(name, handler) }, host: { call: async (name, input) => {
    calls.push({ name, input });
    if (name === 'workspace.list') return { workspaces: [{ id: 'remote', hostId: 'server' }, { id: 'local', hostId: 'local' }] };
    if (name === 'terminal.create') return { terminalId: 'new' };
  } } }, { revealTerminal: async id => { revealed.push(id); } });
  const input = { context: 'dev', namespace: 'apps', kind: 'pods' };
  await assert.rejects(handlers.get('kube.k9s')({ ...input, workspaceId: 'remote' }));
  assert.ok(!calls.some(c => c.name === 'terminal.create'));
  assert.deepEqual(await handlers.get('kube.k9s')({ ...input, workspaceId: 'local' }), { terminalId: 'new', revealed: true });
  assert.deepEqual(revealed, ['new'], 'opening k9s must reveal its terminal');
});
test('reveal requires confirmed navigation, not only successful CLI execution', async () => {
  await revealTerminal('term-demo', async (_file, args) => {
    assert.deepEqual(args, ['terminal', 'switch', '--terminal', 'term-demo', '--json']);
    return JSON.stringify({ ok: true, result: { focus: { navigated: true } } });
  });
  await assert.rejects(revealTerminal('term-demo', async () => JSON.stringify({ ok: true, result: { focus: { navigated: false } } })), /No Orca window/);
});
