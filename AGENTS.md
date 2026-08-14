# AGENTS.md

Guidelines for agents working in this repository.

## The newline rule

Newlines ALWAYS carry semantic meaning in this repository.

**Line length is never a reason to insert a newline.**
Do not wrap, break, or reflow text simply because a line reached some number of characters.
A single line is exactly as long as it needs to be.
There is no width budget, and there is no "line is too long" failure mode.
This applies everywhere: code, comments, doc comments, CSS, HTML, config files, and markdown/README prose.

A newline is only ever placed for one of two semantic reasons:

1. **A statement boundary.**
  A newline separates one statement from the next.
2. **A paragraph boundary.**
  A blank line (two newlines) separates paragraphs, i.e. collections of correlated statements.

### Prose and comments

Comments and doc comments are prose.
Format them like standard English prose, but with a newline after each period:

- One statement per line.
  Each sentence ends with `.` followed by a newline and lives on its own line.
- Use a blank line (an empty comment line) to separate paragraphs (collections of correlated statements).
- Never fold a long sentence across multiple lines for width.
  If a sentence does not fit, it does not fit — leave it on one line anyway.

For example:

```ts
// Resolves the API base.
// Falls back to a default when no override is configured.
//
// The override is persisted to localStorage when available.
```

### Code

- Put a long statement on a single line rather than wrapping it for width.
- A long function signature stays on one line even with many parameters: `function method(param1, param2, …, param10)`.
  Same for call sites with many arguments.
- When several short statements would naturally fit on one line (e.g. `if (x) return;`), it is fine to leave them on one line — that is a semantic choice, not a width decision.
- Multiple lines are allowed when a construct genuinely benefits from grouping, and such grouping must be consistent with how similar short constructs are written elsewhere in the repository.
  Use judgment.
  Examples of legitimate multi-line code:
  - a lambda with a multi-statement body,
  - a literal with each element or a distinct grouped subset on its own line (blank line between correlated groups),
  - a comment attached to one specific element of a grouped literal.

When in doubt, prefer the form that gives every newline a defensible semantic reason.
A multi-line layout that exists only because a single line "was too long" is always wrong.

## Tooling

- Package manager and test runner: **Bun**.
- `bun dev` — static server (scripts/serve.mjs) serving `app/` on :52760.
- `bun test` — Bun test runner over `tests/`.
- `bun run typecheck` — `tsc --noEmit` (strict).
- `bun run build` — `tsc -p tsconfig.build.json` emitting ESM into `app/js/`.

## Layout

- `app/ts/` — runtime TypeScript source (edit this).
- `app/index.html` / `app/index.css` — the page and its stylesheet.
- `app/js/` — generated `tsc` output (git-ignored; do not hand-edit).
- `tests/` — Bun test suites.
- `scripts/serve.mjs` — dependency-free dev server.

## Style

- Read `.editorconfig` in the root of the project and follow it everywhere.
- TypeScript is maximally strict.
  Do not use `any` or `as` type assertions; prefer runtime type guards and `instanceof` narrowing.
- `bun run typecheck`, `bun test`, and `bun run build` must pass after any change.
