<!-- packages/frontend/features/src/chat/chat_list_view.svelte -->
<!--
  The conversation list, and the composer for starting another.

  Presentation and raised intents only. Every decision — whether a create is allowed,
  what to do after one succeeds, how to report a failure — belongs to the ViewModel.
-->
<script lang="ts">
import { EmptyState, ErrorState, ScreenContainer, Spinner } from '@starter/ui';
import type { ChatListViewModel } from './chat_list_view_model.svelte.ts';

type Props = {
  viewModel: ChatListViewModel;
};

let { viewModel }: Props = $props();

const fieldId = 'chat-new-title';
</script>

<ScreenContainer screen={viewModel} element="section" id="chat-list-screen">
  <header class="list__header">
    <h1 class="list__title">Conversations</h1>
    <button
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="chat-list-refresh"
      onclick={() => void viewModel.load()}
      disabled={viewModel.status.kind === 'loading'}
    >
      Refresh
    </button>
  </header>

  <form
    class="list__new"
    data-testid="chat-new-form"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      void viewModel.create();
    }}
  >
    <label class="list__label" for={fieldId}>New conversation</label>
    <input
      id={fieldId}
      class="list__input"
      data-testid="chat-new-title"
      name="title"
      type="text"
      maxlength="120"
      placeholder="What is this about?"
      value={viewModel.draftTitle}
      aria-describedby={viewModel.createError === null ? undefined : `${fieldId}-error`}
      aria-invalid={viewModel.createError === null ? undefined : 'true'}
      oninput={(event) =>
        viewModel.setDraftTitle((event.currentTarget as HTMLInputElement).value)}
    />
    <button
      type="submit"
      class="ui-button ui-button--primary"
      data-testid="chat-new-submit"
      disabled={!viewModel.canCreate}
    >
      {viewModel.isCreating ? 'Creating…' : 'Start'}
    </button>
    {#if viewModel.createError !== null}
      <p class="list__error" id={`${fieldId}-error`} role="alert" data-testid="chat-new-error">
        {viewModel.createError}
      </p>
    {/if}
  </form>

  {#if viewModel.status.kind === 'loading'}
    <div class="list__loading" role="status" aria-live="polite">
      <Spinner /><span>Loading conversations…</span>
    </div>
  {:else if viewModel.status.kind === 'error'}
    <ErrorState
      title="Could not load your conversations"
      message={viewModel.status.message}
      retryable={viewModel.status.retryable}
      onRetry={() => void viewModel.load()}
      testId="chat-list-error"
    />
  {:else if viewModel.isEmpty}
    <EmptyState
      title="No conversations yet"
      body="Start one above. Every turn streams its reply token by token from the Worker."
      testId="chat-list-empty"
    />
  {:else}
    <ul class="list__items" data-testid="chat-list">
      {#each viewModel.conversations as conversation (conversation.id)}
        <li class="list__item" data-testid="chat-list-item" data-conversation-id={conversation.id}>
          <button
            type="button"
            class="list__open"
            data-testid="chat-list-open"
            onclick={() => void viewModel.open(conversation)}
          >
            <span class="list__item-title">{conversation.title}</span>
            <span class="list__item-count">
              {conversation.messageCount}
              message{conversation.messageCount === 1 ? '' : 's'}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</ScreenContainer>

<style>
  .list__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .list__title {
    margin: 0;
    font-size: 1.25rem;
  }

  .list__new {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-block: var(--space-3);
  }

  .list__label {
    font-weight: 600;
    flex-basis: 100%;
  }

  .list__input {
    flex: 1;
    min-width: 12rem;
    font: inherit;
    padding: var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .list__error {
    flex-basis: 100%;
    margin: 0;
    color: var(--color-danger-text);
  }

  .list__loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .list__items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .list__open {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    font: inherit;
    cursor: pointer;
    padding: var(--space-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-text);
  }

  .list__item-title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .list__item-count {
    color: var(--color-text-muted);
    font-size: 0.9rem;
    white-space: nowrap;
  }
</style>