# Schema selection for the Supabase/SvelteKit starter

Recommendation: migrate first-party application contracts to Valibot; keep TypeBox only at externally required Pi SDK/JSON Schema boundaries. Do not add Zod as another application schema authority.

## Why

Valibot implements Standard Schema directly and its modular validation is suitable for browser bundles. TypeBox is JSON Schema-native and valuable when schema documents are the main interoperability artifact. Zod 4 is substantially improved over Zod 3, and Zod Mini is a legitimate smaller option; describing all current Zod as inherently slow is inaccurate.

For this repository, ordinary DTO validation currently uses TypeBox `Value.Check`, not compiled validators. Remote functions add a Standard Schema consumer. There are 46 source/manifest files with a direct `typebox` reference in the inspected maintained roots, including Pi files that should retain their host-required schemas. Migration is significant but feasible as a single bounded PR if public schema/type exports remain stable.

## Local probe

Performed 2026-10-07 in a temporary directory outside the checkout using Bun 1.4.2 on this host. Exact installed versions: TypeBox 1.3.36, Valibot 1.5.0, Zod 4.6.5. No application dependencies or lockfiles were changed.

The payload was a strict note-create object: title length 1–120, body maximum 4000, unknown keys rejected. Cases: valid object, empty title, extra `ownerId`, and wrong body type. All validators returned `[true,false,false,false]`. Runtime used 10,000 warmup iterations and five samples of 100,000 mixed valid/invalid checks; reported median. All cases reused small objects and this is a synthetic hot-loop benchmark. `Value.Check` and compiled TypeBox return booleans; Valibot/Zod safe parsing also produces output/issues, so APIs are not computationally identical.

| Path | Median microseconds/check | Minified browser bytes | Gzip browser bytes |
|---|---:|---:|---:|
| TypeBox `Value.Check` | 1.247 | 101164 | 27979 |
| TypeBox compiled, JIT accelerated | 0.0105 | not measured | not measured |
| Valibot `safeParse` | 0.135 | 3745 | 1415 |
| Zod `safeParse` | 0.211 | 81136 | 23344 |
| Zod Mini `safeParse` | 0.280 | 14282 | 4949 |

Browser bundles use `Bun.build`, browser target, minification, one exported strict note validator, and gzip. They are isolated entrypoints, not production SvelteKit route bundles. Standard Schema interface presence: raw TypeBox false; Valibot, Zod, and Zod Mini true. The TypeBox compiled result used JIT on Bun; no equivalent workerd performance claim is made. TypeBox can fall back to interpreted evaluation when code evaluation is unavailable.

These results support Valibot for this application's current validation path and footprint, not universal superiority. Full production build size, cold startup, compile-time inference cost, large/nested DTO performance, invalid-input issue cost, workerd behavior, and Rust schema export parity remain to be verified in PR 01. The standalone probe is not a permanent test that gates speed on noisy CI.

The [standalone probe source](2026-10-07-schema-probe.ts) is retained for reproduction. Run a copy outside the checkout; it writes bundle entrypoints beside itself. From the repository root:

```bash
review_dir=$(mktemp -d /tmp/starter-schema-review.XXXXXX)
cp docs/reviews/2026-10-07-schema-probe.ts "$review_dir/probe.ts"
cat > "$review_dir/package.json" <<'JSON'
{"name":"starter-schema-review","private":true,"type":"module","dependencies":{"typebox":"1.3.36","valibot":"1.5.0","zod":"4.6.5"}}
JSON
bun install --cwd "$review_dir"
(cd "$review_dir" && bun probe.ts)
```

Keep the printed temporary path if collecting results. Timings vary by host; the script's semantic controls and reported versions matter more than reproducing the exact microsecond values.

## Selection table

| Choice | Strength | Cost for this starter |
|---|---|---|
| Keep TypeBox everywhere | Minimal migration; native JSON Schema; compiled validation can be very fast | Current browser interpreter footprint; a Standard Schema bridge; compiled-runtime behavior must be tested |
| Valibot application contracts | Direct Standard Schema; small modular browser validation; good form issues | Migration; JSON Schema conversion is separate and cannot represent arbitrary transforms |
| Zod 4 / Mini | Established ecosystem; Standard Schema; improved runtime/type-check performance | No measured advantage here over Valibot; classic Zod's isolated footprint was larger |

Strictness must survive migration: use `strictObject`, not ordinary stripping object schemas. Preserve missing versus optional versus null, integer/finite-number checks, discriminated unions, nonempty updates, regex/string-length behavior, and Rust golden-wire fixtures. Wire output types are inferred from the schema; generated database types remain a separate authority derived from SQL migrations.

## Primary sources

- [Valibot integration and Standard Schema](https://valibot.dev/guides/integrate-valibot/).
- [Valibot modular design and comparison](https://valibot.dev/guides/comparison/). Its vendor measurements are not our application benchmark.
- [Valibot JSON Schema conversion](https://valibot.dev/guides/json-schema/): conversion requires a separate package and some features cannot be represented.
- [Valibot strictObject](https://valibot.dev/api/strictObject/): unknown properties are rejected.
- [Zod 4 release notes](https://zod.dev/v4): significant improvements over Zod 3.
- [Zod Mini](https://zod.dev/packages/mini): functional, tree-shakable alternative.
- [TypeBox source and documentation](https://github.com/sinclairzx81/typebox).
- [Workers compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/): do not assume the same dynamic-code behavior in Bun and deployed Workers.
