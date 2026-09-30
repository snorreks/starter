// Probe: what does this runtime actually expose?
const g = globalThis as { env?: unknown };
export default {
  async fetch(request: Request): Promise<Response> {
    const proc = typeof process !== 'undefined' ? (process.env as unknown as Record<string, unknown>) : undefined;
    return Response.json({
      processEnvHasDB: proc?.DB !== undefined,
      processEnvKeys: proc === undefined ? [] : Object.keys(proc).filter((k) => !k.startsWith('npm_')).slice(0, 20),
      globalEnvHasDB: (g.env as Record<string, unknown> | undefined)?.DB !== undefined,
    });
  },
};
