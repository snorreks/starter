import type { StandardSchemaV1 } from '@standard-schema/spec';

export const checkSchema = <S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): value is StandardSchemaV1.InferOutput<S> => {
  const result = schema['~standard'].validate(value);
  return !(result instanceof Promise) && !('issues' in result);
};

export const parseSchema = <S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): StandardSchemaV1.InferOutput<S> => {
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new TypeError('Asynchronous schemas are not supported.');
  }
  if (result.issues) {
    throw new TypeError(
      result.issues
        .slice(0, 5)
        .map(({ message }) => message)
        .join('; '),
    );
  }
  return result.value;
};
