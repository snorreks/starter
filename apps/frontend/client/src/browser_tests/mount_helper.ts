// apps/frontend/client/src/browser_tests/mount_helper.ts
//
// Mount a component into a real DOM node and clean it up afterwards.
//
// `mount()` needs an explicit `target` in a browser. Svelte 5's two-argument
// form falls back to `document.body` only outside a browser context, so under
// Vitest's browser provider it reaches for a target that does not exist and
// fails with "Cannot read properties of undefined (reading 'appendChild')" — an
// error that says nothing useful about the component under test.

import { flushSync, mount, unmount, type Component, type Snippet } from 'svelte';

export type Mounted = {
  /** The element the component was mounted into. */
  target: HTMLElement;
  /** Unmount and remove the target from the document. */
  destroy(): void;
};

/**
 * An empty children snippet.
 *
 * A component that renders `{@render children()}` needs a real snippet: passing
 * `undefined` makes the render throw, which looks like a component bug.
 */
export const emptySnippet = (() => {
  /* renders nothing */
}) as Snippet;

export const mountInDocument = <P extends Record<string, unknown>>(
  ComponentUnderTest: Component<P>,
  props: P,
): Mounted => {
  const target = document.createElement('div');
  target.setAttribute('data-test-root', '');
  document.body.append(target);

  const component = mount(ComponentUnderTest, { target, props });
  flushSync();

  return {
    target,
    destroy() {
      unmount(component);
      flushSync();
      target.remove();
    },
  };
};
