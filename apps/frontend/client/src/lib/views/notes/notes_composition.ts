// apps/frontend/client/src/lib/views/notes/notes_composition.ts
//
// Wiring. The only module in the feature allowed to import `#lib/services`.
//
// This separation is the point of the convention. A ViewModel that imports the
// service registry cannot be constructed with a fake, so every test of a
// ViewModel becomes a test of the network. Injecting through a composition root
// keeps `createNotesViewModel({ notes: fakeService })` possible, which is what
// makes the ViewModel unit-testable without a server.
//
// It is also the single place to change when a screen's dependencies change:
// one file, not every ViewModel.

import { notesService, type NotesService } from '#lib/services/notes_service.svelte.ts';
import { createNotesViewModel, type NotesViewModel } from './notes_view_model.svelte.ts';

export type NotesComposition = {
  notes?: NotesService;
};

export const getNotesViewModel = (options: NotesComposition = {}): NotesViewModel =>
  createNotesViewModel({
    className: 'NotesViewModel',
    ...(options.notes === undefined ? {} : { notes: options.notes }),
  });

/** The app-wide default. Prefer `getNotesViewModel` so the seam stays obvious. */
export const defaultNotesViewModel = (): NotesViewModel => getNotesViewModel({ notes: notesService });
