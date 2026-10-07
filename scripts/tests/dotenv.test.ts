import { expect, test } from 'bun:test';
import { parseDotenv } from '../src/shared/dotenv.ts';

test('dotenv supports blank lines, comments, quoted strings and equals in values', () => {
  expect(
    parseDotenv(
      '# local\nA=plain # comment\nB="two=parts\\nnext"\nC=\'literal # value\'',
      'fixture',
    ),
  ).toEqual({ A: 'plain', B: 'two=parts\nnext', C: 'literal # value' });
});

test('dotenv rejects unsupported syntax, malformed quotes and duplicate names without values', () => {
  for (const source of ['export TOKEN=hidden', 'TOKEN="hidden', 'TOKEN=one\nTOKEN=two']) {
    expect(() => parseDotenv(source, 'fixture')).toThrow('fixture');
    expect(() => parseDotenv(source, 'fixture')).not.toThrow('hidden');
  }
});
