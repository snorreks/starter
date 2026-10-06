// packages/frontend/platform/src/dto.ts
//
// Runtime validation at a contract boundary.
//
// The problem this solves
// ----------------------
// A TypeScript type is erased at runtime. `transport.request<Note[]>('/api/notes')`
// compiles whether the server sent notes, an error envelope, or a proxy's HTML
// page — and the mistake surfaces three layers away, as a list that renders
// nothing, or as `undefined.title` in a component with no idea where it came
// from. `parseBody as T` in the transport is that mistake, written down.
//
// So the assertion happens where the contract is: a service that knows the
// endpoint also knows the schema, and it checks the answer before a ViewModel can
// hold it. The check is TypeBox `Value.Check` against the same schema the server
// validated with, which is why there is no second definition of the wire shape to
// drift.
//
// A refusal is a `server` error, not a silent empty list. "The server sent
// something this build does not understand" is a deployment or version problem,
// and it has to read as one.

import { AppError } from '@starter/utils';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

/**
 * The schema's `$id`, for a failure report that says which contract broke.
 *
 * TypeBox 1.x still carries `$id` in a schema's options at runtime but no longer
 * declares it on `TSchema`, so reading it is one cast. `typebox/schema` exports
 * an `IsId` guard that would do this without one, but that entrypoint also
 * carries every JSON Schema draft meta-schema, and a bundle that only wants a
 * name has no use for them.
 */
const schemaName = (schema: TSchema): string => (schema as { $id?: string }).$id ?? 'anonymous';

/**
 * Assert that `value` is `schema`, or throw.
 *
 * `what` names the contract in the message, because "unexpected response" tells a
 * reader nothing three layers below the call.
 */
export const parseDto = <T extends TSchema>(schema: T, value: unknown, what: string): Static<T> => {
  if (Value.Check(schema, value)) {
    return value;
  }

  throw new AppError('server', `The server sent ${what} this build does not understand.`, {
    status: 200,
    cause: { schema: schemaName(schema), value },
  });
};
