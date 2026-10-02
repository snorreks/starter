// scripts/src/commands/contracts.ts
//
//   bun run contract new "<title>"
//   bun run contract status [id]
//
// This writes and lists documents. It does not execute them.
//
// The command used to carry a stage runner: `implement`, `verify`, `accept`, a
// resume protocol, a persisted run manifest, and a `--dry-run` adapter that did
// no work at all. A non-dry run refused with exit 3 and the message "phase 5
// wires up the real adapter" — that phase never arrived, so the whole surface was
// a claim the repository could not keep. A run that cannot execute is not a
// runner with a missing adapter; it is a template.
//
// What is worth keeping is the part that always worked: a short written brief
// whose acceptance criteria name commands, which a person or an agent then
// carries out with `bun run` directly and a pull request. The full workflow is
// in docs/contracts/README.md. Adding an execution engine back is a decision
// somebody has to make deliberately, with an adapter that does work.
//
// Exit codes:
//   0  the document was written, or the listing was printed
//   1  blocked — the requested document does not exist
//   2  usage error

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACTS_DIR } from '../contracts/paths.ts';
import { readContracts } from '../contracts/status.ts';
import type { Command } from '../shared/command.ts';
import { EXIT } from '../shared/command.ts';

// Re-exported so callers reach one module's answer: the domain owns where the
// files are (`../contracts/paths.ts`), and a path redefined here is a path that
// can disagree with it.
export { CONTRACTS_DIR } from '../contracts/paths.ts';

// The shared table is used directly. This command has no local codes of its own
// to distinguish: a missing document is a failed lookup, and inventing a
// parallel `blocked` here would only produce a second name for one number.

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const TEMPLATE = 'TEMPLATE.md';

/**
 * Next numeric brief id.
 *
 * Reads the directory rather than a counter file, so two scaffolds racing on a
 * fresh checkout produce two documents with the same id — visible at review and
 * harmless, where a shared counter file would be silently wrong instead.
 */
export const nextContractId = (dir = CONTRACTS_DIR): string => {
  if (!existsSync(dir)) {
    return 'C-001';
  }
  const highest = readdirSync(dir)
    .map((name) => /^C-(\d+)/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .reduce((max, match) => Math.max(max, Number(match[1])), 0);
  return `C-${String(highest + 1).padStart(3, '0')}`;
};

/**
 * Write a new brief from the template.
 *
 * `dir` is a parameter so the test can prove the substitution against a temporary
 * directory. Asserting it against `docs/contracts/` would mean writing into the
 * repository to test a function that writes files.
 */
export const scaffold = (title: string, dir = CONTRACTS_DIR): string => {
  const id = nextContractId(dir);
  const templatePath = join(dir, TEMPLATE);

  if (!existsSync(templatePath)) {
    throw new Error(`No template at ${templatePath}.`);
  }

  const body = readFileSync(templatePath, 'utf8')
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, () => title);

  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${slugify(title)}.md`);
  writeFileSync(path, body);
  return path;
};

const usage = (): string =>
  [
    'Usage:',
    '  bun run contract new "<title>"',
    '  bun run contract status [id]',
    '',
    'This writes and lists documents. It executes nothing: carry the brief out with',
    'the commands named in its Verification section, and open a pull request.',
  ].join('\n');

const describeRow = (row: { id: string; status: string; file: string }): string =>
  `  ${row.id.padEnd(8)} ${row.status.padEnd(10)} ${row.file}\n`;

export const main = async (args: readonly string[]): Promise<number> => {
  const [command, ...rest] = args;

  if (command === 'new') {
    const title = rest.find((value) => !value.startsWith('-'));
    if (title === undefined) {
      process.stderr.write('Usage: bun run contract new "<title>"\n');
      return EXIT.usage;
    }

    const path = scaffold(title);
    process.stdout.write(
      `Created ${path}\n\n` +
        'This created a document. Nothing has been run, merged or deployed.\n' +
        'Fill in the acceptance criteria and the verification commands, then do the work.\n',
    );
    return EXIT.ok;
  }

  if (command === 'status') {
    const wanted = rest.find((value) => !value.startsWith('-'));

    if (wanted !== undefined) {
      const rows = readContracts().filter((row) => row.id === wanted);
      if (rows.length === 0) {
        process.stderr.write(`No brief with id ${wanted} in ${CONTRACTS_DIR}.\n`);
        return EXIT.failed;
      }
      process.stdout.write(`${describeRow(rows[0])}\n`);
      return EXIT.ok;
    }

    const rows = readContracts();
    if (rows.length === 0) {
      process.stdout.write('No briefs yet. Create one with: bun run contract new "<title>"\n');
      return EXIT.ok;
    }

    process.stdout.write(`${rows.length} brief(s)\n\n`);
    for (const row of rows) {
      process.stdout.write(describeRow(row));
    }
    return EXIT.ok;
  }

  // `run` used to be a subcommand that could not run anything. Naming it here is
  // the difference between a typo and a migration: someone who remembers the old
  // surface gets told what to do instead of a bare usage line.
  if (command === 'run' || command === 'resume') {
    process.stderr.write(
      `\`contract ${command}\` was removed with the runner that could not execute anything.\n` +
        'Nothing in this repository executes a brief autonomously. Write the brief, then run the\n' +
        'commands its Verification section names and open a pull request.\n' +
        'See docs/contracts/README.md.\n',
    );
    return EXIT.usage;
  }

  process.stderr.write(`${usage()}\n`);
  return EXIT.usage;
};

/** Dispatcher descriptor. The argv work above is the whole implementation. */
export const contractCommand: Command = {
  name: 'contract',
  summary: 'create and list written work briefs',
  usage: 'contract new|status [options]',
  run: main,
};
