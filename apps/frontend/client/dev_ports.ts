// apps/frontend/client/dev_ports.ts
//
// The one place the client's local ports are decided.
//
// Why this exists: `vite.config.ts` defaulted the client dev server to 5273 while
// the README said 5173, so the dev server, the proxy target and the documented
// URL could each point somewhere different. One module, read by everything that
// needs a port, is what makes that impossible.
//
// Override with the environment when a parallel checkout needs a different port.

/**
 * Read a port from the environment, or fall back.
 *
 * `Number(process.env.PORT)` used to be the whole implementation, and it has two
 * silent failure modes: a non-numeric value yields `NaN`, which reaches the proxy
 * target as a destination that is not an address, and `PORT=` — an empty string,
 * which is a common shell leftover — yields `0`. Vite then binds an arbitrary
 * port while everything else still assumes 5173, and the failure surfaces as a
 * connection refused several files away from the cause.
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

/** Vite dev/preview server. */
export const CLIENT_DEV_PORT = readPort('PORT', 5173);

/** The API the dev/preview server proxies `/api` to. */
export const API_DEV_PORT = readPort('API_PORT', 8787);

/** The host both dev servers bind. Loopback only: a dev server on 0.0.0.0 is a
 *  mistake waiting to happen, and the browser needs same-origin cookies anyway. */
export const DEV_HOST = '127.0.0.1';
