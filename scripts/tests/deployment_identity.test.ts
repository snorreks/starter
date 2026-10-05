import { expect, test } from 'bun:test';
import { parseDeploymentIdentity } from '../src/deploy/deployment_identity.ts';

const row = (options: { id: string; created: string; versions?: unknown[] }) => ({
  id: options.id,
  created_on: options.created,
  versions: options.versions ?? [{ version_id: `${options.id}-version`, percentage: 100 }],
});
const select = (history: unknown) => parseDeploymentIdentity(JSON.stringify(history));
const old = row({ id: 'old', created: '2026-10-05T14:07:34.930766Z' });
const current = row({ id: 'current', created: '2026-10-05T17:59:28.57126Z' });
const unreported = { deploymentId: null, versionId: null };

test('an older deployment listed first cannot overwrite the current identity', () => {
  expect(select([old, current])).toEqual({ deploymentId: 'current', versionId: 'current-version' });
  expect(select([current, old])).toEqual({ deploymentId: 'current', versionId: 'current-version' });
});

test('sub-millisecond provider timestamps do not fall back to history order', () => {
  const earlier = row({ id: 'earlier', created: '2026-10-05T17:59:28.571260Z' });
  const later = row({ id: 'later', created: '2026-10-05T17:59:28.571261Z' });
  expect(select([earlier, later])).toEqual({ deploymentId: 'later', versionId: 'later-version' });
  expect(select([later, earlier])).toEqual({ deploymentId: 'later', versionId: 'later-version' });
});

test('different timezone offsets are ordered by the same instant', () => {
  const later = row({ id: 'later', created: '2026-10-05T20:00:00+02:00' });
  expect(select([later, current]).deploymentId).toBe('later');
});

test('a tied newest timestamp cannot claim an arbitrary deployment', () => {
  expect(select([current, { ...current, id: 'other' }])).toEqual(unreported);
  expect(select([{ ...old, id: 'old-twin' }, old, current]).deploymentId).toBe('current');
});

test('split traffic cannot claim either version as the entire release', () => {
  const split = row({
    id: 'split',
    created: '2026-10-05T18:00:00Z',
    versions: [
      { version_id: 'first', percentage: 50 },
      { version_id: 'second', percentage: 50 },
    ],
  });
  expect(select([old, split])).toEqual({ deploymentId: 'split', versionId: null });
});

test('zero-traffic versions do not hide the one full-traffic version', () => {
  expect(
    select([
      {
        ...current,
        versions: [
          { version_id: 'inactive', percentage: 0 },
          { version_id: 'active', percentage: 100 },
        ],
      },
    ]),
  ).toEqual({ deploymentId: 'current', versionId: 'active' });
});

test('invalid traffic data does not claim a full-traffic version', () => {
  for (const versions of [
    [],
    [{ version_id: 'unknown' }],
    [{ version_id: 'partial', percentage: 80 }],
    [{ version_id: 'string', percentage: '100' }],
    [{ version_id: '', percentage: 100 }],
    [{ version_id: 'over', percentage: 101 }],
    [{ version_id: 'negative', percentage: -1 }],
    [
      { version_id: 'one', percentage: 100 },
      { version_id: 'two', percentage: 100 },
    ],
    [{ version_id: 'valid', percentage: 100 }, {}],
  ]) {
    expect(select([{ ...current, versions }])).toEqual({
      deploymentId: 'current',
      versionId: null,
    });
  }
});

test('a malformed history row cannot be silently treated as older', () => {
  for (const malformed of [
    null,
    {},
    { ...old, id: '' },
    { ...old, created_on: undefined },
    { ...old, created_on: 'not a date' },
    { ...old, created_on: '2026-02-30T12:00:00Z' },
  ]) {
    expect(select([current, malformed])).toEqual(unreported);
  }
});

test('absent, malformed and obsolete response shapes remain explicitly unreported', () => {
  for (const history of [
    [],
    null,
    {},
    { id: 'flat', version_id: 'obsolete' },
    { deployments: [current] },
  ]) {
    expect(select(history)).toEqual(unreported);
  }
  expect(parseDeploymentIdentity('not JSON')).toEqual(unreported);
});

test('nested identifier text cannot supply a deployment or version identity', () => {
  expect(select([{ note: { id: 'misleading', version_id: 'wrong' }, ...current }])).toEqual({
    deploymentId: 'current',
    versionId: 'current-version',
  });
});
