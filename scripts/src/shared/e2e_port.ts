import { allocatePort, isPortBusy, PortUnavailable, runScope } from './run_scope.ts';

/** Resolve and probe the listener port owned by one E2E invocation. */
export const resolveE2EPort = async (
  runId: string,
  explicitPort?: string,
  root?: string,
): Promise<number> => {
  // runScope validates the identity before it participates in any derived path.
  runScope(runId, root);

  if (explicitPort !== undefined && explicitPort !== '') {
    if (!/^\d+$/.test(explicitPort)) {
      throw new Error('E2E_APP_PORT must be an integer between 1 and 65535.');
    }
    const port = Number(explicitPort);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('E2E_APP_PORT must be an integer between 1 and 65535.');
    }
    if (await isPortBusy(port)) {
      throw new PortUnavailable(port, 'E2E_APP_PORT');
    }
    return port;
  }

  return (await allocatePort(runId, root)).port;
};
