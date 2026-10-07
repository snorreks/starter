export const requireVisualBackend = (backend: string | undefined): 'legacy' => {
  if (backend !== undefined && backend !== 'legacy') {
    throw new Error(
      `Visual capture currently supports the legacy local backend; ${JSON.stringify(backend)} has no declared visual fixtures. Run bun run e2e:visual without a backend override.`,
    );
  }
  return 'legacy';
};
