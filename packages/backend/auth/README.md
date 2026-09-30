# @starter/auth

Better Auth, bound to D1 via the Drizzle adapter.

**Enabled:** email + password, rate limiting, device authorization + bearer
tokens for the Tauri webview.

**Not enabled (and not advertised in the UI):** OAuth providers, email
verification, password reset. Enabling any of them is a deliberate change: the
schema, the client screens and the E2E expectations all assume the current
surface, and a half-wired provider produces confusing partial failures.

Adding a provider means adding its credentials to the Worker's secrets, adding
the origin to `trustedOrigins`, and adding a client screen — in that order.
