// scripts/src/local/container_runtime.ts
//
// Which container engine this host has, resolved once and reused.
//
// Every local service that needs a container — Supabase, stripe-mock, the media
// image — has to answer the same question, and the failure has to read the same
// way. Before this module, `supabase_local.ts` probed `process.env.DOCKER_BIN ??
// 'docker'` inline, which meant a host with Podman and no Docker was told to
// install Docker Engine. The repository's own table already says
// "Docker-compatible engine", and Podman provides one; a probe that names only
// Docker makes a supported host look unsupported.
//
// The probe runs the engine rather than looking for a file, because a binary on
// PATH with a stopped daemon is not a working engine, and the symptom otherwise
// appears four minutes later as a failed `docker run` inside somebody else's
// error message.
//
// `DOCKER_BIN` still wins outright. A developer who set it is pointing at a
// specific engine — a rootless socket, a remote host, a wrapper script — and
// silently substituting a different one would ignore that.

import { spawnSync } from 'node:child_process';

/** The probe result, including the version so a failure report names a real engine. */
export interface ContainerRuntime {
  /** The executable, as an argv element. Never a shell string. */
  readonly command: string;
  /** First line of `<command> version`, for the banner and for diagnostics. */
  readonly version: string;
}

/**
 * Engines tried in order, after `DOCKER_BIN`.
 *
 * Podman before Docker is deliberate only in that both are tried; neither is
 * preferred on capability, because the compatibility surface used here is the
 * Docker CLI subset both implement.
 */
export const CONTAINER_RUNTIME_CANDIDATES = ['docker', 'podman'] as const;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe one candidate, or return `null` if it cannot answer.
 *
 * `info` and not `version`: `version` reports the client even when the daemon is
 * stopped, and a stopped daemon passes the probe and then fails on the first
 * `run`, with the error surfacing from inside somebody else's message. `info`
 * asks the engine whether it can actually run a container.
 *
 * A missing binary, a non-zero exit and a timeout are all the same answer for the
 * caller — this engine is not usable here — and none of them is an error to
 * propagate, because the next candidate may work.
 */
const probe = (command: string): ContainerRuntime | null => {
  const result = spawnSync(command, ['info'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const version = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')[0]?.trim() ?? '';
  return { command, version };
};

/**
 * The first usable engine, or `null`.
 *
 * `DOCKER_BIN` is not probed against the candidates: if it is set and fails, the
 * answer is `null` rather than a fallback, because silently running a different
 * engine than the one configured is how a rootless-socket developer ends up
 * writing files to a daemon they did not intend to use.
 */
export const resolveContainerRuntime = (
  environment: NodeJS.ProcessEnv = process.env,
): ContainerRuntime | null => {
  const configured = environment.DOCKER_BIN;
  if (configured !== undefined && configured.length > 0) {
    return probe(configured);
  }
  for (const candidate of CONTAINER_RUNTIME_CANDIDATES) {
    const runtime = probe(candidate);
    if (runtime !== null) {
      return runtime;
    }
  }
  return null;
};

/**
 * A message naming what is missing and what to do about it.
 *
 * The remedy is a separate field on `LocalServiceUnavailable` because the caller
 * prints both and the reader acts on the remedy: "no container engine" tells a
 * developer what happened, and the install command tells them what to do.
 */
export const containerRuntimeRemedy =
  'Install Docker Engine or Podman with a Docker-compatible socket, then re-run.\n' +
  '  Check what this host has:  bun run setup:doctor -- --profile compute\n' +
  '  Point at a specific engine:  DOCKER_BIN=podman bun run dev --stack …';
