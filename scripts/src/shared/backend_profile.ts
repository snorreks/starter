/** Select the same backend for deployment and direct database commands; never guess an invalid selector. */
export const resolveBackendProfile = (value: string | undefined): 'legacy' | 'supabase' => {
  if (value === undefined) {
    return 'supabase';
  }
  if (value === 'legacy' || value === 'supabase') {
    return value;
  }
  throw new Error('STARTER_BACKEND_PROFILE must be legacy or supabase.');
};
