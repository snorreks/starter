# SvelteKit 3 subpath imports

Why `vite.config.ts` maps `#lib` through `sveltekit({ alias: … })` instead of a
`package.json` `imports` entry, and why the workspace packages are pointed at their
`src` directories rather than their entry points.

Written because `vite.config.ts` refers to this file, and a comment pointing at a
document that does not exist is worse than no comment.

## The problem

SvelteKit 3 removed the built-in `$lib` alias. Two replacements are on the table:

```jsonc
// Option A — package.json "imports"
{
  "imports": { "#lib": "./src/lib/index.ts" }
}
```

```ts
// Option B — sveltekit({ alias })
sveltekit({ alias: { '#lib': 'src/lib' } })
```

Option A resolves in Vite and in Node, and then **fails `svelte-check`**. It
resolved in two of the three places that matter and produced an error naming a
symbol rather than a config, which cost a debugging cycle.

Option B works, and SvelteKit turns each `alias` entry into a `paths` entry in the
generated tsconfig. One declaration reaches TypeScript and the bundler, so the two
cannot disagree.

`alias` is deprecated in favour of subpath imports, so this is a deliberate
exception rather than a default. It is the option that typechecks today.

## Why the targets are directories, not files

```ts
alias: {
  '@starter/schemas': '../../../packages/shared/schemas/src',
  // …not '../../../packages/shared/schemas/src/index.ts'
}
```

SvelteKit only synthesises the `name/*` path mapping when the alias value has **no
file extension**. Point it at `index.ts` and every subpath import
(`@starter/schemas/notes`) silently breaks — resolving to `…/src/index.ts/notes`,
which does not exist, with an error that names a path nobody wrote.

## Why the packages are aliased at all

Each workspace package is reached through its published name (`@starter/schemas`,
`@starter/ui`), which is also what the workspace boundary guard reads. Two
consequences:

- a violation is visible as a forbidden package name rather than as a relative path
  crossing a project boundary
- `svelte-check` follows imports into the packages' TypeScript sources, so those
  files must resolve from the client's program

`vitest.config.ts` cannot reuse this. It stands alone — deliberately, because
resolution must not depend on SvelteKit having generated anything — so it spells out
its own aliases. Two alias lists is a drift risk; they are kept aligned by the fact
that both must work or a lane fails.

## If you add a workspace package

1. add it to `apps/frontend/client/vite.config.ts`'s `alias`
2. add it to `apps/frontend/client/vitest.config.ts`'s `packageAliases`
3. point at its `src` **directory**, not its entry file
4. add it to the client's `dependsOn` in `apps/frontend/client/moon.yml`

Step 3 is the one that bites.