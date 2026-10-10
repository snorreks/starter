// scripts/src/local/container_service.ts
//
// The finite runner's image, prepared for a development run.
//
// **This service starts nothing, and that is deliberate.** `apps/backend/media` is
// not a server: it is a finite runner that processes one fenced attempt and
// exits. Modelling it as a listener would mean inventing a port, a health endpoint
// and a lifecycle it does not have, so that a developer could see something green
// that never runs a container.
//
// What it actually needs locally is an image built from the current sources, and
// confidence that the image is more than a successful compile. So this service
// builds it, counts the Cargo tests that ran inside the build, and refuses the
// run when that count is zero — the same refusal `bun run test:compute` makes,
// now from one implementation.
//
// The image outlives the run, so it is reported as an artifact rather than as
// something teardown must remove: deleting a layer-cached Rust build on Ctrl-C
// would make the next `bun run dev` pay twenty minutes to prove the same thing.

import { containerRuntimeRemedy, resolveContainerRuntime } from './container_runtime.ts';
import { buildMediaImage } from './media_image.ts';
import { type LocalService, type LocalServiceContext, LocalServiceUnavailable } from './service.ts';

export interface ContainerServiceDependencies {
  resolveRuntime: typeof resolveContainerRuntime;
  /** Injected so the build argv and the refusal are reachable without a Rust toolchain. */
  buildImage: typeof buildMediaImage;
}

export interface ContainerServiceResult extends LocalService {
  readonly id: 'container';
}

const defaultDependencies: ContainerServiceDependencies = {
  resolveRuntime: resolveContainerRuntime,
  buildImage: buildMediaImage,
};

export const prepareContainerService = async (
  context: LocalServiceContext,
  overrides: Partial<ContainerServiceDependencies> = {},
): Promise<ContainerServiceResult> => {
  const dependencies = { ...defaultDependencies, ...overrides };

  const engine = dependencies.resolveRuntime(context.environment);
  if (engine === null) {
    throw new LocalServiceUnavailable(
      'container',
      'a container engine to build the finite runner image',
      containerRuntimeRemedy,
    );
  }

  // Reused when this checkout already built the image from these exact sources.
  //
  // A development run needs the image to exist so it can dispatch at it; it is not
  // asserting that the image is correct, which is what `bun run test:compute`'s
  // uncached build is for. Both reports are explicit, because a stack that quietly
  // skipped a build would look identical to one that ran it.
  const built = await dependencies.buildImage({ engine: engine.command, reuse: true });

  const summary = built.reused
    ? [
        `Local finite-runner image -> ${built.image} (reused: already built from these sources, ${built.checksum.slice(0, 12)})`,
        '  No build ran. Run `bun run test:compute` for an uncached verification.',
        '  This image is an executor for fenced attempts, not a listener: nothing is',
        '  accepting connections. Pair it with `--stack jobs` to dispatch work at it.',
      ]
    : [
        `Local finite-runner image -> ${built.image} (built with ${engine.command})`,
        `  ${built.rustTests} Rust tests passed inside the image build`,
        `  Rebuild is incremental; run \`bun run test:compute\` for an uncached verification.`,
        '  This image is an executor for fenced attempts, not a listener: nothing is',
        '  accepting connections. Pair it with `--stack jobs` to dispatch work at it.',
      ];

  return {
    id: 'container',
    label: built.reused ? 'Finite runner image (reused)' : 'Finite runner image',
    // Nothing was started, so there is nothing this run is responsible for
    // stopping. Reporting `owned: true` would make teardown hunt for a listener
    // that was never launched.
    owned: false,
    vars: {},
    summary,
    dispose: async () => [],
  };
};
