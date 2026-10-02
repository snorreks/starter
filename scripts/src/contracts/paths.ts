// scripts/src/contracts/paths.ts
//
// Where briefs live.
//
// This path is in the domain rather than in the command adapter, because
// `status.ts` lists briefs from it too, and importing it back out of
// `commands/contracts.ts` made the domain depend on the adapter that dispatches
// it. That is a cycle in the wrong direction — the adapter may know about the
// domain, never the reverse — and it is the kind that loads correctly right up
// until the first lazy import or the first test.
//
// The values are unchanged; only their owner moved.

import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

export const CONTRACTS_DIR = join(REPO_ROOT, 'docs/contracts');
