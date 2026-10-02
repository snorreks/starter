// apps/frontend/client/src/dom_repair.d.ts
//
// Restore the DOM signatures that the Workers runtime types override.
//
// One full-stack SvelteKit program compiles two runtimes at once: `src/lib/server/**`
// and the `+server.ts` adapters need the Workers globals, and the components, the
// browser tests and Svelte's own `mount()` need the DOM. Both global sets have to
// be in the program, and `@cloudflare/workers-types` (and the `wrangler types`
// output, which is generated from the same runtime) declare a global `interface
// Element` for `HTMLRewriter` — the HTML-sanitiser element, not the DOM one.
//
// TypeScript merges the two `Element` interfaces, and the HTMLRewriter versions of
// five methods win:
//
//     before / after / prepend / append / replace
//
// all typed as `(content: string | ReadableStream | Response, options?) => Element`.
// In a real DOM, `element.append(childNode)` is the single most common way to add a
// node, so the shadowing produces errors in correct browser code:
//
//     Error: Argument of type 'HTMLSpanElement' is not assignable to
//     parameter of type 'string | Response | ReadableStream<any>'.
//
// This is a known upstream conflict, not something this project introduced:
// sveltejs/kit#8268, fixed in sveltejs/kit#8483. It is documented here because the
// fix in this repository is deliberately local and narrow, and a reader who finds
// this file needs to know it is a workaround for a platform-type collision rather
// than a preference.
//
// Why the overloads below are safe and sufficient:
//
//   * Interface merging *adds* overloads, it cannot remove the HTMLRewriter ones.
//     The Workers signatures stay available, so server code that really does hold
//     an `HTMLRewriter` element keeps type-checking against the right shape.
//   * Only the five colliding methods are listed. Everything else on `Element`
//     merges cleanly, and adding more would be guessing at a collision that does
//     not exist.
//   * Each signature is the DOM lib's, copied rather than invented. `Node | string`
//     is what `ParentNode.append` accepts, and `void` is its return — the
//     HTMLRewriter variant returns `Element`, which is why the shadowing changes
//     the shape of *every* call site and not just the argument.
//
// Nothing here suppresses a diagnostic. If a real browser call is wrong, it is
// still an error: the restored overloads are the real ones.

interface Element {
  before(...nodes: (Node | string)[]): void;
  after(...nodes: (Node | string)[]): void;
  prepend(...nodes: (Node | string)[]): void;
  append(...nodes: (Node | string)[]): void;
  replace(...nodes: (Node | string)[]): void;
}
