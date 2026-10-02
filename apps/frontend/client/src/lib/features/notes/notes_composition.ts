// apps/frontend/client/src/lib/features/notes/notes_composition.ts
//
// Wiring: the feature's one seam on its dependencies.
//
// This separation is the point of the convention. A ViewModel that imports the
// service registry cannot be constructed with a fake, so every test of a
// ViewModel becomes a test of the network. Injecting through a composition root
// keeps `createNotesViewModel({ notes: fakeService })` possible, which is what
// makes the ViewModel unit-testable without a server.
//
// It is also the single place to change when a screen's dependencies change:
// one file, not every ViewModel.

import type { Note } from '@starter/schemas/notes';
import { type NotesService, notesService } from './notes_service.svelte.ts';
import { createNotesViewModel, type NotesViewModel } from './notes_view_model.svelte.ts';

export interface NotesComposition {
  notes?: NotesService;
  /** The list the SSR load already produced, so the first paint is not empty. */
  initialNotes?: Note[];
}

export const getNotesViewModel = (options: NotesComposition = {}): NotesViewModel =>
  createNotesViewModel({
    className: 'NotesViewModel',
    ...(options.notes === undefined ? {} : { notes: options.notes }),
    ...(options.initialNotes === undefined ? {} : { initialNotes: options.initialNotes }),
  });

/** The app-wide default. Prefer `getNotesViewModel` so the seam stays obvious. */
export const defaultNotesViewModel = (): NotesViewModel =>
  getNotesViewModel({ notes: notesService });
