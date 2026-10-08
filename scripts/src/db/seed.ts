import { seedSupabaseLocal } from './seed_supabase.ts';

/** Seed only the checkout-owned local Supabase stack with synthetic data. */
export const main = async (args: readonly string[] = []): Promise<number> => {
  if (args.length > 0) {
    process.stderr.write('Supabase synthetic seed accepts no remote target; it is local only.\n');
    return 2;
  }
  try {
    const result = await seedSupabaseLocal();
    process.stdout.write(
      `Seeded local Supabase with synthetic user ${result.userId} and ${result.noteCount} notes.\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Local Supabase seed failed.'}\n`,
    );
    return 1;
  }
};
