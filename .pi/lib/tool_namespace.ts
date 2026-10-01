// .pi/lib/tool_namespace.ts
//
// Register a family of related actions as ONE Pi tool with an `action` discriminator.
//
// 🔴 Why this exists: every registered tool pins its name, description,
// `promptSnippet`, `promptGuidelines` and full JSON Schema into the system prompt
// on **every turn of every session**, whether or not the session ever calls it.
// That cost is invisible in normal use and only grows. A namespace pays for one
// `{ action, params }` envelope plus a compact prose index, and keeps per-action
// validation — `params` is checked against that action's own TypeBox schema at
// dispatch, so a bad call still gets a precise error naming what was expected.
//
// This is a deliberately reduced copy of the helper Aikami carries. What is kept
// is the part that fixed a real failure mode (recovering a flattened call, and
// repairing the scalar type slips a schema's own description invites). What is
// dropped is the nested-record and deep-union coercion ladder: it was written for
// a 141 KB `gh` wrapper, and nothing in a template justifies carrying it.
//
// Two invariants, both load-bearing:
//
//   1. **Coercion never invents a value.** Anything it cannot convert with
//      certainty is passed through untouched, so a genuinely wrong call still
//      fails validation with its original error rather than being silently
//      repaired into something the model did not ask for.
//   2. **`null` is never coerced.** `null` is an explicit "I have no value", and a
//      required field handed `null` must still fail loudly.

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Static, TSchema } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

// ── Types ──────────────────────────────────────────────────────────

export interface NamespaceAction<TParams extends TSchema = TSchema> {
  /** Name the model calls, e.g. "run". Snake or kebab, no spaces. */
  action: string;
  /** One line, appended to the dispatcher's action index. Keep it terse. */
  summary: string;
  /** This action's own schema, validated at dispatch. */
  parameters: TParams;
  /**
   * Identical signature to Pi's `ToolDefinition.execute`, so an action body
   * reads exactly like a standalone tool body.
   */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
}

/**
 * Identity helper preserving each action's parameter type.
 *
 * Actions live in a `NamespaceAction[]`, which erases the generic and leaves
 * `params` as `unknown` inside `execute`. Wrapping the literal in
 * `defineAction` infers `TParams` at the call site first.
 */
export const defineAction = <TParams extends TSchema>(
  action: NamespaceAction<TParams>,
): NamespaceAction => action as unknown as NamespaceAction;

export interface NamespaceOptions {
  /** Registered tool name, e.g. "repo_task". */
  name: string;
  label: string;
  /** Lead sentence. The action index is appended. */
  description: string;
  /**
   * One line in Pi's "Available tools" section. Omit it and the tool is omitted
   * from that section entirely — which is the cheaper default for a tool a
   * session probably will not need. Set it only for a default-reach tool.
   */
  promptSnippet?: string;
  actions: NamespaceAction[];
}

// ── Schema summarisation ──────────────────────────────────────────

type SchemaNode = Record<string, unknown>;

/** Renders a TypeBox node as a compact hint: `string`, `a|b`, `number[]`. */
const typeHint = (schema: SchemaNode): string => {
  // `const` before anything else. TypeBox 1.x represents `Type.Literal('fast')` as
  // `{ const: 'fast', type: 'string' }` — not as an enum — so a summary that only
  // knew about `enum` rendered every string union as `string|string`, which tells
  // a model nothing about which values are allowed.
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  const allowed = schema.enum as unknown[] | undefined;
  if (Array.isArray(allowed) && allowed.length > 0) {
    return allowed.map((value) => JSON.stringify(value)).join('|');
  }
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as SchemaNode[]).map(typeHint).join('|');
  }
  if (schema.type === 'array') {
    return `${schema.items ? typeHint(schema.items as SchemaNode) : 'any'}[]`;
  }
  if (typeof schema.type === 'string') {
    return schema.type;
  }
  // Untyped objects (Type.Record, Type.Unsafe) carry no `type`; calling them
  // "object" tells the model less than the field name does, so say nothing.
  return schema.properties === undefined ? 'any' : 'object';
};

/**
 * Renders an object schema as one line: `task:string, timeoutMs?:number`.
 *
 * Required fields first, so the reader meets them before the optionals. Returns
 * an empty string when the schema declares no properties.
 */
export const summarizeSchema = (schema: TSchema): string => {
  const node = schema as unknown as {
    properties?: Record<string, SchemaNode>;
    required?: string[];
  };
  if (node.properties === undefined) {
    return '';
  }

  const required = new Set(node.required ?? []);
  const entries = Object.entries(node.properties);
  const render = ([key, value]: [string, SchemaNode]): string =>
    `${key}${required.has(key) ? '' : '?'}:${typeHint(value)}`;

  return [
    ...entries.filter(([key]) => required.has(key)).map(render),
    ...entries.filter(([key]) => !required.has(key)).map(render),
  ].join(', ');
};

const buildActionIndex = (actions: NamespaceAction[]): string =>
  actions
    .map((action) => {
      const params = summarizeSchema(action.parameters);
      return `• ${action.action} — ${action.summary}${params === '' ? '' : ` [${params}]`}`;
    })
    .join('\n');

// ── Bounded coercion ──────────────────────────────────────────────

const TRUTHY = new Set(['true', 'yes', 'y', 'on', '1']);
const FALSY = new Set(['false', 'no', 'n', 'off', '0']);

/**
 * Plain decimal only — no thousands separators, no exponent games.
 *
 * `Number()` accepts `''` as 0 and `'0x10'` as 16. A `limit` that silently
 * becomes 0 is a hang, not a helpful default, so anything ambiguous is refused
 * and left for validation to reject.
 */
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;

const asNumber = (raw: string): number | undefined => {
  const text = raw.trim();
  if (!DECIMAL.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

const asBoolean = (raw: string): boolean | undefined => {
  const text = raw.trim().toLowerCase();
  if (TRUTHY.has(text)) {
    return true;
  }
  if (FALSY.has(text)) {
    return false;
  }
  return undefined;
};

const SCALAR_COERCERS: Record<string, (value: unknown) => unknown> = {
  number: (value) => (typeof value === 'string' ? (asNumber(value) ?? value) : value),
  integer: (value) => (typeof value === 'string' ? (asNumber(value) ?? value) : value),
  boolean: (value) => {
    if (typeof value === 'string') {
      return asBoolean(value) ?? value;
    }
    // 0/1 is how a JSON transport renders a boolean; anything else is a guess.
    return typeof value === 'number' && (value === 0 || value === 1) ? value !== 0 : value;
  },
  string: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value),
};

const coerceValue = (value: unknown, schema: SchemaNode): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  if (schema.type === 'array') {
    const items = schema.items as SchemaNode | undefined;
    // A comma-joined string is how a single-value array field usually arrives.
    const joined =
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '')
        : value;
    const list = Array.isArray(value) ? value : joined;
    if (!Array.isArray(list)) {
      return value;
    }
    return items === undefined ? list : list.map((entry) => coerceValue(entry, items));
  }

  const allowed = schema.enum as unknown[] | undefined;
  if (Array.isArray(allowed)) {
    if (allowed.includes(value)) {
      return value;
    }
    const text = typeof value === 'string' ? value : String(value);
    return allowed.find((candidate) => String(candidate) === text) ?? value;
  }

  const declared = typeof schema.type === 'string' ? schema.type : undefined;
  const coercer = declared === undefined ? undefined : SCALAR_COERCERS[declared];
  return coercer === undefined ? value : coercer(value);
};

/**
 * Repairs the scalar type slips a schema's own descriptions invite — a
 * stringified number, a numeric id for a string enum, a comma-joined array.
 *
 * Bounded on purpose: top-level scalars and one level of array elements. A
 * nested object is left exactly as sent, because "repairing" a nested shape is
 * where a coercion layer starts inventing arguments nobody asked for.
 */
export const coerceParams = (schema: TSchema, params: unknown): unknown => {
  const node = schema as unknown as { properties?: Record<string, SchemaNode> };
  if (node.properties === undefined || typeof params !== 'object' || params === null) {
    return params;
  }

  const source = params as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const [key, propertySchema] of Object.entries(node.properties)) {
    if (key in out) {
      out[key] = coerceValue(out[key], propertySchema);
    }
  }
  return out;
};

/**
 * Recovers `params` arriving as a serialised JSON string.
 *
 * Without this the dispatcher saw a string, treated it as "not nested", fell back
 * to `{}`, and ran the action on DEFAULTS — a silent no-op that looks like
 * success. Only well-formed objects are parsed, so a malformed string still
 * surfaces the validation error it deserves.
 */
export const parseParamsContainer = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const text = value.trim();
  if (!text.startsWith('{')) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

// ── Registration ──────────────────────────────────────────────────

const NAMESPACE_PARAMS = Type.Object({
  action: Type.String({ description: 'Which action to run — see the list in the description.' }),
  params: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "That action's fields, as a NESTED object — e.g. " +
          '{ "action": "run", "params": { "task": "pi:test" } }. ' +
          "Do NOT put the action's own fields beside `action`; put them inside `params`.",
      },
    ),
  ),
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describeValue = (value: unknown): string => {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  // Hard-truncated: an error message is the one place an accidental payload (a
  // whole PR body) would otherwise leak into the transcript.
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
};

/**
 * Appends what was actually received for each failing path.
 *
 * Without it the model sees `must be number` and has to guess whether it sent
 * nothing, `null`, or a string — and the guess is wrong often enough to cost
 * another round trip.
 */
const formatReceived = (params: unknown, paths: string[]): string => {
  if (!isPlainObject(params)) {
    return '';
  }
  const shown = paths
    .map((path) => {
      const key = path.replace(/^\//, '').split('/')[0] ?? '';
      return key !== '' && key in params ? `  ${key}: ${describeValue(params[key])}` : undefined;
    })
    .filter((line): line is string => line !== undefined);
  return shown.length > 0 ? `\nReceived:\n${shown.join('\n')}` : '';
};

const textResult = (text: string, isError: boolean, details: unknown): AgentToolResult<unknown> =>
  ({
    content: [{ type: 'text', text }],
    isError,
    details,
  }) as AgentToolResult<unknown>;

/**
 * Registers a family of actions as a single Pi tool.
 *
 * Dispatch coerces, applies schema defaults, then validates against the action's
 * own schema before calling it — so an action body sees exactly what it would
 * have seen as a standalone registered tool.
 */
export const registerNamespace = (pi: ExtensionAPI, options: NamespaceOptions): void => {
  // The generic is explicit because `[a.action, action]` widens to
  // `(string | NamespaceAction)[]` on its own, and `new Map()` would then infer a
  // value type of `{}` — making `action.action` untyped a few lines later.
  const byAction = new Map<string, NamespaceAction>(
    options.actions.map((action) => [action.action, action]),
  );
  const actionNames = options.actions.map((action) => action.action);

  pi.registerTool({
    name: options.name,
    label: options.label,
    description:
      `${options.description}\n\n` +
      'Call shape: { action: "<name>", params: { ...that action\'s fields } } — the fields ' +
      'are ALWAYS nested inside `params`, never beside `action`.\n\n' +
      `Actions:\n${buildActionIndex(options.actions)}`,
    ...(options.promptSnippet === undefined ? {} : { promptSnippet: options.promptSnippet }),
    parameters: NAMESPACE_PARAMS,
    async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
      // Annotated, not inferred: the `{}` fallback branch would otherwise leave
      // `envelope` as `Record<string, unknown> | {}`, and every property access
      // below becomes an error on the `{}` half.
      const envelope: Record<string, unknown> = isPlainObject(rawParams) ? rawParams : {};
      const requested = String(envelope.action ?? '');
      const action = byAction.get(requested);

      if (action === undefined) {
        return textResult(
          `Unknown action "${requested}" for ${options.name}. Valid actions: ${actionNames.join(', ')}.`,
          true,
          { error: 'unknown_action', validActions: actionNames },
        );
      }

      // 🔴 Models flatten the call — { action, ...fields } — despite both the
      // schema and the prose saying to nest. The outer schema must allow extra
      // top-level properties so it does not reject a flat call outright, which
      // means a flattened call used to reach this dispatcher with `params`
      // undefined, default to `{}`, and fail deep inside the action's OWN schema
      // with a message that never mentions the real problem. Prefer a genuinely
      // nested `params`; fall back to the rest of the call only when none was.
      const { action: _key, params: nested, ...flat } = envelope;
      const parsedNested = parseParamsContainer(nested);
      const hasNested = isPlainObject(parsedNested) && Object.keys(parsedNested).length > 0;
      const raw = hasNested ? parsedNested : flat;

      const params = Value.Default(
        action.parameters,
        coerceParams(action.parameters, raw) as never,
      );

      if (!Value.Check(action.parameters, params)) {
        const expected = summarizeSchema(action.parameters);
        const failures = [...Value.Errors(action.parameters, params)];
        const detail = failures
          .slice(0, 4)
          .map((failure) => `${failure.instancePath || '(root)'}: ${failure.message}`)
          .join('; ');

        return textResult(
          `Invalid params for ${options.name}.${action.action}: ` +
            `${detail === '' ? 'params did not match the expected schema' : detail}.\n` +
            `Expected (nested under "params"): ${expected === '' ? '(none)' : expected}\n` +
            `Call shape: { "action": "${action.action}", "params": { ... } }` +
            formatReceived(
              params,
              failures.map((failure) => failure.instancePath),
            ),
          true,
          { error: 'invalid_params', action: action.action, expected },
        );
      }

      return action.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
};
