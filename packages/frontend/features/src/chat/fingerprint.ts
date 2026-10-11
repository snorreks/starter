// packages/frontend/features/src/chat/fingerprint.ts
//
// A cheap identity for "what the server currently holds", used to decide whether a
// background re-read found anything worth collapsing a poll's backoff for.
//
// One function rather than one per screen, because the property that makes it
// correct is a property of the *encoding*: if the two screens hashed differently,
// one of them would compare two lists that are in fact identical and hold its
// transport at the floor forever, and nothing would say why.

/**
 * Identity and content, in a form two snapshots cannot collide by rearrangement.
 *
 * Content is compared as well as identity because a stored row's text never
 * changes — a reply is written once, at the end of a turn — so equal id sets with
 * equal text is what "unchanged" means here. Ordering matters, so the rows are
 * compared in the order the screen holds them rather than sorted: a reordered list
 * *is* a change the user can see.
 *
 * JSON tuples escape embedded newlines and preserve field boundaries, so moving
 * text between an id and its content cannot produce the same encoding.
 */
export const fingerprint = (
  rows: readonly { readonly id: string; readonly content: string }[],
): string => rows.map((row) => JSON.stringify([row.id, row.content])).join('\n\n');
