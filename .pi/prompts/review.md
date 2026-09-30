---
description: Review changes for correctness, security and convention
argument-hint: "[focus]"
---
Review the current diff. Focus on ${1:-correctness, authorization and error handling}.

For each finding, give the file and line, what breaks, and the concrete failure
that makes it observable. Do not report style a formatter already handles.

Prioritise in this order:

1. **Authorization.** Is ownership enforced in the query, or after the fetch? A
   row fetched and then checked has already leaked.
2. **Input refusal.** Does a schema use `additionalProperties: false`? An
   unknown field that is silently dropped tells the client the write succeeded.
3. **Concurrency.** Is there async work without a `StaleGuard`, so a superseded
   response can overwrite a newer one?
4. **Silent failure.** Any swallowed error, ignored flag, or `catch` that logs
   and continues. Each turns a loud failure into a wrong result.
5. **Boundary violations.** Does a shared package import a plane, or the API
   import Svelte? `bun run guard` catches these; a violation in a diff means the
   guard was not run.

State clearly if you found nothing in a category. Do not invent findings to fill
the categories — an invented finding costs more than a missed stylistic one.
