import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEditTool,
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { EDITING_GUIDELINES, withEditingGuidelines } from '../extensions/edit-policy.ts';

const POLICY = fileURLToPath(new URL('../extensions/edit-policy.ts', import.meta.url));

/** Exercise the real loader/runner with temporary settings and no credential access. */
const loadPolicy = async (options: { duplicate?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-final-format-'));
  const agentDirectory = join(directory, 'agent');
  const projectDirectory = join(directory, 'project');
  mkdirSync(join(projectDirectory, '.pi'), { recursive: true });
  mkdirSync(agentDirectory);
  const duplicatePath = join(directory, 'second-policy.ts');
  if (options.duplicate) {
    copyFileSync(POLICY, duplicatePath);
  }
  writeFileSync(
    join(projectDirectory, '.pi/settings.json'),
    JSON.stringify({ extensions: options.duplicate ? [POLICY, duplicatePath] : [POLICY] }),
  );
  const cleanup = (): void => rmSync(directory, { recursive: true, force: true });
  try {
    const settingsManager = SettingsManager.create(projectDirectory, agentDirectory);
    settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: projectDirectory,
      agentDir: agentDirectory,
      settingsManager,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    const modelRuntime = await ModelRuntime.create({
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => {
          throw new Error('Prompt policy must not modify credentials.');
        },
        delete: async () => {
          throw new Error('Prompt policy must not delete credentials.');
        },
      },
      modelsPath: join(directory, 'models.json'),
      modelsStorePath: join(directory, 'models.sqlite'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      projectDirectory,
      SessionManager.inMemory(projectDirectory),
      new ModelRegistry(modelRuntime),
    );
    return { directory, projectDirectory, loaded, runner, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
};

describe('normal editing with explicit final formatting', () => {
  test('contributes guidance without hiding tools or registering edit/format hooks', async () => {
    const fixture = await loadPolicy();
    try {
      expect(fixture.loaded.errors).toEqual([]);
      expect(fixture.loaded.extensions).toHaveLength(1);
      const extension = fixture.loaded.extensions[0];
      expect(extension).toBeDefined();
      expect([...(extension?.handlers.keys() ?? [])]).toEqual(['before_agent_start']);
      const result = await fixture.runner.emitBeforeAgentStart('implement a feature', undefined, {
        cwd: fixture.projectDirectory,
        selectedTools: ['read', 'edit', 'write'],
        promptGuidelines: ['Keep existing guidance.'],
        contextFiles: [],
        skills: [],
      });
      expect(result.systemPromptOptions.selectedTools).toEqual(['read', 'edit', 'write']);
      expect(result.systemPromptOptions.promptGuidelines).toEqual([
        'Keep existing guidance.',
        ...EDITING_GUIDELINES,
      ]);
      expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
      expect(fixture.runner.hasHandlers('tool_call')).toBe(false);
      expect(fixture.runner.hasHandlers('tool_result')).toBe(false);
      expect(fixture.runner.hasHandlers('agent_end')).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('global and project copies do not duplicate guidance', async () => {
    const fixture = await loadPolicy({ duplicate: true });
    try {
      expect(fixture.loaded.errors).toEqual([]);
      expect(fixture.loaded.extensions).toHaveLength(2);
      const result = await fixture.runner.emitBeforeAgentStart('continue', undefined, {
        cwd: fixture.projectDirectory,
        promptGuidelines: ['Existing rule.'],
        contextFiles: [],
        skills: [],
      });
      expect(result.systemPromptOptions.promptGuidelines).toEqual([
        'Existing rule.',
        ...EDITING_GUIDELINES,
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('a real native edit changes only the requested bytes without formatting', async () => {
    const fixture = await loadPolicy();
    try {
      const path = join(fixture.projectDirectory, 'sample.ts');
      writeFileSync(path, 'const alpha=1;  // deliberately unformatted\nconst bravo = 3;\n');
      const input = { path, edits: [{ oldText: 'alpha=1', newText: 'alpha=2' }] };
      expect(
        await fixture.runner.emitToolCall({
          type: 'tool_call',
          toolName: 'edit',
          toolCallId: 'fixture-edit',
          input,
        }),
      ).toBeUndefined();
      await createEditTool(fixture.projectDirectory).execute('fixture-edit', input);
      expect(readFileSync(path, 'utf8')).toBe(
        'const alpha=2;  // deliberately unformatted\nconst bravo = 3;\n',
      );
      await expect(
        createEditTool(fixture.projectDirectory).execute('invalid-edit', {
          path,
          edits: [{ oldText: 'alpha=999', newText: 'alpha=4' }],
        }),
      ).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toContain('alpha=2');
    } finally {
      fixture.cleanup();
    }
  });

  test('existing guidance survives repeated policy application', () => {
    const once = withEditingGuidelines(['Existing rule.']);
    expect(withEditingGuidelines(once)).toEqual(once);
    expect(once).toContain('Existing rule.');
    expect(once.some((rule) => rule.includes('when a paired reader actually supplies'))).toBe(true);
    expect(once.some((rule) => rule.includes('implementation is complete'))).toBe(true);
  });
});
