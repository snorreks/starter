# {{ID}} — {{TITLE}}

<!--
  Contract, full mode.

  Same idea as THIN_TEMPLATE.md — a statement of what "done" means, written
  before the work — with two sections added for changes where the design is the
  hard part: a written design, and a written critique of that design before
  anything is implemented.

  Use `standard` (the thin template) by default. Full mode costs a document
  review before any code exists, which only pays off when there is a real design
  decision with more than one reasonable answer. A change with one obvious
  implementation does not need it, and writing the design section becomes
  paperwork that gets rubber-stamped.

  Placeholders: {{ID}}, {{TITLE}}, {{TYPE}}. Substituted by `bun run contract new`.
-->

**Type:** {{TYPE}}
**Status:** draft

## Problem

<!--
  One or two sentences, in terms a user would recognise.

  If the only way to describe it names a file, say that plainly and then say what
  the user experiences because of that file.
-->

## Design

<!--
  What you intend to build, and — more usefully — what you intend NOT to build.

  "Alternatives considered" is the part that earns its keep. Write down the
  approaches you rejected and why. Without it, the next person re-derives the same
  options and picks the one you already rejected.
-->

### Approach

<!-- What, specifically. Concrete enough that a reviewer can disagree with it. -->

### Alternatives considered

<!--
| Option | Why not |
|--------|---------|
|        |         |
-->

### Contracts and boundaries

<!--
  Which schema, route, service and ViewModel does this touch? Naming them here
  surfaces a layer violation before implementation rather than after.

  See `.pi/skills/adding-a-feature/SKILL.md` for the conventions each layer owes
  the next.
-->

## Critique

<!--
  Written *before* implementation, and answered.

  Ask: what is the strongest argument against this design? What would a reviewer
  who disagrees say? What breaks at scale, or under failure, or for the second
  user rather than the first?

  A critique with no answers means the critique was not taken seriously.
-->

**Strongest objection:**

**Response:**

## Acceptance criteria

<!--
  Checkable by someone who did not write it, without asking you a question.

  Bad:  "the logs are better"
  Good: "`bun run logs api --mode production --uid <id>` returns only that user's
        events, or reports `capability_unsupported` if the adapter cannot filter"
-->

- [ ] 
- [ ] 

## Out of scope

<!-- Anything a reasonable person might assume is included. -->

## Verification

```bash
# e.g.
bun run typecheck && bun run guard && bun run test
```

**Not covered by this contract:**

- 

## Risks

<!-- What could go wrong, and what you would do about it. -->

## Notes

<!-- Decisions already made, dead ends worth not repeating, references. -->