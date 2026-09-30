export default {
  async fetch(_r: Request, env: Record<string, unknown>): Promise<Response> {
    return Response.json({ hasVar: env.AUTH_RATE_LIMIT_MAX ?? null, keys: Object.keys(env) });
  },
};
