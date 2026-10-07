// packages/frontend/platform/src/index.ts
//
// The frontend platform contracts.
//
// Four things a host implements and a feature depends on: how to reach the API,
// how to validate what came back, how to move, and where a credential lives.
// Nothing here knows about SvelteKit, Tauri or Cloudflare, which is the property
// that lets one feature package serve every host.

export type { TransportMethod, TransportRequestOptions } from './api_transport.ts';
export {
  type ApiTransport,
  type ArtifactBytes,
  type ArtifactRequestOptions,
  type ArtifactTransport,
  type FetchLike,
  HttpTransport,
  type HttpTransportOptions,
  normalizeTransportError,
  type StreamingTransport,
} from './api_transport.ts';
export type { ExternalBrowser, Navigation } from './capabilities.ts';
export { parseDto } from './dto.ts';
export {
  MemorySessionStore,
  ReauthenticationRequiredError,
  type SessionCredential,
  type SessionScope,
  type SessionStore,
  sessionScopeKey,
} from './session_store.ts';
