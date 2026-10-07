// apps/frontend/client/src/lib/composition/notes.ts
//
// The web application's notes wiring.
//
// The shared feature exports a View, a ViewModel and a service. What it cannot
// export is a constructed one: a service needs an `ApiTransport`, and which
// transport a host has is the host's decision. So this file is where the web
// application's answer lives, and the route imports from here.
//
// A factory rather than `new NotesViewModel()` at the route, so the transport seam
// stays visible where the screen is assembled. A ViewModel that resolved its own
// service from a module registry could not be constructed with a fake, which would
// make every test of this screen a test of the network.

import type { NotesScreenService } from '@starter/features/notes';
import { NotesService, NotesViewModel } from '@starter/features/notes';
import type { Note } from '@starter/schemas/notes';
import { createRemoteNotesFeatureService } from './notes_remote_adapter.ts';
import { webTransport } from './transport.ts';

export interface NotesComposition {
  notes?: NotesScreenService;
  remote?: boolean;
  /** The list the SSR load already produced, so the first paint is not empty. */
  initialNotes?: readonly Note[];
}

/**
 * One service for the application.
 *
 * The service holds no state — the note list lives in the ViewModel that owns the
 * screen — so a single instance cannot disagree with a second one. It is created
 * here rather than in the feature package for exactly that reason: the feature must
 * not know which host it is running in.
 */
const notesService = new NotesService({ transport: webTransport, className: 'NotesService' });
const remoteNotesService = createRemoteNotesFeatureService();

export const getNotesViewModel = (options: NotesComposition = {}): NotesViewModel =>
  new NotesViewModel({
    notes: options.notes ?? (options.remote ? remoteNotesService : notesService),
    ...(options.initialNotes === undefined ? {} : { initialNotes: options.initialNotes }),
  });
