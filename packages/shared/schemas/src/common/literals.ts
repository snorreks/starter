import * as v from 'valibot';

export const literalUnion = <const T extends readonly [string, ...string[]]>(values: T) =>
  v.picklist(values);
export type LiteralUnion<T extends readonly string[]> = T[number];
