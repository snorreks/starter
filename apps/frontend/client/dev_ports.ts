// apps/frontend/client/dev_ports.ts
//
// The one place the local dev server's port is decided.
//
// Why this exists: `vite.config.ts` defaulted the dev server to 5273 while the
// README said 5173, so the dev server and the documented URL could each point
// somewhere different. One module, read by everything that needs a port, is what
// makes that impossible.
//
// Override with the environment when a parallel checkout needs a different port.
// There is exactly one port now, and that is the change worth noticing: the API
// used to be a second process on 8787 that this file also had to name, and the
// dev server had to be told where to proxy `/api`. One origin means one port, one
// process, and no way for the two to disagree.

/**
 * Read a port from the environment, or fall back.
 *
 * `Number(process.env.PORT)` used to be the whole implementation, and it has two
 * silent failure modes: a non-numeric value yields `NaN`, which reaches Vite as a
 * port that is not a number, and `PORT=` — an empty string, which is a common
 * shell leftover — yields `0`. Vite then binds an arbitrary port while everything
 * else still assumes 5173, and the failure surfaces as a connection refused
 * several files away from the cause.
 *
 * Unset and empty are both *absences of input*, so both take the default. Anything
 * present but not a usable port is a mistake, and this throws rather than
 * substituting a port nobody asked for.
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
 * The dev and preview server, which is also the API.
 *
 * `API_PORT` is gone rather than left as an ignored alias: a variable that used
 * to configure a second process and now configures nothing is a trap, and reading
 * it would be a command that succeeds while doing nothing.
 */
export const CLIENT_DEV_PORT = readPort('PORT', 5173);

/** Host both the dev and preview servers bind. Loopback only: a dev server on
 *  0.0.0.0 is a mistake waiting to happen, and it also breaks the local
 *  environment check, which only derives the public origin for a loopback
 *  request. See `#lib/server/env.ts`. */
export const DEV_HOST = '127.0.0.1';
