/**
 * 挂载面板的启停按钮被受管服务器开关挡住时,先拨开关再重试;
 * 开关开着且托管进程已死(异常/未启动)时停止仍然可按。
 */
import { describe, it, expect } from 'vitest';
import { doc, flush } from './provider-settings-fixture.ts';

const UI = '../../src/web/client/ui/index.ts';
const MOUNT_PANEL = '../../src/worlds/minecraft/console/mount.ts';
type Any = any;

const SERVER_KEY = 'worlds.minecraft.local.serverEnabled';

interface FakeServer {
  enabled: boolean;
  managed: boolean;
  phase: string;
  detail: string | null;
}

function serverState(s: FakeServer, detail: string | null = s.detail): Any {
  return {
    managed: s.managed, enabled: s.enabled, phase: s.phase,
    address: '127.0.0.1:25565', detail, pid: ['stopped', 'error'].includes(s.phase) ? null : 8,
    reachable: s.phase === 'running', serverDir: s.managed ? 'C:\\mc' : '', configured: s.managed,
  };
}

const CLIENT_DOWN = {
  phase: 'stopped', enabled: false, detail: null, pid: null, windowReady: false,
  gameDir: '', versionId: '', username: '', configured: false, command: null,
};

interface Mounted {
  root: Any;
  calls: Array<{ groupId: string; values: Any }>;
  invokes: string[];
  cleanup(): void;
}

/** 挂挂载面板;server 行为由 srv 的当前字段决定,模拟服务端那道开关闸。 */
async function mountMountPanel(srv: FakeServer): Promise<Mounted> {
  const calls: Mounted['calls'] = [];
  const invokes: string[] = [];
  const { createConsoleUi } = (await import(UI)) as Any;
  const { mountPanel } = (await import(MOUNT_PANEL)) as Any;
  const controller = new doc.defaultView.AbortController();
  const root = doc.createElement('div');
  doc.body.append(root);
  const ui = createConsoleUi({
    memo: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
    overlayHost: doc.body, signal: controller.signal, doc,
  });
  mountPanel.mount({
    root, ui, language: 'zh', signal: controller.signal, scope: {},
    memo: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
    invoke: async (method: string) => {
      invokes.push(method);
      if (method === 'server.state') return serverState(srv);
      if (method === 'server.start') {
        if (srv.managed && !srv.enabled) return serverState(srv, '受管服务器开关已关闭');
        srv.phase = 'running';
        return serverState(srv);
      }
      if (method === 'server.stop') {
        if (srv.managed && srv.enabled) return serverState(srv, '受管服务器开关仍开启');
        srv.phase = 'stopped';
        return serverState(srv);
      }
      if (method === 'client.state' || method === 'player.state') return { ...CLIENT_DOWN };
      throw new Error(`unexpected ${method}`);
    },
    setConfig: async (groupId: string, values: Any) => {
      calls.push({ groupId, values });
      if (SERVER_KEY in values) srv.enabled = values[SERVER_KEY] as boolean;
      return '';
    },
    pickPath: async () => null,
    interval: (fn: () => void) => {
      let n = 0;
      const t = setInterval(() => { if (++n > 12) { clearInterval(t); return; } fn(); }, 0);
      return { dispose: () => clearInterval(t) };
    },
    refresh: async () => {},
    mountSlot: async () => ({ dispose() {} }),
  });
  await flush();
  return { root, calls, invokes, cleanup: () => { controller.abort(); root.remove(); } };
}

function rowButton(root: Any, rowName: string, label: string): Any {
  const row = [...root.querySelectorAll('.mountrow')]
    .find((r: Any) => r.textContent?.includes(rowName));
  return [...row.querySelectorAll('button')].find((b: Any) => b.textContent === label);
}

describe('挂载面板 · 受管服务器开关挡闸', () => {
  it('开关开着时点停止:先拨掉开关再停服', async () => {
    const srv: FakeServer = { enabled: true, managed: true, phase: 'running', detail: null };
    const panel = await mountMountPanel(srv);
    try {
      rowButton(panel.root, '游戏服务器', '停止').click();
      await flush();
      expect(panel.calls).toEqual([
        { groupId: 'world:minecraft', values: { [SERVER_KEY]: false } },
      ]);
      expect(panel.invokes.filter((m) => m === 'server.stop')).toHaveLength(2);
      expect(srv.phase).toBe('stopped');
    } finally {
      panel.cleanup();
    }
  });

  it('开关关着时点启动:先拨开开关再启动', async () => {
    const srv: FakeServer = { enabled: false, managed: true, phase: 'stopped', detail: null };
    const panel = await mountMountPanel(srv);
    try {
      rowButton(panel.root, '游戏服务器', '启动').click();
      await flush();
      expect(panel.calls).toEqual([
        { groupId: 'world:minecraft', values: { [SERVER_KEY]: true } },
      ]);
      expect(panel.invokes.filter((m) => m === 'server.start')).toHaveLength(2);
      expect(srv.phase).toBe('running');
    } finally {
      panel.cleanup();
    }
  });

  it('外部(非受管)服务器按停止不碰开关配置', async () => {
    const srv: FakeServer = { enabled: true, managed: false, phase: 'running', detail: null };
    const panel = await mountMountPanel(srv);
    try {
      rowButton(panel.root, '游戏服务器', '停止').click();
      await flush();
      expect(panel.calls).toEqual([]);
      expect(panel.invokes.filter((m) => m === 'server.stop')).toHaveLength(1);
    } finally {
      panel.cleanup();
    }
  });

  it('开关开着但进程已死:停止仍可按,按下拨掉开关', async () => {
    const srv: FakeServer = { enabled: true, managed: true, phase: 'error', detail: '进程退出 code=1' };
    const panel = await mountMountPanel(srv);
    try {
      const stop = rowButton(panel.root, '游戏服务器', '停止');
      expect(stop.disabled).toBe(false);
      stop.click();
      await flush();
      expect(panel.calls).toEqual([
        { groupId: 'world:minecraft', values: { [SERVER_KEY]: false } },
      ]);
    } finally {
      panel.cleanup();
    }
  });
});
