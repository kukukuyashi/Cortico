/**
 * QQWorld 生命周期:首次就绪投 qq.online(reconnected=false),断线重连再投一条
 * 且 reconnected=true;stop() 在断开前向每个监听群发 offlineNotice,空串不发。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockNapCat } from '../../helpers/mock-napcat.ts';
import { QQWorld } from '../../../src/worlds/qq/world.ts';
import { FakeHost, waitUntil } from './helpers.ts';

const GROUP = 424242;
const GROUP2 = 777777;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function makeMock(port = 0) {
  const mock = new MockNapCat({ port, groupId: GROUP, groupName: '深夜食堂' });
  cleanups.push(() => mock.close());
  return mock;
}

async function startWorld(port: number, extra: { groups?: number[]; offlineNotice?: string } = {}) {
  const host = new FakeHost();
  const mod = new QQWorld({
    wsUrl: `ws://127.0.0.1:${port}`,
    groups: extra.groups ?? [GROUP],
    privates: [],
    token: '',
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
    ...(extra.offlineNotice !== undefined ? { offlineNotice: extra.offlineNotice } : {}),
  });
  await mod.start(host);
  await mod.waitReady();
  cleanups.push(() => mod.stop());
  return { mod, host };
}

describe('QQWorld 生命周期', () => {
  it('首次连上投 qq.online,reconnected=false', async () => {
    const mock = makeMock();
    const port = await mock.start();
    const { host } = await startWorld(port);

    const ev = host.pushed.find((p) => p.event.type === 'qq.online');
    expect(ev).toBeDefined();
    expect(ev!.event.meta?.reconnected).toBe(false);
  });

  it('断线重连再投 qq.online,reconnected=true', async () => {
    const mock1 = makeMock();
    const port = await mock1.start();
    const { host } = await startWorld(port);
    expect(host.pushed.filter((p) => p.event.type === 'qq.online')).toHaveLength(1);

    await mock1.close();
    const mock2 = makeMock(port);
    await mock2.start();
    await waitUntil(
      () => host.pushed.filter((p) => p.event.type === 'qq.online').length === 2,
      '重连后再投一条上线事件',
    );
    const second = host.pushed.filter((p) => p.event.type === 'qq.online')[1];
    expect(second.event.meta?.reconnected).toBe(true);
  });

  it('stop() 断开前向每个监听群发 offlineNotice', async () => {
    const mock = makeMock();
    const port = await mock.start();
    const { mod } = await startWorld(port, { groups: [GROUP, GROUP2], offlineNotice: '下线了喵' });

    await mod.stop();

    const sent = mock.outbox.filter((o) => o.action === 'send_group_msg');
    expect(sent.map((o) => o.params.group_id).sort()).toEqual([GROUP, GROUP2].sort());
    const first = sent[0].params.message as Array<{ type: string; data: { text?: string } }>;
    expect(first[0].type).toBe('text');
    expect(first[0].data.text).toBe('下线了喵');
  });

  it('offlineNotice 缺省/空白时 stop 不发言', async () => {
    const mock = makeMock();
    const port = await mock.start();
    const { mod } = await startWorld(port, { offlineNotice: '   ' });

    await mod.stop();

    expect(mock.outbox.filter((o) => o.action === 'send_group_msg')).toHaveLength(0);
  });
});
