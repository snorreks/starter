import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { parseUpdateArgs, runUpdate } from '../update/update.ts';

/** One uncached, selective updater for Nix, Bun, and all workspace packages. */
export const updateCommand: Command = {
  name: 'update',
  summary: 'preview or update Nix, Bun pins/runtime, and exact workspace dependencies',
  usage:
    'update [--nix] [--bun] [--packages] [--no-<lane>] [--bun-version <version>] [--yes] [--verify]',
  async run(args) {
    if (wantsHelp(args)) {
      process.stdout.write(
        `${this.usage}\nNo selectors means all lanes. No --yes means an offline preview.\n`,
      );
      return EXIT.ok;
    }
    let options: ReturnType<typeof parseUpdateArgs>;
    try {
      options = parseUpdateArgs(args);
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Invalid update arguments.', EXIT.usage);
    }
    return runUpdate(options);
  },
};
