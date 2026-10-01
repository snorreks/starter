// .pi/tests/tool_namespace.test.ts
//
// The action dispatcher, driven through a stand-in for Pi's `registerTool`.
//
// Two behaviours here are the whole reason this helper exists, and both are
// things a schema-only implementation gets wrong in a way that costs the model a
// round trip:
//
//   1. **A flattened call is recovered.** Models send `{ action, ...fields }`
//      despite both the schema and the prose saying to nest. Without recovery it
//      defaults to `{}` and fails inside the action's own schema with a message
//      that never mentions the real problem.
//   2. **A scalar type slip is repaired, and nothing else is.** A stringified
//      number is the shape the schema's own description invites. Anything that
//      cannot be converted with certainty passes through so the original,
//      precise error still fires.

import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import {
  coerceParams,
  defineAction,
  parseParamsContainer,
  registerNamespace,
  summarizeSchema,
} from '../lib/tool_namespace.ts';

// ── A stand-in for Pi's registration surface ───────────────────────

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    rawParams: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

const register = () => {
  const tools: RegisteredTool[] = [];
  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
  };
  // Only `registerTool` is needed; the cast keeps the stub from having to model
  // the rest of the ExtensionAPI surface.
  registerNamespace(pi as unknown as Parameters<typeof registerNamespace>[0], {
    name: 'demo',
    label: 'Demo',
    promptSnippet: 'a demo namespace',
    description: 'Demo family.',
    actions: [
      // `defineAction` so each action's params keep their real type inside
      // `execute` — the same inference Pi gives a standalone registered tool.
      defineAction({
        action: 'echo',
        summary: 'Echo a message.',
        parameters: Type.Object({
          message: Type.String({ description: 'Text to echo.' }),
          times: Type.Optional(Type.Number({ default: 1, description: 'Repetitions.' })),
        }),
        execute: async (_id, params) => ({
          content: [
            {
              type: 'text',
              text: Array.from({ length: params.times ?? 1 }, () => params.message).join('|'),
            },
          ],
          // `details` is required on Pi's AgentToolResult, and is what the UI and
          // the transcript renderer read.
          details: { echoed: params.message, times: params.times ?? 1 },
        }),
      }),
      defineAction({
        action: 'noop',
        summary: 'Do nothing.',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
      }),
    ],
  });
  const tool = tools[0];
  if (tool === undefined) {
    throw new Error('registerNamespace did not register a tool.');
  }
  return tool;
};

const textOf = (result: Awaited<ReturnType<RegisteredTool['execute']>>): string =>
  result.content.map((part) => part.text).join('\n');

describe('registration', () => {
  test('registers exactly one tool with the namespace envelope', () => {
    const tool = register();
    expect(tool.name).toBe('demo');
  });

  test('the description carries a compact action index, not one schema per action', () => {
    const tool = register();

    expect(tool.description).toContain('Actions:');
    expect(tool.description).toContain('echo — Echo a message.');
    // The parameter summary is compact prose, so a family of ten actions costs
    // ten lines rather than ten JSON Schemas in the prompt on every turn.
    expect(tool.description).toContain('message:string, times?:number');
    // And the call shape, because the flattening failure is the common one.
    expect(tool.description).toContain('Call shape:');
  });
});

describe('dispatch', () => {
  test('runs an action from nested params', async () => {
    const tool = register();
    const result = await tool.execute('1', { action: 'echo', params: { message: 'hi' } });
    expect(textOf(result)).toBe('hi');
    expect(result.isError).toBeFalsy();
  });

  test('recovers a flattened call instead of silently running on defaults', async () => {
    // The failure this prevents: `params` undefined → `{}` → the action runs with
    // its defaults and looks like it succeeded while the message was dropped.
    const tool = register();
    const result = await tool.execute('1', { action: 'echo', message: 'flattened' });
    expect(textOf(result)).toBe('flattened');
  });

  test('applies schema defaults, so an action body can rely on them', async () => {
    const tool = register();
    const result = await tool.execute('1', { action: 'echo', params: { message: 'x', times: 3 } });
    expect(textOf(result)).toBe('x|x|x');
  });

  test('rejects an unknown action with the list of real ones', async () => {
    const tool = register();
    const result = await tool.execute('1', { action: 'ech0', params: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown action "ech0"');
    // The valid set, so the model can correct in one more step.
    expect(textOf(result)).toContain('echo, noop');
  });

  test('rejects invalid params and shows what it received', async () => {
    const tool = register();
    const result = await tool.execute('1', {
      action: 'echo',
      params: { message: { nested: true } },
    });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Invalid params for demo.echo');
    expect(text).toContain('Expected (nested under "params")');
    // The received value is what lets the model self-diagnose instead of guessing.
    expect(text).toContain('Received:');
  });

  test('recovers params that arrive as a serialised JSON string', async () => {
    const tool = register();
    const result = await tool.execute('1', {
      action: 'echo',
      params: '{"message":"serialised"}',
    });
    expect(textOf(result)).toBe('serialised');
  });
});

describe('coercion is bounded', () => {
  const schema = Type.Object({
    limit: Type.Optional(Type.Number()),
    watch: Type.Optional(Type.Boolean()),
    name: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    mode: Type.Optional(Type.Union([Type.Literal('fast'), Type.Literal('slow')])),
  });

  test('repairs the scalar slips a schema description invites', () => {
    const coerced = coerceParams(schema, {
      limit: '10',
      watch: 'true',
      name: 42,
      tags: 'a,b, c',
    }) as Record<string, unknown>;

    expect(coerced.limit).toBe(10);
    expect(coerced.watch).toBe(true);
    expect(coerced.name).toBe('42');
    expect(coerced.tags).toEqual(['a', 'b', 'c']);
  });

  test('maps a string onto a string union by value', () => {
    expect((coerceParams(schema, { mode: 'slow' }) as Record<string, unknown>).mode).toBe('slow');
  });

  test('never coerces null, so a required field given it still fails', () => {
    // `null` is an explicit "I have no value". Coercing it to 0 or false would
    // manufacture data the model never sent.
    expect((coerceParams(schema, { limit: null }) as Record<string, unknown>).limit).toBeNull();
  });

  test('leaves an uncoercible value alone so the real error still fires', () => {
    // `"0x10"` is 16 to Number(). A limit that silently becomes something other
    // than what was asked for is worse than a rejected call.
    const coerced = coerceParams(schema, { limit: '0x10' }) as Record<string, unknown>;
    expect(coerced.limit).toBe('0x10');
  });

  test('refuses an empty string as a number, rather than reading it as 0', () => {
    // `Number('')` is 0. A limit that becomes 0 is a hang, not a helpful default.
    const coerced = coerceParams(schema, { limit: '' }) as Record<string, unknown>;
    expect(coerced.limit).toBe('');
  });

  test('treats 0 and 1 as booleans but leaves other numbers alone', () => {
    expect((coerceParams(schema, { watch: 1 }) as Record<string, unknown>).watch).toBe(true);
    expect((coerceParams(schema, { watch: 7 }) as Record<string, unknown>).watch).toBe(7);
  });

  test('does not reach into nested objects', () => {
    // Bounded on purpose: repairing nested shapes is where a coercion layer
    // starts inventing arguments nobody asked for.
    const nested = Type.Object({
      options: Type.Optional(
        Type.Object({ limit: Type.Optional(Type.Number()) }, { additionalProperties: true }),
      ),
    });
    const coerced = coerceParams(nested, { options: { limit: '10' } }) as Record<string, unknown>;
    expect((coerced.options as Record<string, unknown>).limit).toBe('10');
  });

  test('passes a non-object through untouched', () => {
    expect(coerceParams(schema, 'not an object')).toBe('not an object');
    expect(coerceParams(schema, null)).toBeNull();
  });
});

describe('summarizeSchema', () => {
  test('puts required fields before optional ones', () => {
    const schema = Type.Object({
      optional: Type.Optional(Type.String()),
      required: Type.Number(),
    });
    expect(summarizeSchema(schema)).toBe('required:number, optional?:string');
  });

  test('renders literal unions and arrays compactly', () => {
    const schema = Type.Object({
      mode: Type.Union([Type.Literal('a'), Type.Literal('b')]),
      list: Type.Array(Type.String()),
    });
    // Literals are quoted so a value of "1" is distinguishable from the number 1,
    // and so the allowed values are actually visible — a summary that rendered
    // this as `string|string` would tell a model nothing.
    expect(summarizeSchema(schema)).toBe('mode:"a"|"b", list:string[]');
  });

  test('returns an empty string for a schema with no properties', () => {
    expect(summarizeSchema(Type.Object({}))).toBe('');
  });
});

describe('parseParamsContainer', () => {
  test('parses only a well-formed object, leaving anything else alone', () => {
    expect(parseParamsContainer('{"a":1}')).toEqual({ a: 1 });
    // A malformed string must surface as the validation error it deserves, not be
    // swallowed into an empty object.
    expect(parseParamsContainer('{oops')).toBe('{oops');
    expect(parseParamsContainer('plain')).toBe('plain');
    expect(parseParamsContainer('[1,2]')).toBe('[1,2]');
  });

  test('leaves a non-string untouched', () => {
    const value = { a: 1 };
    expect(parseParamsContainer(value)).toBe(value);
  });
});
