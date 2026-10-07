import { expect, test } from 'bun:test';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import logToolExtension from '../extensions/logs.ts';

test('a cancelled log read is reported as an error', async () => {
  let definition: ToolDefinition | undefined;
  logToolExtension({
    registerTool: (tool: ToolDefinition) => {
      definition = tool;
    },
  } as unknown as ExtensionAPI);
  if (definition === undefined) throw new Error('read_logs did not register');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 0);
  const result = await definition.execute(
    'cancel-log-read',
    {},
    controller.signal,
    undefined,
    {} as never,
  );

  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ cancelled: true });
});
