// apps/frontend/native/src/lib/composition/notes.ts
//
// The native host's notes service. One line, and that is the point.
//
// The service itself, its ViewModel, its lifecycle guards and its two components
// are the ones the web app renders. What differs is the transport behind them:
// same `ApiTransport`, one browser with a cookie and one shell with a bearer
// token. A second implementation of the notes feature in this application would
// be the exact failure `@starter/features` was extracted to prevent.

import { NotesService } from '@starter/features/notes';
import { nativeTransport } from './session.ts';

export const notesService = new NotesService({
  transport: nativeTransport,
  className: 'NativeNotesService',
});

export { NotesViewModel } from '@starter/features/notes';
