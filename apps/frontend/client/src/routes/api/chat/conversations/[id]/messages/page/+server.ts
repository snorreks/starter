import { MessageCursorError, MessagePageSchema } from '@starter/schemas/chat';
import * as v from 'valibot';
import { createRequestChatService } from '#lib/server/application_chat.ts';
import { json, jsonError, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const PageQuerySchema = v.strictObject({
  cursor: v.union([v.string(), v.null()]),
});

/** Versioned cursor endpoint; the older named messages envelope remains available to native clients. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  if (locals.user === null) {
    return unauthorized();
  }
  const parsed = v.safeParse(PageQuerySchema, { cursor: url.searchParams.get('cursor') });
  if (!parsed.success || (parsed.output.cursor !== null && parsed.output.cursor.length > 1024)) {
    return jsonError(400, 'invalid_cursor', 'The message cursor is malformed.');
  }
  const service = createRequestChatService(locals);
  if ((await service.find(locals.user.id, params.id)) === null) {
    return jsonError(404, 'not_found', 'That conversation does not exist.');
  }
  try {
    return json(
      200,
      v.parse(
        MessagePageSchema,
        await service.messagePage(locals.user.id, params.id, parsed.output.cursor),
      ),
    );
  } catch (cause) {
    if (cause instanceof MessageCursorError) {
      return jsonError(
        400,
        'invalid_cursor',
        'The message cursor is malformed or belongs to another conversation.',
      );
    }
    throw cause;
  }
};
