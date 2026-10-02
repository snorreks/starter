// apps/frontend/client/src/lib/features/notes/notes_composition.ts
//
// Wiring. See auth_composition.ts for why this file exists.

import type { Note } from '@starter/schemas/notes';
import { type NotesService, notesService } from './notes_service.svelte.ts';
import { NotesViewModel } from './notes_view_model.svelte.ts';

export interface NotesComposition {
  notes?: NotesService;
  /** The list the SSR load already produced, so the first paint is not empty. */
  initialNotes?: readonly Note[];
}

/**
 * Build the notes screen's state.
 *
 * A factory rather than `new NotesViewModel()` at the route, so the transport
 * seam is visible where the screen is assembled. A ViewModel that imports the
 * service registry cannot be constructed with a fake, which would make every test
 * of this screen a test of the network.
 */
export const getNotesViewModel = (options: NotesComposition = {}): NotesViewModel =>
  new NotesViewModel({
    notes: options.notes ?? notesService,
    ...(options.initialNotes === undefined ? {} : { initialNotes: options.initialNotes }),
  });
