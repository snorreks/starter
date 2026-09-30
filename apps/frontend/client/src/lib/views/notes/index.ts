// apps/frontend/client/src/lib/views/notes/index.ts
export { getNotesViewModel, type NotesComposition } from './notes_composition.ts';
export { default as NotesView } from './notes_view.svelte';
export {
  createNotesViewModel,
  type NotesStatus,
  NotesViewModel,
} from './notes_view_model.svelte.ts';
