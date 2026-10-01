// apps/frontend/client/scripts/dev_ports.test.ts
//
// The dev port, and what an environment override is allowed to do to it.
//
// `PORT` exists so two checkouts can run side by side, so it has to be read — but
// `Number(process.env.PORT)` accepted anything. Two of those anything-values were
// silent:
//
//   * `PORT=5174x`  -> `NaN`, which reaches Vite as a number that is not a port.
//   * `PORT=`       -> `0`. `PORT=` is an ordinary shell leftover, and 0 tells
//                      Vite to bind an arbitrary port while everything else still
//                      assumes 5173. The failure then names neither.
//
// So the reader is exercised here against the real module, with the environment
// set first and the import afterwards. Bun keys its module registry on the
// specifier including the query, so `?case=3` really is a second evaluation of the
// same file — the alternative would be asserting on a helper instead of on the
// constant the rest of the app reads.
//
// `API_PORT` is asserted *absent* as well, because the temptation after this
// migration is to keep it as an ignored alias. A variable that used to configure a
// second process and now configures nothing is worse than a missing one: it looks
// like it works.

import { afterEach, describe, expect, test } from 'bun:test';

const PORT = 'PORT' as const;
const saved = process.env[PORT];

afterEach(() => {
  if (saved === undefined) {
    delete process.env[PORT];
  } else {
    process.env[PORT] = saved;
  }
});

let cases = 0;

/** Evaluate `dev_ports.ts` with this environment in place. */
const loadPorts = async (value: string | undefined) => {
  if (value === undefined) {
    delete process.env[PORT];
  } else {
    process.env[PORT] = value;
  }
  cases += 1;
  return import(`../dev_ports.ts?case=${cases}`);
};

describe('dev port environment overrides', () => {
  test('an unset port is the default', async () => {
    const ports = await loadPorts(undefined);

    expect(ports.CLIENT_DEV_PORT).toBe(5173);
    expect(ports.DEV_HOST).toBe('127.0.0.1');
  });

  test('an empty value is an absence, not port zero', async () => {
    // The specific leftover this exists for. Whitespace counts as empty for the
    // same reason: it is a leftover, not a port somebody chose.
    const ports = await loadPorts('   ');

    expect(ports.CLIENT_DEV_PORT).toBe(5173);
  });

  test('a valid port is used verbatim', async () => {
    const ports = await loadPorts('6100');
    expect(ports.CLIENT_DEV_PORT).toBe(6100);
  });

  test('a value that is not a port is refused by name', async () => {
    // Refused rather than replaced: a typo in PORT must not silently become the
    // default, because that looks like it worked.
    for (const bad of ['5173x', 'port', '0', '-1', '65536', '1.5', 'NaN', '123 456']) {
      await expect(loadPorts(bad)).rejects.toThrow(/PORT=/);
    }
  });

  test('the boundaries are usable ports', async () => {
    expect((await loadPorts('1')).CLIENT_DEV_PORT).toBe(1);
    expect((await loadPorts('65535')).CLIENT_DEV_PORT).toBe(65535);
  });

  test('the retired API_PORT is not read', async () => {
    // Set, ignored, and absent from the module. A caller that still exports
    // API_PORT has reintroduced a proxy target that no longer exists.
    process.env['API_PORT'] = '8787';
    try {
      const ports = await loadPorts('5200');
      expect(ports.CLIENT_DEV_PORT).toBe(5200);
      expect(Object.keys(ports)).not.toContain('API_DEV_PORT');
    } finally {
      delete process.env['API_PORT'];
    }
  });
});
