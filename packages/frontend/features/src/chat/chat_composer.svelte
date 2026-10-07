<!-- packages/frontend/features/src/chat/chat_composer.svelte -->
<!--
  The composer: a textarea, a send button, and the queued messages that could not
  be sent yet.

  Presentation and raised intents only. It holds no state beyond the element's own
  value and it calls no service — `ChatViewModel` owns every decision, which is what
  lets the queue's behaviour be tested without a DOM.
-->
<script lang="ts">
import { MESSAGE_CONTENT_MAX_LENGTH, validateMessageInput } from '@starter/schemas/chat';
import type { ChatViewModel } from './chat_view_model.svelte.ts';

type Props = {
  viewModel: ChatViewModel;
  /** Rendered without a submit affordance where scripting is unavailable. */
  progressive?: boolean;
};

let { viewModel, progressive = false }: Props = $props();

const fieldId = 'chat-composer';
const errors = $derived(
  viewModel.draft === '' ? {} : validateMessageInput({ content: viewModel.draft }),
);

const onInput = (event: Event): void => {
  viewModel.setDraft((event.currentTarget as HTMLTextAreaElement).value);
};

const onSubmit = (event: SubmitEvent): void => {
  event.preventDefault();
  void viewModel.send();
};
</script>

<form class="composer" data-testid="chat-composer" onsubmit={onSubmit} novalidate>
  <label class="composer__label" for={fieldId}>Message</label>
  <textarea
    id={fieldId}
    class="composer__input"
    data-testid="chat-input"
    name="content"
    rows="3"
    maxlength={MESSAGE_CONTENT_MAX_LENGTH}
    placeholder="Ask something…"
    value={viewModel.draft}
    disabled={viewModel.isStreaming}
    aria-invalid={errors.content === undefined ? undefined : 'true'}
    aria-describedby={errors.content === undefined ? undefined : `${fieldId}-error`}
    oninput={onInput}
  ></textarea>

  {#if errors.content !== undefined}
    <p class="composer__error" id={`${fieldId}-error`} data-testid="chat-error">
      {errors.content}
    </p>
  {/if}

  <div class="composer__actions">
    {#if viewModel.isStreaming}
      <button
        type="button"
        class="ui-button ui-button--secondary"
        data-testid="chat-cancel"
        onclick={() => viewModel.cancelTurn()}
      >
        Stop
      </button>
    {:else}
      <button
        type="button"
        class="ui-button ui-button--primary"
        data-testid="chat-send"
        disabled={!viewModel.canSend}
        onclick={() => void viewModel.send()}
      >
        Send
      </button>
    {/if}
  </div>

  <!--
    The queue, rendered as its own region.

    A queued message is one the server has never seen, so showing it inline with the
    transcript would claim it is in the conversation. It is separate, it says why it
    is waiting, and it offers both retry and discard — because a user who wrote three
    messages on a train should be able to send two of them.
  -->
  {#if viewModel.hasQueue}
    <section class="composer__queue" aria-live="polite" data-testid="chat-queue">
      <h2 class="composer__queue-title">
        {viewModel.queue.length} message{viewModel.queue.length === 1 ? '' : 's'} waiting to send
      </h2>
      <ul class="composer__queue-list">
        {#each viewModel.queue as entry (entry.clientId)}
          <li class="composer__queue-item" data-testid="chat-queue-item">
            <p class="composer__queue-text">{entry.content}</p>
            {#if entry.failure !== null}
              <p class="composer__queue-failure" data-testid="chat-queue-failure">
                {entry.failure}
              </p>
            {/if}
            <div class="composer__queue-actions">
              <button
                type="button"
                class="ui-button ui-button--secondary"
                data-testid="chat-queue-retry"
                onclick={() => void viewModel.flush()}
              >
                Retry all
              </button>
              <button
                type="button"
                class="ui-button ui-button--danger-ghost"
                data-testid="chat-queue-discard"
                onclick={() => viewModel.discard(entry.clientId)}
              >
                Discard<span class="ui-visually-hidden"> {entry.content}</span>
              </button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if progressive}
    <!--
      Progressive enhancement: the same controls render without a form action.

      Deliberately a plain notice rather than a fake submit. A form that posts to a
      route which does not exist is a 404 the user sees; saying so plainly is what
      the `progressive` flag is for.
    -->
    <p class="composer__notice">Sending requires scripting.</p>
  {/if}
</form>

<style>
  .composer {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .composer__label {
    font-weight: 600;
  }

  .composer__input {
    width: 100%;
    resize: vertical;
    font: inherit;
    padding: var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .composer__input[aria-invalid='true'] {
    border-color: var(--color-danger-border);
  }

  .composer__error {
    color: var(--color-danger-text);
    margin: 0;
  }

  .composer__actions {
    display: flex;
    gap: var(--space-2);
  }

  .composer__notice {
    color: var(--color-text-muted);
    margin: 0;
  }

  .composer__queue {
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-1);
    padding: var(--space-2);
  }

  .composer__queue-title {
    font-size: 0.9rem;
    margin: 0 0 var(--space-1);
  }

  .composer__queue-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .composer__queue-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .composer__queue-text {
    margin: 0;
  }

  .composer__queue-failure {
    margin: 0;
    color: var(--color-danger-text);
    font-size: 0.9rem;
  }

  .composer__queue-actions {
    display: flex;
    gap: var(--space-2);
  }
</style>
