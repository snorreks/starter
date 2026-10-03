// apps/frontend/native/dev_ports.ts
//
// The native app's dev frontend port, resolved once and explicitly.
//
// Two ports exist in this application and they are not interchangeable:
//
//   * `NATIVE_DEV_PORT` — the Vite dev server the Tauri shell loads in
//     `bun run native:dev`. `src-tauri/tauri.conf.json` names it as `devUrl`, and
//     a shell pointed at the wrong port shows a blank window with a connection
//     error that names nothing useful. `scripts/src/native/platform.ts` reads
//     this module to build the same URL, so the two cannot drift.
//
//   * `CLIENT_DEV_PORT` — the *web* app's port, owned by
//     `apps/frontend/client/dev_ports.ts`. The native app never serves it; it
//     calls the deployed Worker over HTTP with a bearer token instead.
//
// Why it is an explicit module rather than a flag on the Tauri command: the
// snapshot's launcher parsed `--target` as if platform names and target triples
// were the same thing, and picked the port by defaulting. A port decided in one
// place, read by both the dev server and the launcher, is the smallest thing that
// makes "the shell opened a blank window" a diagnosis rather than a mystery.
//
// `NATIVE_DEV_PORT` is separate from `PORT` on purpose. `PORT` already means "the
// web app's dev server" to a developer who has both checkouts open, and a native
// dev server silently taking the web app's port is a failure that presents as
// "the web app serves my desktop window".

/**
 * Read a port from the environment, or fall back.
 *
 * Both an unset variable and an empty one are *absences of input* and take the
 * default. Anything present but unusable is a mistake and throws, rather than
 * becoming a port Vite never bound and a shell that never connected.
 */
const readPort = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(
      `${name}="${raw}" is not a usable port. Set ${name} to an integer from 1 to 65535, ` +
        `or unset it to use ${fallback}.`,
    );
  }
  return value;
};

/**
 * The dev server the shell loads.
 *
 * 1420 rather than a shared default: it is deliberately *not* the web app's 5173
 * (see the header) and it is inside Vite's own default range so a stray
 * `vite dev` in another project does not collide with it.
 */
export const NATIVE_DEV_PORT = readPort('NATIVE_DEV_PORT', 1420);

/**
 * Loopback only.
 *
 * A dev server on `0.0.0.0` is reachable from the network, and a development
 * build of a desktop client is exactly the thing that should not be. A physical
 * phone or another machine on the network is a *mobile* concern with its own
 * documented procedure (see `docs/native.md`); it is not obtained by widening
 * this binding.
 */
export const NATIVE_DEV_HOST = '127.0.0.1';

/** The URL `src-tauri/tauri.conf.json`'s `devUrl` must name. */
export const nativeDevUrl = (): string => `http://${NATIVE_DEV_HOST}:${NATIVE_DEV_PORT}`;