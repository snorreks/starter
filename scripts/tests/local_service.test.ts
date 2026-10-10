// scripts/tests/local_service.test.ts
//
// The lifecycle N services share. Every assertion here is about a composition
// failure that would otherwise only appear after a real container had been
// started: a binding written twice, a teardown that stops one service and skips
// the rest, a prerequisite that gets reported as a success.

import { describe, expect, test } from 'bun:test';
import {
  disposeServices,
  isLocalServiceId,
  LOCAL_SERVICE_IDS,
  type LocalService,
  type LocalServiceId,
  LocalServiceUnavailable,
  mergeServiceVars,
} from '../src/local/service.ts';

const service = (
  id: LocalServiceId,
  vars: Record<string, string> = {},
  dispose: () => Promise<string[]> = async () => [],
): LocalService => ({ id, label: id, owned: true, vars, summary: [], dispose });

describe('local service ids are a closed set', () => {
  test('a typo is refused rather than starting one service fewer than asked for', () => {
    // `--stack supres` skipping the database looks exactly like a working run: the
    // app starts, and every request 503s on a database that was never started.
    expect(isLocalServiceId('supabase')).toBe(true);
    expect(isLocalServiceId('supres')).toBe(false);
    expect(LOCAL_SERVICE_IDS).toContain('stripe');
  });
});

describe('two services writing one binding is refused, not merged', () => {
  test('the refusal names both services and the binding', () => {
    let caught: Error | undefined;
    try {
      mergeServiceVars([
        service('supabase', { SUPABASE_URL: 'http://127.0.0.1:54321' }),
        service('stripe', { STRIPE_SECRET_KEY: 'sk' }),
        // The defect: two services both believing they own the Stripe key.
        service('stripe', {}),
        service('container', { STRIPE_SECRET_KEY: 'sk_other' }),
      ]);
    } catch (error) {
      caught = error as Error;
    }

    // Last-writer-wins would leave the application talking to whichever service
    // started last, holding a credential belonging to the other.
    expect(caught?.message).toContain('stripe');
    expect(caught?.message).toContain('container');
    expect(caught?.message).toContain('STRIPE_SECRET_KEY');
  });

  test('distinct bindings merge in service order', () => {
    expect(
      mergeServiceVars([
        service('supabase', { SUPABASE_URL: 'http://127.0.0.1:54321' }),
        service('stripe', { STRIPE_API_BASE: 'http://127.0.0.1:4300' }),
      ]),
    ).toEqual({ SUPABASE_URL: 'http://127.0.0.1:54321', STRIPE_API_BASE: 'http://127.0.0.1:4300' });
  });
});

describe('teardown runs every service in reverse', () => {
  test('a service that refuses to stop does not leave the ones before it running', async () => {
    const order: string[] = [];
    const stubborn: LocalService = {
      ...service('container'),
      // The one that fails. It is second-to-last in start order, so the database
      // beneath it must still be stopped.
      dispose: async () => {
        order.push('container');
        throw new Error('container engine refused');
      },
    };

    const failures = await disposeServices([
      service('supabase', {}, async () => {
        order.push('supabase');
        return [];
      }),
      stubborn,
      service('stripe', {}, async () => {
        order.push('stripe');
        return [];
      }),
    ]);

    // Reverse: the last thing started is the first thing stopped.
    expect(order).toEqual(['stripe', 'container', 'supabase']);
    expect(failures).toEqual(['container: container engine refused']);
  });

  test('a throw is attributed to its service so the operator knows what is holding a port', () => {
    return disposeServices([
      service('jobs', {}, async () => ['the jobs Worker left 4242 running']),
    ]).then((failures) => {
      expect(failures).toEqual(['the jobs Worker left 4242 running']);
    });
  });

  test('an empty stack tears down to nothing rather than to a failure', () => {
    return disposeServices([]).then((failures) => {
      expect(failures).toEqual([]);
    });
  });
});

describe('a missing prerequisite is a refusal that names itself', () => {
  test('the service, the prerequisite and the remedy are all carried', () => {
    // All three are printed. "Something went wrong" leaves a developer with no way
    // to act, which is the whole reason this is a typed failure.
    const refusal = new LocalServiceUnavailable(
      'container',
      'a container engine to build the finite runner image',
      'Install Docker Engine or Podman.',
    );
    expect(refusal.service).toBe('container');
    expect(refusal.prerequisite).toBe('a container engine to build the finite runner image');
    expect(refusal.remedy).toBe('Install Docker Engine or Podman.');
    expect(refusal.message).toContain('container');
  });
});
