const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== 'dev') {
  process.stderr.write(
    'The jobs Worker has no standalone local runtime. Use `bun run test:compute -- --backend supabase --processor cloud-run-local` for the real Cloud Run runner lane.\n',
  );
  process.exit(2);
}
process.stderr.write(
  'The jobs Worker is a Cloud Run dispatcher. Local development requires explicit Supabase and Cloud Run prerequisites; use the web application runtime or run the documented compute lane.\n',
);
process.exit(1);
