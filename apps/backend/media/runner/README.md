# Finite Cloud Run runner

The runner accepts exactly an opaque job id and attempt id. It obtains an audience-bound identity token from the Cloud Run metadata server, requests an attempt-scoped grant from the application Worker, downloads bounded input, invokes the existing `starter-media encode` command, verifies the produced bytes and uploads them using the grant. It exits with the processor outcome; it never starts an HTTP server and holds no database or R2 credentials.

`STARTER_GRANT_ORIGIN` is a nonsecret application origin. The grant response must expire within ten minutes. Redirects are refused, TLS is mandatory except loopback fixtures, input/output sizes are capped, and local files are removed on every exit path. Dispatcher and runner identities are separate. Initial OAuth exchange uses a dispatcher service-account key stored as a Worker secret; workload identity federation is a future provider substitution and is not configured here.

Run boundary fixtures with `bun test runner.test.ts`. The image integration lane must run the actual Rust binary in Docker; the fixture tests do not claim Google IAM or hosted metadata behavior.
