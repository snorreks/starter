<!--
  packages/frontend/ui/src/base/base_view_model_container.svelte

  Owns exactly the ViewModel instance it mounts. This component is the single
  lifecycle owner for that instance: it initializes once per mount and disposes
  once per mount.

  The teardown logic here is deliberately not simpler. `initialize()` is async,
  so a component can unmount while it is still in flight; disposing at that
  moment is a use-after-free, and skipping disposal leaks whatever the
  ViewModel allocated. The correct behaviour is to remember that unmount
  happened, let `initialize()` settle, and dispose exactly once afterwards.
-->
<script lang="ts">
import type { BaseViewModelInterface } from '@starter/frontend-services/base';
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import Spinner from '../feedback/spinner.svelte';

type Props = HTMLAttributes<HTMLElement> & {
  viewModel: BaseViewModelInterface;
  /** Test id. Defaults to the ViewModel's class name. */
  id?: string;
  /** Label announced while the loading state is shown. */
  loadingLabel?: string;
  children: Snippet;
  element?: 'div' | 'footer' | 'header' | 'main' | 'section' | 'article' | 'aside' | 'nav';
};

let {
  viewModel,
  id,
  loadingLabel = 'Loading',
  children,
  class: className,
  element = 'div',
  ...attributes
}: Props = $props();

// Initialization and disposal are fire-and-forget, so a rejection would
// otherwise surface as an unhandled rejection naming no component.
const reportLifecycleFailure = (
  phase: 'initialize' | 'dispose',
  instance: BaseViewModelInterface,
  error: unknown,
): void => {
  console.error(`[BaseViewModelContainer] ${phase}() failed for "${instance.className}"`, error);
};

$effect(() => {
  const instance = viewModel;

  // Depend on the `viewModel` prop only. If this effect tracked reactive
  // state that `initialize()` writes, the instance would dispose and
  // re-initialize itself in a loop.
  return untrack(() => {
    // An instance already owned elsewhere (a panel its parent retains across
    // tab switches) is left alone: one owner at a time.
    if (instance.__mounted) {
      return;
    }
    instance.__mounted = true;

    let stillMounted = true;
    let initializeSettled = false;
    let disposed = false;

    const disposeOnce = (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      instance.__mounted = false;
      void instance.dispose().catch((error: unknown) => {
        reportLifecycleFailure('dispose', instance, error);
      });
    };

    void instance
      .initialize()
      .catch((error: unknown) => {
        reportLifecycleFailure('initialize', instance, error);
      })
      .finally(() => {
        initializeSettled = true;
        if (!stillMounted) {
          disposeOnce();
        }
      });

    return () => {
      stillMounted = false;
      if (initializeSettled) {
        disposeOnce();
      }
    };
  });
});
</script>

<svelte:element
  this={element}
  {...attributes}
  data-testid={id ?? viewModel.className}
  class={className}
>
  {#if viewModel.showLoadingView}
    <div class="ui-loading" role="status" aria-live="polite">
      <Spinner />
      <span class="ui-loading__label">{loadingLabel}</span>
    </div>
  {:else}
    {@render children()}
  {/if}
</svelte:element>

<style>
  .ui-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    min-height: 12rem;
    color: var(--color-text-muted);
  }

  .ui-loading__label {
    font-size: var(--font-size-sm);
  }
</style>
