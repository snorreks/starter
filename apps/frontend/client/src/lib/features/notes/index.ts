// apps/frontend/client/src/lib/features/notes/index.ts
//
// The feature's public surface. Routes import from here; the internals stay
// private so a screen's wiring can change without touching every caller.

export { getNotesViewModel, type NotesComposition } from './notes_composition.ts';
export { type NotesService, notesService } from './notes_service.svelte.ts';
export { default as NotesView } from './notes_view.svelte';
export {
  createNotesViewModel,
  type NotesStatus,
  NotesViewModel,
} from './notes_view_model.svelte.ts';
