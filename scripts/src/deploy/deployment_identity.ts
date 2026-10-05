/** Provider identifiers; a split rollout has no single active version. */
export type DeploymentIdentity = Readonly<{
  deploymentId: string | null;
  versionId: string | null;
}>;

const unreported = (): DeploymentIdentity => ({ deploymentId: null, versionId: null });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.trim() === value;

/** Preserve provider sub-millisecond precision instead of guessing from array order. */
const timestamp = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) {
    return undefined;
  }
  const milliseconds = Date.parse(`${match[1]}${match[3]}`);
  const local = Date.parse(`${match[1]}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isFinite(local) ||
    new Date(local).toISOString().slice(0, 19) !== match[1]
  ) {
    return undefined;
  }
  return BigInt(milliseconds) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
};

const fullTrafficVersion = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const versions: unknown[] = value;
  let total = 0;
  const active: string[] = [];
  for (const version of versions) {
    if (
      !isRecord(version) ||
      !nonemptyString(version.version_id) ||
      typeof version.percentage !== 'number' ||
      !Number.isFinite(version.percentage) ||
      version.percentage < 0 ||
      version.percentage > 100
    ) {
      return null;
    }
    total += version.percentage;
    if (version.percentage > 0) {
      active.push(version.version_id);
    }
  }
  return total === 100 && active.length === 1 ? (active[0] ?? null) : null;
};

/** Select the newest deployment from Wrangler's JSON history, never the first regex match. */
export const parseDeploymentIdentity = (stdout: string): DeploymentIdentity => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unreported();
  }
  if (!Array.isArray(parsed)) {
    return unreported();
  }
  const deployments: unknown[] = parsed;
  let latest: { id: string; created: bigint; versions: unknown } | undefined;
  let ambiguous = false;
  for (const deployment of deployments) {
    if (!isRecord(deployment) || !nonemptyString(deployment.id)) {
      return unreported();
    }
    const created = timestamp(deployment.created_on);
    if (created === undefined) {
      // A malformed row could be the newest; omitting it would falsely identify an older one.
      return unreported();
    }
    if (latest === undefined || created > latest.created) {
      latest = { id: deployment.id, created, versions: deployment.versions };
      ambiguous = false;
      continue;
    }
    if (created === latest.created) {
      ambiguous = true;
    }
  }
  if (latest === undefined || ambiguous) {
    return unreported();
  }
  return { deploymentId: latest.id, versionId: fullTrafficVersion(latest.versions) };
};
