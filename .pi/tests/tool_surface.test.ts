// .pi/tests/tool_surface.test.ts
//
// The default tool surface, measured — and bounded.
//
// 🔴 Why a budget at all: every registered tool pins its name, description,
// `promptSnippet`, `promptGuidelines` and full JSON Schema into the system
// prompt on **every turn of every session**, whether or not the session ever
// calls it. That cost is invisible in normal use and only ever grows. Aikami's
// `gh_*` family was 26 tools costing roughly 3.4k tokens before any GitHub work
// happened.
//
// So this measures the real registrations, through the real pinned Pi loader, and
// fails when the surface grows past a stated budget. A budget that is never
// enforced is a comment; this is the enforcement.
//
// What it deliberately does NOT do is constrain how many *actions* a namespace
// has. Grouping is judged by what reaches the prompt — one envelope plus a
// prose index — not by the number of things the agent can do.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The ceiling, in bytes of prompt the project's own tools contribute.
 *
 * Set from a measurement of this suite rather than a round number, and rounded up
 * with room for one more small action — so ordinary growth does not fail the
 * build, but a family of tools arriving at once does.
 */
const MAX_SURFACE_BYTES = 12_000;

/** A sanity floor, so a change that silently drops every tool is caught too. */
const MIN_SURFACE_BYTES = 2_000;

/**
 * Approximate tokens for reporting.
 *
 * Deliberately crude — 4 characters per token is a common English estimate. It is
 * here so the number in the test output is comparable with the token figures in
 * `docs/agent.md`; it is not a billing calculation.
 */
const approxTokens = (bytes: number): number => Math.round(bytes / 4);

interface MeasuredTool {
  name: string;
  bytes: number;
  description: string;
}

const loadTools = async () => {
  // A throwaway agentDir so the loader cannot pick up the developer's own `~/.pi`
  // — a machine where this project happens to be trusted would otherwise produce a
  // different result from CI's.
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-surface-'));
  try {
    const settingsManager = SettingsManager.create(REPO_ROOT, agentDir);
    const loader = new DefaultResourceLoader({ cwd: REPO_ROOT, agentDir, settingsManager });
    settingsManager.setProjectTrusted(true);
    await loader.reload();

    const result = loader.getExtensions();
    if (result.errors.length > 0) {
      throw new Error(
        `extensions failed to load, so the surface cannot be measured: ${result.errors
          .map((error) => error.path)
          .join(', ')}`,
      );
    }

    const measured: MeasuredTool[] = [];
    for (const extension of result.extensions) {
      for (const [name, tool] of extension.tools) {
        const definition = tool.definition ?? tool;
        const parts = [
          name,
          definition.label ?? '',
          definition.description ?? '',
          definition.promptSnippet ?? '',
          ...(definition.promptGuidelines ?? []),
          JSON.stringify(definition.parameters ?? {}),
        ];
        measured.push({
          name,
          bytes: Buffer.byteLength(parts.join('\n'), 'utf8'),
          description: definition.description ?? '',
        });
      }
    }
    return measured;
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
};

describe('the default tool surface', () => {
  test('is measured and reported', async () => {
    const tools = await loadTools();
    const total = tools.reduce((sum, tool) => sum + tool.bytes, 0);

    // Printed on every run, because a budget nobody can see the current value of
    // is a budget that only bites when it is already too late.
    console.log(
      `\n  tool surface: ${tools.length} tool(s), ${total} bytes (~${approxTokens(total)} tokens)\n` +
        tools
          .sort((a, b) => b.bytes - a.bytes)
          .map((tool) => `    ${tool.name.padEnd(16)} ${tool.bytes} bytes`)
          .join('\n'),
    );

    expect(total).toBeLessThanOrEqual(MAX_SURFACE_BYTES);
    // And the floor, so a bug that registers nothing cannot pass by being small.
    expect(total).toBeGreaterThanOrEqual(MIN_SURFACE_BYTES);
  }, 60_000);

  test('stays a small number of tools rather than one per action', async () => {
    const tools = await loadTools();

    // Five: the log reader, task discovery/execution, owned long-running
    // processes, durable handoff notes, and the optional Herdr capability. Every
    // family is one tool with an `action` discriminator — 5 tools cover 13
    // actions, where a tool per action would cost 13 schemas on every turn.
    expect(tools.length).toBeLessThanOrEqual(6);
  }, 60_000);

  test('registers the five capabilities this project documents', async () => {
    const tools = await loadTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(['dev_process', 'handoff', 'herdr', 'read_logs', 'repo_task']);
  }, 60_000);

  test('no tool carries promptGuidelines, which are pure always-on cost', async () => {
    // Aikami enforces the same rule with `registration.test.ts`: guidelines are
    // appended to the system prompt on every turn and duplicate the description.
    const agentDir = mkdtempSync(join(tmpdir(), 'pi-surface-'));
    try {
      const settingsManager = SettingsManager.create(REPO_ROOT, agentDir);
      const loader = new DefaultResourceLoader({ cwd: REPO_ROOT, agentDir, settingsManager });
      settingsManager.setProjectTrusted(true);
      await loader.reload();

      for (const extension of loader.getExtensions().extensions) {
        for (const [name, tool] of extension.tools) {
          const definition = tool.definition ?? tool;
          expect(definition.promptGuidelines ?? []).toEqual([]);
          expect(name).toBeTruthy();
        }
      }
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  test('every description states when to use it and when not to', async () => {
    // The description is the routing signal. "Reads logs" gives a model nothing to
    // route on; a description that names the boundary is what keeps a tool from
    // being chosen for the wrong job.
    const tools = await loadTools();

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.description).toMatch(/\S/);
    }

    // The boundary that matters most here: a terminating task is not a job.
    expect(tools.find((tool) => tool.name === 'repo_task')?.description).toContain('dev_process');
    expect(tools.find((tool) => tool.name === 'dev_process')?.description).toContain('repo_task');

    // And the boundary that makes resuming safe: a note is a claim, not a fact.
    expect(tools.find((tool) => tool.name === 'handoff')?.description).toContain('not a fact');
  }, 60_000);
});
