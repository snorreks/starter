// apps/frontend/client/scripts/dev_ports.test.ts
//
// The dev ports, and what an environment override is allowed to do to them.
//
// `PORT` exists so two checkouts can run side by side, so it has to be read — but
// `Number(process.env.PORT)` accepted anything. Two of those anything-values were
// silent:
//
//   * `PORT=5174x`      -> `NaN`, which reaches the proxy target and the `tauri
//                          dev` port comparison as a number that is not a port.
//   * `PORT=`           -> `0`. `PORT=` is an ordinary shell leftover, and 0 tells
//                          Vite to bind an arbitrary port while `tauri.conf.json`
//                          still says 5173. The blank webview that follows names
//                          neither file.
//
// So the reader is exercised here against the real module, with the environment
// set first and the import afterwards. Bun keys its module registry on the
// specifier including the query, so `?case=3` really is a second evaluation of the
// same file — the alternative would be asserting on a helper instead of on the
// constant the rest of the client reads.

import { afterEach, describe, expect, test } from 'bun:test';

const PORTS = ['PORT', 'API_PORT'] as const;
const saved: Record<string, string | undefined> = {};

for (const name of PORTS) {
  saved[name] = process.env[name];
}

afterEach(() => {
  for (const name of PORTS) {
    if (saved[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[name];
    }
  }
});

let cases = 0;

/** Evaluate `dev_ports.ts` with this environment in place. */
const loadPorts = async (env: Partial<Record<(typeof PORTS)[number], string>>) => {
  for (const name of PORTS) {
    const value = env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  cases += 1;
  return import(`../dev_ports.ts?case=${cases}`);
};

describe('dev port environment overrides', () => {
  test('unset ports are the defaults', async () => {
    const ports = await loadPorts({});

    expect(ports.CLIENT_DEV_PORT).toBe(5173);
    expect(ports.API_DEV_PORT).toBe(8787);
  });

  test('an empty value is an absence, not port zero', async () => {
    // The specific leftover this exists for. `PORT=` used to become 0, and Vite
    // binds a random port for 0 — which then disagrees with the devUrl literal in
    // tauri.conf.json. Whitespace counts as empty for the same reason: it is a
    // leftover, not a port somebody chose.
    const ports = await loadPorts({ PORT: '', API_PORT: '   ' });

    expect(ports.CLIENT_DEV_PORT).toBe(5173);
    expect(ports.API_DEV_PORT).toBe(8787);
  });

  test('a valid port is used verbatim', async () => {
    const ports = await loadPorts({ PORT: '6100', API_PORT: '8800' });
    expect(ports.CLIENT_DEV_PORT).toBe(6100);
    expect(ports.API_DEV_PORT).toBe(8800);
  });

  test('a value that is not a port is refused by name', async () => {
    // Refused rather than replaced: a typo in PORT must not silently become the
    // default, because that looks like it worked.
    for (const bad of ['5173x', 'port', '0', '-1', '65536', '1.5', 'NaN', '123 456']) {
      await expect(loadPorts({ PORT: bad })).rejects.toThrow(/PORT=/);
      await expect(loadPorts({ API_PORT: bad })).rejects.toThrow(/API_PORT=/);
    }
  });

  test('the boundaries are usable ports', async () => {
    expect((await loadPorts({ PORT: '1' })).CLIENT_DEV_PORT).toBe(1);
    expect((await loadPorts({ PORT: '65535' })).CLIENT_DEV_PORT).toBe(65535);
  });
});