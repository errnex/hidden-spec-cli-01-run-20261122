# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/errnex/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/errnex/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON — and `mend` reads each exactly as the specification says, changing
every file or nothing.

**Verified: 100/100 practice checks (practice score 1000), plus 64/64
hand-written edge checks** covering CRLF files, files without a final line
break, `\ No newline at end of file`, moves (`R` lines), chained moves,
ambiguous matches, tier-2 re-indentation, V4A anchors/cursors/end-of-file
chunks, and every usage/parse error path. A full local trial through the
kit's env server posts 100 results and scores 1000.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). Absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`/`D`/`M`, `R old -> new` for a
move) and `ok: <n> files`. Exit 1 lists every failed edit and
`failed: <k> of <n> edits` — and writes nothing. Exit 2 reports a usage,
no-patch, format or parse error on one line.

## How it works

- **Matching (SPEC §5).** Old lines are found at the first of three tiers
  with a match: exact, trailing whitespace ignored, both ends ignored.
  A unified hunk takes the occurrence nearest its `@@` line number; a
  SEARCH/REPLACE block fails `ambiguous` when its old lines occur more than
  once at that tier; a V4A chunk takes the first occurrence at or after its
  cursor. Context lines are written as the file's own matched lines, and at
  tier 2 added lines are re-indented from the patch's indentation to the
  file's.
- **Unified diffs (SPEC §6).** Sections from `diff --git` or `---`/`+++`
  pairs; creations, deletions and renames (including `rename from`/`to`
  alone); hunks apply in order with the `d` offset, so wrong line numbers
  still land on the nearest match; `\ No newline at end of file` decides
  the result's final line break.
- **SEARCH/REPLACE (SPEC §7).** The path is the nearest non-blank,
  non-fence line above the block, or the previous block's path; an empty old
  block creates the file.
- **V4A (SPEC §8).** Anchored chunks with a cursor, end-of-file chunks,
  `*** Move to:`.
- **JSON (SPEC §9).** `create`, `str_replace` (exact, CRLF-aware) and
  `insert`.
- **Atomicity (SPEC §10).** Edits apply in order to the tree as earlier
  edits left it; a failed edit changes nothing, later edits still run, and
  when any edit failed no file is written. Every path is safety-checked
  before anything else about it.

## Test it

The kit's practice set (100 checks with the house reference's expected
outcomes) lives outside this repository, in the competition kit at
`program/generator/practice.json`; run it there with the kit's `check.ts`
against this `main.ts` and `runner.ts`.

`runner.ts` is kept as the kit has it: with `MAKEFUN_ENV_URL` set, `main.ts`
hands a trial over to it.

## Licence

MIT. See [LICENSE](LICENSE).
