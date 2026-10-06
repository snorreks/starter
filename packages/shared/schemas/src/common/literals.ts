// packages/shared/schemas/src/common/literals.ts
//
// A closed union of literal strings, as a TypeBox schema.
//
// It lives in `common/` rather than beside the domain that first needed it because
// it is not a domain concept. It is the shape every enumerated string set in this
// repository wants — job statuses, message roles, upload states — and a second
// domain importing `jobs` for a TypeBox helper is a dependency that asserts nothing
// about either of them. It was moved here when chat needed it too.

import { type TLiteral, type TUnion, Type } from 'typebox';

/**
 * One `TLiteral` per value, in the same order, as a mutable tuple.
 *
 * `-readonly` because `T` is a `readonly` tuple (`as const`) while `TUnion`
 * takes a mutable one.
 */
export type LiteralTuple<T extends readonly string[]> = {
  -readonly [K in keyof T]: TLiteral<T[K] & string>;
};

/**
 * A closed union of the given literal strings.
 *
 * Written as a helper rather than inline `Type.Union([...])` so that every
 * enumerated set has the same shape and the compiler keeps the literal types:
 * `Static` of the result is `'a' | 'b'`, never `string`. A union that widened to
 * `string` would accept any value, which is exactly what the closed schemas this
 * builds exist to prevent — a `role` that accepts any string lets a caller author
 * a message as somebody else.
 *
 * TypeBox 1.x resolves `Static` of a union by walking its members as a *tuple*,
 * accumulating a union as it goes. An unbounded array type — what
 * `Array.prototype.map` returns — is not a tuple, so the walk stops immediately
 * and `Static` comes out `never`, which then rejects every value that is one of
 * the literals. `LiteralTuple` exists for that walk.
 */
export const literalUnion = <const T extends readonly string[]>(
  values: T,
): TUnion<LiteralTuple<T>> => {
  // Two details, and both are about the tuple above. `map` always returns an
  // array, so the tuple is asserted rather than inferred; and `Type.Union`
  // infers an array from a bare tuple argument, so the tuple is spread to
  // survive. Nothing past this line is asserted: a status type only typechecks
  // because it resolved to the literals rather than to `never`.
  const schemas = values.map((value) => Type.Literal(value)) as LiteralTuple<T>;
  return Type.Union([...schemas]);
};

/**
 * The union of the values themselves, for a type annotation.
 *
 * `Static<typeof SomeLiteralUnionSchema>` works, but only at the cost of keeping
 * the schema in scope wherever the type is wanted — including in a `.svelte` view
 * that has no business importing a schema module. Deriving it from the same tuple
 * the schema is built from removes that coupling, and the two cannot drift because
 * there is only one tuple.
 */
export type LiteralUnion<T extends readonly string[]> = T[number];