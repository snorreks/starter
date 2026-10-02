// scripts/src/guards/guard_readmes.ts
//
// Every first-party project has a README that answers five questions.
//
// Why this is a guard and not a checklist: a checklist is satisfied once, and the
// directory added eleven weeks later is not on it. The failure is not that a project
// lacks a README — it is that five of this repository's projects had none, and the
// ones with READMEs were the ones somebody was already looking at. The projects you do
// not read about are the projects nobody can review.
//
// The two questions it has to get right:
//
//   1. **Which directories owe a README.** Not a list: `project_discovery.ts` asks the
//      root manifest, `.moon/workspace.yml` and the filesystem for `Cargo.toml`, so a
//      project that appears under any of the new roots this round adds is covered from
//      the moment it exists. A hardcoded list would have left `packages/frontend/features`
//      and `apps/frontend/native` undocumented, which is the exact hole this file exists
//      to close.
//   2. **What "documented" means.** Five obligations, matched against headings rather
//      than against a template, so two projects written in different voices both
//      satisfy it. A README that cannot say what runs on which runtime, how to run its
//      commands, and what proves it works is the failure; the wording is not.
//
// Generated and vendored trees are excluded by the one generation policy in
// `policy.ts`, so `src-tauri/gen/android` and `.moon/cache` are not reported as
// projects that owe a hand-maintained README. Their README belongs to whatever
// generates them, which is what the regeneration policy in that project's README says.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';
import type { GuardResult, Violation } from './boundary.ts';
import { REQUIRED_README_SECTIONS } from './policy.ts';
import { describeSources, discoverProjects } from './project_discovery.ts';

/** The README a project owes, as a repo-relative path. */
const readmePath = (dir: string): string => (dir === '.' ? 'README.md' : `${dir}/README.md`);

/**
 * Every Markdown heading in a document, in order.
 *
 * Headings and not prose, because a heading is a claim that a section exists and a
 * sentence is not. Requiring particular *wording* would be worse still: it would make
 * a reworded README fail a build, which teaches people to stop reading the message
 * and to copy the wording instead.
 */
const headingsOf = (text: string): string[] => {
  const headings: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      headings.push(match[1]);
    }
  }
  return headings;
};

/** Section ids the document does not answer, in policy order. */
const missingSections = (headings: readonly string[]): string[] =>
  REQUIRED_README_SECTIONS.filter(
    (section) => !section.headings.some((pattern) => headings.some((h) => pattern.test(h))),
  ).map((section) => section.id);

/** The guidance for one section, looked up by id. */
const guidanceFor = (id: string): string =>
  REQUIRED_README_SECTIONS.find((section) => section.id === id)?.guidance ?? '';

const REQUIRED_LIST = REQUIRED_README_SECTIONS.map(
  (section) => `  ${section.id} — ${section.guidance}`,
).join('\n');

/**
 * The README coverage guard.
 *
 * Two violations, and they are different failures: a project with no README, and a
 * project whose README does not answer the questions. Both name the path and the
 * obligation, because "add documentation" is not an instruction and the five headings
 * are the whole of what is being asked for.
 */
export const guardProjectReadmes = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];

  for (const project of discoverProjects(root)) {
    const file = readmePath(project.dir);
    const full = join(root, file);

    if (!existsSync(full)) {
      violations.push({
        rule: 'project-readme-missing',
        file,
        line: 1,
        message:
          `${project.dir === '.' ? 'The repository root' : project.dir} is a first-party ` +
          `project (${project.name}, discovered from ${describeSources(project.sources)}) ` +
          'and has no README.md.\n' +
          `  Write ${file} with one heading per obligation:\n${REQUIRED_LIST}\n` +
          '  One README per project, not per source directory. Link the canonical guide\n' +
          '  in docs/ rather than copying it: a copy is a second thing that can be wrong.',
      });
      continue;
    }

    const missing = missingSections(headingsOf(readFileSync(full, 'utf8')));
    if (missing.length === 0) {
      continue;
    }

    violations.push({
      rule: 'project-readme-incomplete',
      file,
      line: 1,
      message:
        `${file} does not answer ${missing.length} of ` +
        `${REQUIRED_README_SECTIONS.length} required questions: ${missing.join(', ')}.\n` +
        missing.map((id) => `  ${id} — ${guidanceFor(id)}`).join('\n') +
        `\n  The wording is free; only the answer is required. ${project.dir === '.' ? 'The root' : project.dir} ` +
        'is discovered as a project from ' +
        `${describeSources(project.sources)}, so this file is checked like every other.`,
    });
  }

  return {
    id: 'project-readme',
    label: 'Every project README answers the five questions',
    baselineCount: 0,
    violations,
  };
};
