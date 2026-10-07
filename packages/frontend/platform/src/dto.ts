import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AppError } from '@starter/utils';

export const parseDto = <S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
  what: string,
): StandardSchemaV1.InferOutput<S> => {
  const result = schema['~standard'].validate(value);
  if (!(result instanceof Promise) && !result.issues) {
    return result.value;
  }
  const detail =
    result instanceof Promise
      ? 'asynchronous validation is unsupported'
      : result.issues
          ?.slice(0, 5)
          .map(({ message }) => message)
          .join('; ');
  throw new AppError('server', `The server sent ${what} this build does not understand.`, {
    status: 200,
    cause: { schema: 'standard-schema', value, detail },
  });
};
