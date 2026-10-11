// scripts/tests/dev_stack.test.ts
//
// Choosing what `bun run dev` starts. The failures asserted here are all of the
// shape "the run looked fine and did less than it said", which is the class this
// repository treats as worse than an outright error.

import { describe, expect, test } from 'bun:test';
import {
  DEV_STACK_NAMES,
  describeStack,
  parseStackSpec,
  resolveStack,
  stackChoices,
  startStack,
} from '../src/dev-stack.ts';
import type { LocalService, LocalServiceId } from '../src/local/service.ts';
import type { Stepper } from '../src/shared/progress.ts';
import { captureStderr, recordingProgress } from './fixtures/progress.ts';

describe('a named stack resolves to services', () => {
  test('full is every service, in start order', () => {
    const resolved = resolveStack('full');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error('full did not resolve');
    }
    expect(resolved.services).toEqual(['supabase', 'stripe', 'container', 'jobs']);
  });

  test('a combination of services is accepted alongside named stacks', () => {
    const resolved = resolveStack('supabase,stripe');
    expect(resolved.ok && resolved.services).toEqual(['supabase', 'stripe']);
  });

  test('start order is declared, not the order they were typed', () => {
    // Typed `jobs,supabase` and typed `supabase,jobs` must produce one run, or the
    // same command produces different infrastructure depending on how it was read.
    const a = resolveStack('jobs,supabase');
    const b = resolveStack('supabase,jobs');
    expect(a.ok && a.services).toEqual(b.ok ? b.services : []);
  });
});

describe('an unknown stack is refused, never skipped', () => {
  test('a typo names itself and the real options', () => {
    const parsed = parseStackSpec('supres');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error('a typo resolved');
    }
    expect(parsed.problem).toContain('supres');
    expect(parsed.remedy).toContain('client');
  });

  test('one bad token refuses the whole list rather than starting the rest', () => {
    // The failure this prevents: `--stack supabase,stripe,strip` starting two
    // services, reporting success, and missing the third.
    const parsed = parseStackSpec('supabase,stripe,strip');
    expect(parsed.ok).toBe(false);
  });

  test('an empty specification is a refusal with the options', () => {
    const parsed = parseStackSpec('  ,  ');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error('an empty stack resolved');
    }
    expect(parsed.remedy).toContain('client');
  });
});

describe('a stack always brings up what the application needs', () => {
  test('naming only stripe still starts the database the app reads from', () => {
    // The app is a registry entry with `requires: ['supabase']`. Without this the
    // developer gets a checkout page that 503s on save, and no explanation.
    const resolved = resolveStack('stripe');
    expect(resolved.ok && resolved.services).toContain('supabase');
    expect(resolved.ok && resolved.services).toContain('stripe');
  });

  test('the services pulled in by the registry are reported, so the extra is visible', () => {
    const resolved = resolveStack('stripe');
    expect(resolved.ok && resolved.fromApps).toContain('web');
  });
});

describe('a stack that fails part-way leaves nothing behind', () => {
  test('services that came up are disposed in reverse declared order', async () => {
    const started: LocalServiceId[] = [];
    const stopped: LocalServiceId[] = [];
    const factory = async (id: LocalServiceId): Promise<LocalService> => {
      if (id === 'container') {
        throw new Error('no Rust toolchain');
      }
      started.push(id);
      return {
        id,
        label: id,
        owned: true,
        vars: {},
        summary: [],
        dispose: async () => {
          stopped.push(id);
          return [];
        },
      };
    };

    await expect(
      startStack(
        ['supabase', 'stripe', 'container', 'jobs'],
        factory,
        recordingProgress().progress,
      ),
    ).rejects.toThrow('no Rust toolchain');

    // Two databases and a container behind a failed `bun run dev` is how a machine
    // ends up with orphaned stacks nobody can attribute to a port.
    expect(started).toEqual(['supabase', 'stripe', 'jobs']);
    // Reverse of the *declared* order, not of completion: services start together,
    // so completion order is a race and would tear down the jobs Worker before the
    // database it reads from whenever the database happened to boot faster.
    expect(stopped).toEqual(['jobs', 'stripe', 'supabase']);
  });

  test('a service still starting is awaited before anything is torn down', async () => {
    // The failure this prevents: unwinding while a sibling is mid-start leaves a
    // container that finishes booting after the teardown has looked for it, and it
    // holds its ports for the rest of the machine's afternoon.
    let jobsFinishedStarting = false;
    const factory = async (id: LocalServiceId): Promise<LocalService> => {
      if (id === 'container') {
        throw new Error('no Rust toolchain');
      }
      if (id === 'jobs') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        jobsFinishedStarting = true;
      }
      return {
        id,
        label: id,
        owned: true,
        vars: {},
        summary: [],
        dispose: async () => {
          // Asserted inside the dispose: at this point the sibling must be finished.
          if (!jobsFinishedStarting) {
            throw new Error('torn down while a sibling was still starting');
          }
          return [];
        },
      };
    };

    const outcomes = await Promise.allSettled([
      startStack(['supabase', 'container', 'jobs'], factory, recordingProgress().progress),
    ]);
    expect(outcomes[0]?.status).toBe('rejected');
  });

  test('two services that both refuse report the same one on every run', async () => {
    // Declared order decides, so the refusal a developer reads does not depend on
    // which of the two lost the race — and the other one is printed, not lost.
    const written = await captureStderr(async () => {
      await expect(
        startStack(
          ['supabase', 'stripe'],
          async (id) => {
            throw new Error(`no engine for ${id}`);
          },
          recordingProgress().progress,
        ),
      ).rejects.toThrow('no engine for supabase');
    });

    // Declared order decides which refusal the caller sees, so this is the same on
    // every run. The other is printed rather than lost.
    expect(written.join('\n')).toContain('stripe: no engine for stripe');
  });
});

describe('services start together, not one after another', () => {
  test('a stack takes as long as its slowest service rather than the sum', async () => {
    // Not a timing assertion — a scheduling one. Each factory waits for the others
    // to arrive, so this only resolves if every service is *started* before any of
    // them finishes. Started in sequence, the first would wait for three that had
    // not been called.
    let arrivals = 0;
    let openTheBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      openTheBarrier = resolve;
    });

    const factory = async (id: LocalServiceId): Promise<LocalService> => {
      arrivals += 1;
      if (arrivals === 4) {
        openTheBarrier?.();
      }
      await barrier;
      return { id, label: id, owned: false, vars: {}, summary: [], dispose: async () => [] };
    };

    // The barrier only opens once all four have been *called*, so this test fails
    // by timing out rather than by asserting, if the stack goes back to sequential.
    const services = await startStack(
      ['supabase', 'stripe', 'container', 'jobs'],
      factory,
      recordingProgress().progress,
    );
    expect(arrivals).toBe(4);
    // Declared order, which is what the banner prints and teardown reverses.
    expect(services.map((service) => service.id)).toEqual([
      'supabase',
      'stripe',
      'container',
      'jobs',
    ]);
  });

  test("a service's steps are labelled with its own name, not a sibling's", async () => {
    // With two services live at once, nesting under "whatever started last" would
    // print `supabase -> stripe`, naming neither service correctly.
    const reported = recordingProgress();
    const factory = async (id: LocalServiceId, stepper: Stepper): Promise<LocalService> => {
      stepper.step(`${id} work`);
      return { id, label: id, owned: false, vars: {}, summary: [], dispose: async () => [] };
    };

    await startStack(['supabase', 'stripe'], factory, reported.progress);
    expect(reported.announced()).toEqual(
      expect.arrayContaining(['supabase -> supabase work', 'stripe -> stripe work']),
    );
  });
});

describe('a service is announced before it is started, not after', () => {
  // The defect this prevents: `bun run dev` printed nothing until the first
  // container was already up, so a cold start looked identical to a hang and the
  // developer's response to both was Ctrl-C.
  test('the step is live while the factory is still running', async () => {
    const reported = recordingProgress();
    let liveDuringFactory: string[] = [];

    const factory = async (id: LocalServiceId): Promise<LocalService> => {
      liveDuringFactory = reported.live();
      return { id, label: id, owned: false, vars: {}, summary: [], dispose: async () => [] };
    };

    await startStack(['supabase'], factory, reported.progress);
    expect(liveDuringFactory).toEqual(['supabase']);
    expect(reported.live()).toEqual([]);
  });

  test('a step belonging to a service is announced against that service', async () => {
    const reported = recordingProgress();
    const factory = async (id: LocalServiceId, stepper: Stepper): Promise<LocalService> => {
      stepper.step(`${id} step`);
      return { id, label: id, owned: false, vars: {}, summary: [], dispose: async () => [] };
    };

    await startStack(['supabase'], factory, reported.progress);
    expect(reported.announced()).toContain('supabase -> supabase step');
  });

  test('every service in the stack is announced, in start order', async () => {
    const reported = recordingProgress();
    const factory = async (id: LocalServiceId): Promise<LocalService> => ({
      id,
      label: id,
      owned: false,
      vars: {},
      summary: [],
      dispose: async () => [],
    });

    await startStack(['supabase', 'stripe', 'container', 'jobs'], factory, reported.progress);
    // The words a developer typed with `--stack`, in the order they will start.
    expect(reported.announced()).toEqual(['supabase', 'stripe', 'container', 'jobs']);
    expect(reported.steps.every((step) => step.outcome === 'done')).toBe(true);
  });

  test('a service that fails is reported as failed, naming the reason', async () => {
    const reported = recordingProgress();
    const failure = new Error(
      'The container local service needs a container engine to build the finite runner image, which this host does not have.',
    );
    const factory = async (id: LocalServiceId): Promise<LocalService> => {
      if (id === 'container') {
        throw failure;
      }
      return { id, label: id, owned: false, vars: {}, summary: [], dispose: async () => [] };
    };

    await expect(startStack(['supabase', 'container'], factory, reported.progress)).rejects.toThrow(
      failure.message,
    );
    // Announced and named, not silently skipped — a stack that printed nothing for
    // the container and then reported a database is exactly what a bug looks like.
    expect(reported.steps.at(-1)).toEqual({
      service: null,
      chain: 'container',
      outcome: 'failed',
      note: failure.message,
    });
  });
});

describe('the banner reports what actually started', () => {
  test('the merged bindings and the labels come from the services themselves', () => {
    const described = describeStack([
      {
        id: 'supabase',
        label: 'Local Supabase',
        owned: true,
        vars: { SUPABASE_URL: 'http://127.0.0.1:54321' },
        summary: ['Local Supabase -> http://127.0.0.1:54321'],
        dispose: async () => [],
      },
    ]);
    expect(described.vars).toEqual({ SUPABASE_URL: 'http://127.0.0.1:54321' });
    expect(described.summary[0]).toBe('Local Supabase');
  });
});

describe('the menu cannot fall out of step with the stacks', () => {
  test('every named stack is offered, and every offer describes itself', () => {
    // A stack added to the registry but not to the prompt is invisible, which is
    // how a feature ships and nobody can find.
    const offered = stackChoices().map((choice) => choice.id);
    expect(offered).toEqual([...DEV_STACK_NAMES]);
    for (const choice of stackChoices()) {
      expect(choice.detail.length).toBeGreaterThan(0);
      expect(choice.services.length).toBeGreaterThan(0);
    }
  });
});
