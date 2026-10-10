import { expect, test } from 'bun:test';
import { stripeCommand } from '../src/commands/stripe.ts';
import { EXIT } from '../src/shared/command.ts';

test('invalid webhook URLs are usage errors before resolving credentials or syncing', async () => {
  for (const args of [
    ['--webhook-url'],
    ['--webhook-url='],
    ['--webhook-url', 'http://example.test'],
    ['--webhook-url', '--yes'],
  ]) {
    expect(await stripeCommand.run(['setup', ...args])).toBe(EXIT.usage);
  }
});

test('a failed webhook sync makes the command fail even when the catalogue succeeds', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === '/v1/webhook_endpoints'
        ? new Response('fixture failure', { status: 500 })
        : Response.json({ data: [] });
    },
  });
  const before = {
    base: process.env.STRIPE_API_BASE,
    key: process.env.STRIPE_SECRET_KEY,
    vars: process.env.STARTER_DEV_VARS_PATH,
  };
  try {
    process.env.STRIPE_API_BASE = server.url.origin;
    process.env.STRIPE_SECRET_KEY = 'fixture';
    delete process.env.STARTER_DEV_VARS_PATH;
    expect(
      await stripeCommand.run(['setup', '--dry-run', '--webhook-url', 'https://app.test/hook']),
    ).toBe(EXIT.failed);
  } finally {
    for (const [name, value] of Object.entries({
      STRIPE_API_BASE: before.base,
      STRIPE_SECRET_KEY: before.key,
      STARTER_DEV_VARS_PATH: before.vars,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await server.stop(true);
  }
});
