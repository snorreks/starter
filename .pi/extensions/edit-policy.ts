import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** Editing and formatting guidance, independent of which optional tools are installed. */
export const EDITING_GUIDELINES = [
  'Read the target immediately before editing it. After a failed edit, compaction, or intervening change, read it again before retrying.',
  'Use the standard edit tool for targeted replacements. Use edit_lines only when a paired reader actually supplies its required hashes; never invent hashes.',
  'Do not run formatters, lint --write, or check --fix after individual edits. Keep new lines consistent with the surrounding code without reformatting unrelated lines.',
  'When implementation is complete, explicitly run the project-owned formatting command in write mode for the agreed scope, then run checks. A formatting check alone does not rewrite files.',
  'Do not automatically format on tool_result, agent_end, or other lifecycle events: the end of an agent turn is not necessarily the end of the task.',
  'If final formatting or failed checks require another edit, read the changed file again and repeat final validation. Preserve unrelated user edits.',
] as const;

/** Preserve existing prompt guidance and keep global/project copies idempotent. */
export const withEditingGuidelines = (existing: readonly string[]): string[] => [
  ...new Set([...existing, ...EDITING_GUIDELINES]),
];

/** Contribute instructions without hiding tools, blocking edits, or executing a formatter. */
const editPolicy = (pi: ExtensionAPI): void => {
  pi.on('before_agent_start', (event) => {
    event.systemPromptOptions.promptGuidelines = withEditingGuidelines(
      event.systemPromptOptions.promptGuidelines,
    );
  });
};

export default editPolicy;
