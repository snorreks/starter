# GitHub Release Automation Design

## Goal

Make `main` the active development branch and use `staging` and `production` as
reviewed promotion branches, with deploy automation that avoids unnecessary work
and keeps native builds out of routine pull request and `main` checks.

## Current context

- `.github/workflows/ci.yml` runs the credential-free static, unit/browser,
  Worker, compute and E2E lanes for pull requests and pushes to `main`.
- `.github/workflows/deploy.yml` currently supports manual dispatch only. Its
  `plan` and `apply` jobs enforce a resolved destination, protected GitHub
  environments, serialized mutation and deployment from reviewed `main`.
- `.github/workflows/native.yml` currently runs native checks/builds for pull
  requests and `main`; native release builds are separately manual in
  `native-release.yml`.
- The starter has pinned Actions, read-only workflow defaults, workflow policy
  checks and a deployment target resolver. These remain authoritative.
- Aikami provides generic patterns worth adapting: promotion branches, early
  deploy planning, dependency-aware change detection, reusable setup/caches,
  workflow lint/security checks, issue and pull request forms, ownership,
  dependency automation, and optional notifications. App-specific Aikami
  actions, scripts, endpoints, labels and release assumptions are out of scope.

## Branch and release flow

`main` is the development branch. Pull requests target `main`; required CI and
repository policy checks run before merge. A maintainer promotes reviewed work by
merging `main` into `staging` for staging deployment, then promotes the validated
revision into `production` for production deployment. Deploy workflows also
retain manual dispatch for recovery and deliberate re-deploys. Pushes to either
promotion branch run the matching deployment environment and use its GitHub
environment protection rules. CI checks run on pull requests and pushes to all
three long-lived branches.

The deploy workflow must resolve the source branch to exactly one environment,
pass that environment through the existing target resolver and preserve the
current fail-closed checks for branch, source revision, credentials, target
separation, and deployment mode. Production approval remains a GitHub environment
setting. A failed check, missing configuration, or ambiguous target fails with an
explanation; it cannot become a successful no-op.

## Deploy fast path and caching

Every automatic deploy starts with a credential-free plan. The plan identifies
the changed projects from the promotion branch's merge base and maps them through
the repository's dependency graph to deployable outputs. Changes to shared
packages, build/deploy configuration, migrations, or the planner itself must
invalidate the relevant deploy output. Changes that cannot affect deployment
produce an explicit `no_deploy` result and skip all later jobs before dependency
installation, browser setup, build, or environment approval. Manual dispatch
continues to deploy the explicitly selected environment and is not skipped by
change detection.

Caching follows the existing CI rules: exact lockfile/toolchain keys for Bun's
download cache; exact browser version keys where a browser lane needs Chromium;
no cache is allowed to decide correctness or represent a fresh artifact. The
deployment plan and existing target resolution remain the authority for what
would be changed. Any restored cache is an acceleration only; a cache miss runs
the normal command, and failed cache maintenance does not mask a build failure.
The deploy artifact is built only after an actionable plan and is the artifact
that `apply` publishes.

## Native workflow

Remove `pull_request` and `push` triggers from `native.yml`, so no native build
runs for ordinary PRs or `main` pushes. Preserve an explicit manual dispatch for
maintainers who need the unsigned native validation/artifacts. Keep
`native-release.yml` as the separate manual, credentialed release path. Do not
weaken the native bundle boundary checks or allow release credentials into PR
workflows.

## GitHub repository support

- Add generic YAML issue forms for bug reports, setup/developer-experience
  problems, and feature requests, plus an issue-template config that directs
  security reports to GitHub Security Advisories and allows blank issues where
  the template owner has not configured support links.
- Add a generic pull request template that asks for intent, verification, and a
  concise checklist aligned with this repository's actual commands.
- Add a CODEOWNERS template with clear replacement instructions rather than
  copying Aikami's account-specific handle or invalid team names.
- Configure Dependabot for GitHub Actions and Bun workspace dependencies with
  bounded, grouped updates. Keep lockfile/tool version policy checks intact.
- Add path-gated GitHub workflow validation and security analysis (actionlint
  and zizmor or equivalent pinned tools), with narrowly documented suppressions.
- Add optional notifications for successful promotion/deployment and merged PRs.
  A missing webhook secret disables only the notification step; notification
  failure is reported but does not alter a successful deployment. Never use
  `pull_request_target` to run repository code with secrets.

## Security and operational requirements

- Workflows use minimum permissions, pinned third-party Actions, bounded
  timeouts, and concurrency keyed to the deployment environment.
- PR code remains untrusted and receives no deployment credentials. Deploy
  credentials are scoped only to the selected protected GitHub environment.
- No path, cache hit, notification setting, or missing optional secret can turn
  a required check or requested deploy into a green no-op.
- All GitHub automation refers to `main` as the development base and uses
  `staging`/`production` only as promotion/deployment branches.
- Documentation explains branch setup, branch protections, environment
  configuration, notifications, manual recovery, and which native workflows
  run automatically.

## Out of scope

- Creating remote branches or changing GitHub branch protection/environment
  settings through the API. The repository can document those required settings;
  applying them needs a separately configured GitHub repository and authority.
- Copying Aikami-specific webhooks, bot identities, labels, app paths, release
  artifacts, or deployment scripts.
- Adding a new build system or replacing the starter's deployment target model.

## Acceptance criteria

1. CI's development and PR base is `main`, and CI also validates pushes to
   `staging` and `production`.
2. A promotion push deploys only its matching environment after a credential-free
   actionable plan; a non-deployable diff visibly skips expensive deploy work.
3. Shared dependency and deployment-input changes are not incorrectly skipped.
4. Manual deploy dispatch still works, with the same approval, serialization,
   target and credential protections.
5. Native workflows do not start for pull requests or pushes to `main`; native
   checks and release builds remain manually available.
6. Generic issue/PR templates, dependency automation, workflow security checks,
   ownership guidance and optional notifications are present and documented.
7. Workflow policy validation covers the new triggers, permissions, timeouts,
   action pins, and credential boundaries.
