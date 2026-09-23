import { test, expect } from 'bun:test';
import { HelperFrames, NativeStream, type StreamRecord } from '../src/stream';

test('fragmented UTF-8 delta frames are decoded only during drain', () => {
  const frames = new HelperFrames();
  frames.enqueue('READY\nDELTA w5');
  expect(frames.drain()).toEqual([{ kind: 'ready' }]);
  frames.enqueue('Zu\nDONE\n');
  expect(frames.drain()).toEqual([{ kind: 'delta', value: 'Ön' }, { kind: 'done' }]);
});

test('stdout hook queues only; timer opens FIFOs and cancellation crosses the control pipe', async () => {
  let hook: ((chunk: string) => void) | null = null;
  const writes: string[] = [];
  const events: StreamRecord[] = [];
  const host = {
    file: { handle: (path: string) => ({ write: (value: string) => writes.push(`${path}:${value}`), close: () => {} }) },
    utils: { exec: (_path: string, _args: string[], _cwd: null, stdout: (chunk: string) => void) => {
      hook = stdout; return new Promise<{ status: number }>(() => {});
    } }
  };
  const stream = new NativeStream(host, '/package/helper', '/private/request-1', '{"key":"secret"}', record => events.push(record));
  stream.start();
  hook!('READY\n');
  expect(writes).toEqual([]);
  stream.pump();
  expect(writes.some(value => value.includes('/request:{"key":"secret"}'))).toBe(true);
  hook!('DELTA w5Zu\n');
  stream.pump();
  expect(events).toEqual([{ kind: 'delta', value: 'Ön' }]);
  stream.cancel();
  expect(writes.some(value => value.endsWith('/control:STOP\n'))).toBe(true);
  hook!('DELTA bGF0ZQ==\nCANCELLED stop\n');
  stream.pump();
  expect(events).toEqual([{ kind: 'delta', value: 'Ön' }, { kind: 'cancelled', value: 'stop' }]);
});

test('cancellation before READY still sends STOP after private pipes open', () => {
  let hook: (chunk: string) => void = () => {};
  const writes: string[] = [];
  const host = {
    file: { handle: (path: string) => ({ write: (value: string) => writes.push(`${path}:${value}`), close: () => {} }) },
    utils: { exec: (_path: string, _args: string[], _cwd: null, stdout: (chunk: string) => void) => {
      hook = stdout; return new Promise<{ status: number }>(() => {});
    } }
  };
  const stream = new NativeStream(host, '/helper', '/private/2', '{"key":"secret"}', () => {});
  stream.start();
  stream.cancel();
  hook('READY\n');
  stream.pump();
  expect(writes).toContain('/private/2/request:{}');
  expect(writes.some(value => value.includes('secret'))).toBe(false);
  expect(writes).toContain('/private/2/control:STOP\n');
});
