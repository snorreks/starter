import { expect, test } from 'bun:test';
import { actions } from './+page.server.ts';

const submit = async (handler: () => Promise<Response> | Response) => {
  const action = actions.default;
  if (typeof action !== 'function') {
    throw new Error('Expected a reset-password form action.');
  }
  return action({
    request: new Request('http://starter.test/reset-password?token=valid-shaped-token', {
      method: 'POST',
      body: new URLSearchParams({ newPassword: 'new password with enough length' }),
    }),
    url: new URL('http://starter.test/reset-password?token=valid-shaped-token'),
    locals: {
      container: {
        backendProfile: 'legacy',
        baseUrl: 'http://starter.test',
        auth: { handler },
      },
      context: null,
    },
    cookies: { set: () => {}, parse: () => ({}) },
  } as never);
};

test('an unexpected reset failure keeps the password form available and shows a safe error', async () => {
  const result = await submit(() => {
    throw new Error('Unexpected auth storage failure.');
  });
  expect(result).toMatchObject({
    status: 400,
    data: {
      tokenInvalid: false,
      errors: { newPassword: 'Unexpected auth storage failure.' },
    },
  });
});

test('only recognized token failures mark the reset link invalid', async () => {
  const result = await submit(() => Response.json({ code: 'INVALID_TOKEN' }, { status: 400 }));
  expect(result).toMatchObject({
    status: 400,
    data: {
      tokenInvalid: true,
      errors: { newPassword: 'That link is no longer valid. It may already have been used.' },
    },
  });
});
