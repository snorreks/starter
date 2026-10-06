# GitHub repository setup

This template uses `main` for development and `staging` and `production` for
release promotion. Workflow files cannot create branches or configure repository
protection, so set these once after creating a repository from the template.

## Branches and protections

1. Set `main` as the default branch and create `staging` and `production` from it.
2. Require pull requests and CI checks before merging into all three branches.
   Feature work targets `main`; promote by opening a PR from `main` to `staging`,
   then from the validated `staging` revision to `production`.
3. Require reviews on promotion branches. Restrict who can merge to `production`.

CI runs on PRs to each long-lived branch and on pushes to `main`, `staging`, and
`production`. A promotion PR from `main` to `staging` deploys staging after merge;
a promotion PR from `staging` to `production` deploys production after merge.
Each push first checks its changed paths. Documentation,
GitHub metadata, `.pi` tooling, and native-only changes exit before dependency
installation and environment approval. All unknown paths are treated as
deployable. Manual deploy dispatch is available for recovery and deliberate
redeploys; it is run from `main` and selects an environment explicitly.

Configure `staging` and `production` GitHub environments. Add the Cloudflare
credentials to each environment and configure the repository variable
`STARTER_DEPLOYMENT_TARGETS` as described in [deployment.md](deployment.md).
Restrict the `staging` environment to the `staging` branch, and the `production`
environment to the `production` branch. If manual deploys from `main` should also
be allowed for either environment, include `main` in that environment's allowed
branches. Require production reviewers in the `production` environment. Keep the
two environments pointed at distinct resources.

## Native builds

`.github/workflows/native.yml` is manual because its platform matrix is expensive.
Use **Actions → Native → Run workflow** when validating the Tauri shell. The
signed or platform release path remains the separate manual workflow
`.github/workflows/native-release.yml`.

## Issues, dependencies, and workflow security

Issue forms cover bugs, setup problems, and feature requests. Replace the
`OWNER/REPOSITORY` security advisory link in
`.github/ISSUE_TEMPLATE/config.yml` when extracting this template. Keep public
vulnerability reports out of issue threads.

Dependabot already groups weekly Bun and GitHub Actions updates into reviewable
pull requests. `.github/workflows/workflow-lint.yml` runs only when GitHub
automation files change; it checks syntax with actionlint and security patterns
with zizmor. The regular CI workflow also runs `bun run workflows`, which checks
permissions, job timeouts, action pins, and credential boundaries across all
workflow files.

## Optional release notifications

Add `DISCORD_WEBHOOK_URL` as a secret on each deployment environment to post a
success message after a deploy. Leave it unset to skip notifications. A failed
notification is visible in the Actions log and does not change the deployment
result. The webhook is never available to pull request jobs.
