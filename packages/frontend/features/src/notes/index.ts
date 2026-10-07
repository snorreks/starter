// packages/frontend/features/src/notes/index.ts
//
// The notes feature's public surface.
//
// Routes import from here; the internals stay private so a screen's wiring can
// change without touching every caller.
//
// Note what is *not* here: no singleton service and no composition factory.
// Both need an `ApiTransport`, and which transport a host has is the host's
// decision — `apps/frontend/client/src/lib/composition/notes_composition.ts`
// builds the web one. A shared factory with a default would resolve the default
// at module scope, which is the same app-singleton this extraction removed.

export { default as NoteCard } from './note_card.svelte';
export { default as NoteForm } from './note_form.svelte';
export { NotesService } from './notes_service.ts';
export { default as NotesView } from './notes_view.svelte';
export {
  type NotesScreenOptions,
  type NotesScreenService,
  type NotesStatus,
  NotesViewModel,
} from './notes_view_model.svelte.ts';
