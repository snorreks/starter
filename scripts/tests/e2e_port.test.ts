import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { resolveE2EPort } from '../src/shared/e2e_port.ts';

let occupied: Server | undefined;

afterEach(async () => {
  if (occupied?.listening) {
    await new Promise<void>((resolve) => occupied?.close(() => resolve()));
  }
  occupied = undefined;
});

describe('per-run E2E ports', () => {
  test('different run identities derive different candidate ports', async () => {
    const first = await resolveE2EPort('e2e_first', undefined, '/checkout');
    const second = await resolveE2EPort('e2e_second', undefined, '/checkout');

    expect(first).not.toBe(second);
  });

  test('a busy explicitly requested port fails before startup', async () => {
    occupied = createServer();
    await new Promise<void>((resolve) => occupied?.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected TCP port');
    }

    await expect(resolveE2EPort('e2e_busy', String(address.port), '/checkout')).rejects.toThrow(
      new RegExp(`port ${address.port} is already in use`),
    );
  });

  test('malformed explicit ports are refused', async () => {
    await expect(resolveE2EPort('e2e_invalid', '0', '/checkout')).rejects.toThrow(
      /E2E_APP_PORT must be an integer between 1 and 65535/,
    );
  });
});
