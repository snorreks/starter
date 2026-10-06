<!-- packages/frontend/features/src/chat/chat_view.svelte -->
<!--
  A conversation: the transcript, and the composer.

  Three presentation rules the markup exists to keep:

  1. **A streaming reply is announced, not just appended.** `aria-live="polite"` on
     the transcript, and the streaming row carries a status role. A reply that
     appears one character at a time without being announced is unreadable to a
     screen reader — and a streamed reply is the one piece of this UI whose arrival
     the user cannot see is progress.
  2. **Per-message state is visible.** A message that is pending, streaming or failed
     says so, because "it did nothing when I pressed send" is the failure a user
     cannot diagnose on their own. The queue region in the composer covers the
     unsent case; this covers the sent-but-unanswered one.
  3. **The transcript scrolls itself, but only when the reader is at the bottom.**
     Scrolling unconditionally yanks the view away from someone reading earlier
     messages while a reply streams in — the reply that makes them want to scroll up.
-->
<script lang="ts">
import { EmptyState, ErrorState, ScreenContainer, Spinner } from '@starter/ui';
import ChatComposer from './chat_composer.svelte';
import type { ChatMessageView, ChatViewModel } from './chat_view_model.svelte.ts';

type Props = {
  viewModel: ChatViewModel;
};

let { viewModel }: Props = $props();

let transcript = $state<HTMLElement | null>(null);
let pinnedToBottom = $state(true);

/**
 * Whether the reader is at the bottom.
 *
 * Measured with a small tolerance rather than exactly 0: sub-pixel layout means a
 * reader scrolled to the bottom routinely reports a few pixels of slack, and an
 * exact check would decide it is not pinned and then refuse to follow the stream.
 */
const nearBottom = (element: HTMLElement): boolean =>
  element.scrollHeight - element.scrollTop - element.clientHeight < 24;

const onScroll = (): void => {
  if (transcript !== null) {
    pinnedToBottom = nearBottom(transcript);
  }
};

/**
 * Follow the stream, but only while the reader wants to be followed.
 *
 * `$effect` rather than a scroll call inside the ViewModel: this is a property of
 * the DOM, and a ViewModel that reached for `scrollTop` could not be tested without
 * a document.
 */
$effect(() => {
  // Reading the transcript's content length is what makes this re-run per delta.
  const count = viewModel.transcript.length;
  const last = viewModel.transcript[count - 1]?.content.length ?? 0;
  if (transcript !== null && pinnedToBottom) {
    transcript.scrollTop = transcript.scrollHeight;
  }
  void last;
});

const stateLabel = (message: ChatMessageView): string | null => {
  switch (message.state) {
    case 'pending':
      return 'Sending…';
    case 'streaming':
      return 'Replying…';
    case 'failed':
      return 'Not delivered';
    default:
      return null;
  }
};
</script>

<ScreenContainer screen={viewModel} element="section" id="chat-screen">
  <header class="chat__header">
    <h1 class="chat__title">{viewModel.conversation?.title ?? 'Chat'}</h1>
    <button
      type="button"
      class="ui-button ui-button--secondary"
      data-testid="chat-refresh"
      onclick={() => void viewModel.reload()}
      disabled={viewModel.status.kind === 'loading'}
    >
      Refresh
    </button>
  </header>

  <div class="chat__body">
    {#if viewModel.status.kind === 'loading'}
      <div class="chat__loading" role="status" aria-live="polite">
        <Spinner /><span>Loading the conversation…</span>
      </div>
    {:else if viewModel.status.kind === 'error'}
      <ErrorState
        title="Could not load the conversation"
        message={viewModel.status.message}
        retryable={viewModel.status.retryable}
        onRetry={() => void viewModel.reload()}
        testId="chat-error-state"
      />
    {:else if viewModel.transcript.length === 0}
      <EmptyState
        title="No messages yet"
        body="Send one below. The reply arrives token by token, streamed from the Worker."
        testId="chat-empty"
      />
    {:else}
      <ol
        class="chat__transcript"
        data-testid="chat-transcript"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation"
        bind:this={transcript}
        onscroll={onScroll}
      >
        {#each viewModel.transcript as message (message.clientId)}
          <li
            class="chat__message chat__message--{message.role}"
            data-testid="chat-message"
            data-role={message.role}
            data-state={message.state}
          >
            <p class="chat__message-text">{message.content}</p>
            {#if stateLabel(message) !== null}
              <p class="chat__message-state" role="status" data-testid="chat-message-state">
                {stateLabel(message)}
              </p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>

  <ChatComposer {viewModel} />
</ScreenContainer>

<style>
  .chat__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .chat__title {
    margin: 0;
    font-size: 1.25rem;
  }

  .chat__body {
    min-height: 8rem;
  }

  .chat__loading {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .chat__transcript {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-height: 24rem;
    overflow-y: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
  }

  .chat__message {
    padding: var(--space-2);
    border-radius: var(--radius-1);
    background: var(--color-surface-raised);
  }

  .chat__message--user {
    background: var(--color-accent-soft);
  }

  .chat__message[data-state='failed'] {
    border: 1px solid var(--color-danger-border);
  }

  .chat__message-text {
    margin: 0;
    /* Streaming text must not reflow the row on every chunk. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .chat__message-state {
    margin: var(--space-1) 0 0;
    font-size: 0.85rem;
    color: var(--color-text-muted);
  }
</style>