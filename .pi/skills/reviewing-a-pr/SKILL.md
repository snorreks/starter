---
name: reviewing-a-pr
description: Use when asked to review a pull request, address review comments, or check whether a PR is ready — including reading CI state and every review thread. Covers identifying the correct repo, PR and head, distinguishing findings that are stale from findings that still stand, and fixing only what the evidence supports.
---

# Reviewing a pull request

Use `gh` directly. It is installed, authenticated, and its output is the
authority on what a PR actually says — a wrapper tool that caches or reshapes
that data is a second thing to keep correct.

## Never do these

| Do not | Why |
|---|---|
| Merge, or enable auto-merge | Reviewing is not approving. Nothing here authorises publication. |
| Request a re-review unprompted | It pings a human for nothing. |
| Poll CI in a loop | `gh pr checks` is a snapshot. Wait, then ask again once. |
| Run a blind autofix | A tool that rewrites code without reading the finding produces a diff nobody reviewed. |
| Post a review comment to test whether posting works | Review comments are not a scratch pad. |

## 1. Identify what you are actually reviewing

Three identifiers, and getting any of them wrong means reviewing the wrong thing
while reporting confidently.

```bash
gh repo view --json nameWithOwner,defaultBranchRef
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
gh pr view --json number,title,state,headRefName,headRefOid,baseRefName,isDraft,url
```

The `headRefOid` is the check that matters. If it does not equal your `HEAD`,
you are reviewing a **local** diff that may not be the PR at all — say so, and
say which one you are reviewing.

If `gh pr view` finds no PR for the current branch, stop and ask. Do not open one.

## 2. Read CI as a snapshot

```bash
gh pr checks <number> --json name,state,bucket,link,workflow
```

`bucket` is the useful field: `pass`, `fail`, `pending`, `skipping`, `cancel`.

- `pending` means **not run yet**, which is not a pass and not a failure. Say it is
  pending.
- `skipping` means the check did not execute. In this repository some lanes
  cannot run — see [docs/capability-matrix.md](../../docs/capability-matrix.md).
  Report it as not run, with the reason, rather than as green.
- `fail` means read the log before theorising about the cause.

For a failing check, read the log rather than guessing:

```bash
gh run view --log-failed
```

## 3. Read every review thread — including the later pages

`gh pr view --comments` returns **the first page**. A PR with 40 comments and a
bug in comment 41 gets a clean review.

The complete set needs the GraphQL API, which paginates:

```bash
gh api graphql --paginate -f query='
query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:100) {
            pageInfo { hasNextPage endCursor }
            nodes { author { login } body path line createdAt url }
          }
        }
      }
    }
  }
}' -f owner=<owner> -f repo=<repo> -F number=<number>
```

`--paginate` requires every level you need to be fully walked to declare
`hasNextPage: false`. **Check the inner `comments.pageInfo` too** — a single
thread can have more comments than the outer query returned.

`gh api graphql --paginate` needs `pageInfo { hasNextPage endCursor }` at every
level. If the inner one reports more pages, re-run with the thread's own cursor
rather than assuming you have the lot.

## 4. Separate findings that still stand from findings that are stale

This is where a review usually goes wrong. A comment marked `isOutdated: true`
was written about a line that has since changed. It may still be a real problem
— or it may have been fixed.

For each thread, decide:

| State | Meaning | What to do |
|---|---|---|
| `isOutdated` and the code no longer does it | stale | say so, do not "fix" it |
| `isOutdated` but the code still does it | still stands | fix it, and say it was outdated |
| Not outdated, not addressed | open | fix it |
| `isResolved` | a human closed it | do not reopen without a reason |
| Comment is a question | not a finding | answer it; do not change code |

Quote the code that decides it. "This was fixed" without pointing at the line is
indistinguishable from a guess.

## 5. Fix only what the evidence supports

For each finding you accept:

1. Reproduce or locate the exact code the comment is about.
2. Make the smallest change that addresses it.
3. **Verify with a real command.** A fix with no command result is not a fix.
4. Report the command and its exit code.

If a finding is wrong, say so with the reason. Do not implement it anyway — a
reviewer who is sometimes wrong is normal, and arguing costs a round trip but
implementing a non-bug costs a regression.

Do not fix what nobody asked about. Unrequested changes make the diff harder to
review, which defeats the purpose of the review.

## 6. Report

State, in this order:

1. **What you reviewed** — repo, PR number, head SHA you actually read.
2. **CI** — per check, with `bucket`. Pending and skipped are not passes.
3. **Findings** — each with its state: still stands, or stale and why.
4. **What you changed**, with the command and exit code that verified it.
5. **What you did not do**, and why.

If you found nothing in a category, say so plainly. An invented finding costs
more than a missed stylistic one — a reviewer who cries wolf is ignored the time
it matters.

## Never trust

Never report a result you did not observe. If a check could not be read, say it
could not be read. If `gh` failed, say `gh` failed. A summary that reads like a
pass is worse than one that reads like a blockage.