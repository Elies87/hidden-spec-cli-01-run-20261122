[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Elies87/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Elies87/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

An entry for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

`mend` (in `main.ts`, Node 22, standard library only) applies an edit that an AI model wrote to a tree of text
files. Models write edits in four formats, and mend reads all four to one specification (the kit's SPEC.md):

- **unified diffs**, including hunks whose line numbers drifted: each hunk is placed at the occurrence nearest
  its stated position;
- **SEARCH/REPLACE blocks**, taking their path from the line above the block;
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with anchored, cursor-ordered chunks, end-of-file
  chunks and file moves;
- **text-editor tool calls as JSON** (one array, or JSON Lines): `create`, `str_replace` and `insert`.

Lines an edit names are found at the first of three matching tiers — exact, trailing-whitespace-insensitive,
then whitespace-trimmed — and at the loosest tier the replacement is re-indented to the file's own indentation.
Every edit is checked for path safety and applied in order to an in-memory tree: when any edit fails, mend
prints one `error: <code> <path>` line per failure and writes nothing; when none fail, it writes every change
and reports `A`/`D`/`M`/`R` lines in path order. `--check` reports without writing, `--strict` matches exactly
only, and `--format=` pins the format instead of detecting it.

Run it:

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]   # PATCH absent or `-`: read the patch from stdin
```

`runner.ts` beside it is the kit's trial runner, kept as handed out: when the grader sets `MAKEFUN_ENV_URL`,
`main.ts` hands the trial over to it.
