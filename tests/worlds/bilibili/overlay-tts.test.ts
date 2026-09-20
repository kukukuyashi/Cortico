import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/core/types.ts';
import { OverlayAssetStore } from '../../../src/worlds/bilibili/overlay/assets.ts';
import { BilibiliOverlayServer, type BilibiliOverlayEditorActions } from '../../../src/worlds/bilibili/overlay/server.ts';

const roots: string[] = [];
const upstreams: Server[] = [];
const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as Logger;

afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const upstream of upstreams.splice(0)) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('Bilibili Overlay TTS 代理', () => {
  it('把 text 与配置参数转发给上游并回传音频,相同请求命中缓存', async () => {
    const hits: string[] = [];
    const upstream = await stubUpstream((url, res) => {
      hits.push(url);
      res.writeHead(200, { 'Content-Type': 'audio/wav' }).end(Buffer.from('RIFF-fake-audio'));
    });
    const server = overlayServer({ enabled: true, apiUrl: `${upstream}/tts`, params: 'ref_audio_path=voice.wav&text_lang=all_zh' });
    await server.start(log);
    try {
      const first = await fetch(`${server.baseUrl}/api/tts?text=${encodeURIComponent('大家好')}`);
      expect(first.status).toBe(200);
      expect(first.headers.get('content-type')).toBe('audio/wav');
      expect(await first.text()).toBe('RIFF-fake-audio');
      expect(hits).toHaveLength(1);
      const sent = new URL(hits[0], 'http://stub.local');
      expect(sent.searchParams.get('text')).toBe('大家好');
      expect(sent.searchParams.get('ref_audio_path')).toBe('voice.wav');
      expect(sent.searchParams.get('text_lang')).toBe('all_zh');

      const second = await fetch(`${server.baseUrl}/api/tts?text=${encodeURIComponent('大家好')}`);
      expect(second.status).toBe(200);
      expect(await second.text()).toBe('RIFF-fake-audio');
      expect(hits).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('未启用、空文本与上游失败分别回 503、400、502', async () => {
    const upstream = await stubUpstream((url, res) => {
      res.writeHead(500).end('boom');
    });
    const disabled = overlayServer({ enabled: false, apiUrl: `${upstream}/tts`, params: '' });
    await disabled.start(log);
    try {
      const res = await fetch(`${disabled.baseUrl}/api/tts?text=x`);
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toContain('application/json');
    } finally {
      await disabled.stop();
    }

    const server = overlayServer({ enabled: true, apiUrl: `${upstream}/tts`, params: '' });
    await server.start(log);
    try {
      expect((await fetch(`${server.baseUrl}/api/tts?text=`)).status).toBe(400);
      const res = await fetch(`${server.baseUrl}/api/tts?text=x`);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('500') });
    } finally {
      await server.stop();
    }
  });
});

async function stubUpstream(handler: (url: string, res: import('node:http').ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => handler(req.url ?? '/', res));
  upstreams.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function overlayServer(tts: { enabled: boolean; apiUrl: string; params: string }): BilibiliOverlayServer {
  const root = mkdtempSync(join(tmpdir(), 'bilibili-overlay-tts-'));
  roots.push(root);
  const assets = new OverlayAssetStore(join(root, 'assets'));
  const editor: BilibiliOverlayEditorActions = {
    state: () => ({}),
    saveDesign: () => ({}),
    importAsset: () => ({}),
    deleteAsset: () => ({}),
    setAgentAnnouncement: () => ({}),
  };
  return new BilibiliOverlayServer({
    preferredPort: 0,
    assets,
    tts: { enabled: tts.enabled, apiUrl: tts.apiUrl, params: tts.params, timeoutMs: 5000, maxChars: 600 },
    snapshot: () => ({ design: { schemaVersion: 1 }, agentAnnouncement: { text: '' } }),
    editor,
  });
}
