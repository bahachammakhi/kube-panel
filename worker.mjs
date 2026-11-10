import { binary, createKubernetes, execute, k9sCommand, target } from './kubernetes.mjs';
const isLocal = w => w.hostId == null || w.hostId === 'local';

export async function revealTerminal(terminalId, run = execute) {
  // The plugin host API only creates background terminals. The supported Orca
  // CLI can adopt that terminal into a visible tab and select it.
  const cli = process.env.ORCA_CLI_COMMAND || binary(process.platform === 'linux' ? 'orca-ide' : 'orca');
  const result = JSON.parse(await run(cli, ['terminal', 'switch', '--terminal', terminalId, '--json']));
  if (!result.ok || result.result?.focus?.navigated !== true) {
    throw new Error(result.error?.message || 'No Orca window could show the terminal.');
  }
}

export default function activate(orca, { revealTerminal: reveal = revealTerminal } = {}) {
  const kube = createKubernetes();
  for (const name of ['contexts', 'namespaces', 'workloads', 'detail']) {
    orca.panels.handle(`kube.${name}`, (input, { signal }) => name === 'contexts' ? kube.contexts({ signal }) : kube[name](input, { signal }));
  }
  orca.panels.handle('kube.workspaces', async () => {
    const { workspaces } = await orca.host.call('workspace.list', {});
    return workspaces.filter(isLocal).map(({ id, name, path }) => ({ id, name, path }));
  });
  async function workspace(id) {
    const { workspaces } = await orca.host.call('workspace.list', {});
    if (!workspaces.some(w => w.id === id && isLocal(w))) throw new Error('Choose a local Orca workspace.');
    return id;
  }
  orca.panels.handle('kube.preferences', async ({ workspaceId, selection }) => {
    const key = `selection:${await workspace(workspaceId)}`;
    if (selection) {
      const selected = target(selection);
      await orca.host.call('storage.set', { key, value: selected });
      return selected;
    }
    return (await orca.host.call('storage.get', { key })).value;
  });
  orca.panels.handle('kube.k9s', async ({ workspaceId, ...input }) => {
    const { terminalId } = await orca.host.call('terminal.create', { workspaceId: await workspace(workspaceId), title: `k9s · ${input.context}`, command: k9sCommand(input) });
    try {
      await reveal(terminalId);
      return { terminalId, revealed: true };
    } catch (error) {
      return { terminalId, revealed: false, message: error.message };
    }
  });
}
