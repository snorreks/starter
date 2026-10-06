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
`production`. A promotion PR from `main` to `staging` or from `staging` to
`production` records the reviewed revision. After merge, manually dispatch the
Deploy workflow from `main` and select the destination environment; the workflow
checks out that environment's promotion branch. Manual dispatch is available for
recovery and deliberate redeploys; it always runs from `main`.

Configure `staging` and `production` GitHub environments. Add the Cloudflare
credentials to each environment and configure the repository variable
`STARTER_DEPLOYMENT_TARGETS` as described in [deployment.md](deployment.md).
Allow `main` and `staging` in the `staging` environment, and allow `main` and
`production` in the `production` environment. The promotion branch remains allowed
for its environment, and `main` permits manual recovery dispatches. Require
production reviewers in the `production` environment. Keep the two environments
pointed at distinct resources.

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
