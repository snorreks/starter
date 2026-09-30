// apps/frontend/client/dev_ports.ts
//
// The one place the client's local ports are decided.
//
// Why this exists: `vite.config.ts` defaulted the client dev server to 5273 while
// `src-tauri/tauri.conf.json` hard-coded `devUrl` at 5173 and the README said
// 5173. `tauri dev` therefore started a window pointed at a port nothing was
// listening on, and the symptom — a blank webview — names neither file.
//
// Tauri v2 does not substitute environment variables into `tauri.conf.json`, so
// `devUrl` has to stay a literal. That is exactly why the default lives here and
// `scripts/src/lib/guards/boundary.ts` asserts the two agree: a literal that is
// checked against a single authority cannot drift silently.
//
// Override with the environment when a parallel checkout needs a different port.
// If you override the client port and use `tauri dev`, also pass
// `--config '{"build":{"devUrl":"http://127.0.0.1:<port>"}}'`.

/** Vite dev/preview server. Must equal `build.devUrl`'s port in tauri.conf.json. */
export const CLIENT_DEV_PORT = Number(process.env.PORT ?? 5173);

/** The API the dev/preview server proxies `/api` to. */
export const API_DEV_PORT = Number(process.env.API_PORT ?? 8787);

/** The host both dev servers bind. Loopback only: a dev server on 0.0.0.0 is a
 *  mistake waiting to happen, and the browser needs same-origin cookies anyway. */
export const DEV_HOST = '127.0.0.1';

export const clientBaseUrl = (port: number = CLIENT_DEV_PORT): string =>
  `http://${DEV_HOST}:${port}`;

export const apiBaseUrl = (port: number = API_DEV_PORT): string => `http://${DEV_HOST}:${port}`;

/** What `tauri.conf.json` must contain for `tauri dev` to find the dev server. */
export const expectedTauriDevUrl = (): string => clientBaseUrl();
