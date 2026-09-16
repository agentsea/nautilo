import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  parseReadyTimeoutMs,
  runWithCleanup,
} from '../../scripts/ime-browser-policy.mjs';

describe('IME browser readiness policy', () => {
  it.each([undefined, '', '0', '-1', '1.5', 'abc', '2147483648'])(
    'rejects invalid caller deadline %s',
    (value) => expect(() => parseReadyTimeoutMs(value)).toThrow(/IME_BROWSER_READY_TIMEOUT_MS/),
  );

  it('accepts a caller-owned positive integer deadline', () => {
    expect(parseReadyTimeoutMs('27500')).toBe(27500);
  });

  it('closes every owned resource after readiness rejects', async () => {
    const events: string[] = [];
    const closePage = vi.fn(async () => { events.push('page'); });
    const closeBrowser = vi.fn(async () => { events.push('browser'); });
    const closeServer = vi.fn(async () => { events.push('server'); });

    await expect(runWithCleanup(
      async () => { throw new Error('bridge readiness expired'); },
      [closePage, closeBrowser, closeServer],
    )).rejects.toThrow('bridge readiness expired');
    expect(events).toEqual(['page', 'browser', 'server']);
  });

  it('continues cleanup after one close fails and reports both failures', async () => {
    const lastClose = vi.fn(async () => undefined);
    try {
      await runWithCleanup(
        async () => { throw new Error('readiness failed'); },
        [async () => { throw new Error('browser close failed'); }, lastClose],
      );
      throw new Error('expected cleanup failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      const messages = (error as AggregateError).errors.map((item: unknown) =>
        item instanceof Error ? item.message : String(item));
      expect(messages).toEqual(['readiness failed', 'browser close failed']);
    }
    expect(lastClose).toHaveBeenCalledOnce();
  });

  it('retains an explicit undefined rejection while still cleaning up', async () => {
    const close = vi.fn(async () => undefined);
    await expect(runWithCleanup(
      // Deliberately exercise JavaScript's legal non-Error rejection edge case.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      () => Promise.reject(undefined),
      [close],
    )).rejects.toEqual(new AggregateError([undefined], 'IME verification failed'));
    expect(close).toHaveBeenCalledOnce();
  });

  it('continues after a cleanup throws synchronously', async () => {
    const lastClose = vi.fn(async () => undefined);
    await expect(runWithCleanup(
      async () => undefined,
      [() => { throw new Error('synchronous close failed'); }, lastClose],
    )).rejects.toThrow('IME verification cleanup failed');
    expect(lastClose).toHaveBeenCalledOnce();
  });

  it('terminates owned process and HTTP resources after readiness rejects', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const server = createServer((_request, response) => response.end('not ready'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    await expect(runWithCleanup(
      async () => { throw new Error('controlled readiness rejection'); },
      [
        async () => {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        },
        async () => {
          await new Promise<void>((resolve, reject) => server.close((error) => {
            if (error) reject(error);
            else resolve();
          }));
        },
      ],
    )).rejects.toThrow('controlled readiness rejection');

    expect(child.exitCode ?? child.signalCode).not.toBeNull();
    expect(server.listening).toBe(false);
  });
});
