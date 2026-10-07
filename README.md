# suppression-census

One ratchet over every way a repo can tell a check to look away. The count may fall and may not rise.

## Why

Every ratchet in a CI gate shares one cheap defeat: suppress the finding instead of fixing it. `// eslint-disable-next-line`, `@ts-expect-error`, `it.skip`, a rule flipped to `"off"`, or a rule silenced inside an `overrides` block all turn a red check green while leaving the defect in place. None of them show up in the number the ratchet reports. An agent, or a person, optimizing "lint is clean" finds that path before it finds the fix, because it is shorter.

So the suppressions are themselves a metric, with a baseline that may fall and may not rise. A burn-down that trades a lint finding for a disable comment moves one number down and this one up, and the gate rejects it. The shortcut costs more than the fix.

Prior art does pieces of this. `eslint-ratchet` and per-rule count scripts cover lint comments. A few GitHub Actions count `@ts-ignore` or skipped tests. Nothing maintained does all five in one meter:

| Counted | Pattern |
| --- | --- |
| inline lint suppressions | `eslint-disable*`, `oxlint-disable*`, `biome-ignore` |
| type-checker suppressions | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| skipped or todo tests | `it.skip(`, `test.skip(`, `describe.skip(`, `*.todo(` |
| disabled lint rules | a rule `"off"` at the top level with no override re-enabling it |
| rules disabled by an override | a rule enforced everywhere except inside one `overrides` block |

Plus a floor on the number of test files, because deleting tests is the other way to make a suite green and it moves no number above.

## Install

```bash
bun add -d suppression-census
```

Pin today's counts:

```bash
bunx suppression-census --init > suppression-census.json
```

Which writes something like:

```json
{
  "roots": ["app", "lib", "scripts", "tests"],
  "lintConfig": ".oxlintrc.json",
  "exclude": [],
  "baseline": {
    "lintSuppressions": 4,
    "typeSuppressions": 3,
    "skippedTests": 0,
    "disabledLintRules": 0,
    "overrideDisabledRules": 2
  },
  "minimumTestFiles": 212
}
```

Then add it to the gate:

```json
{ "scripts": { "check:suppressions": "suppression-census" } }
```

Exit code 1 when any count rises above its ceiling or the test-file count falls below the floor. A decrease passes and prints the ceiling to lower, so tightening lands in the same diff as the work that earned it and is visible in review.

## Config

| Field | Meaning |
| --- | --- |
| `roots` | Directories to scan, relative to the repo root. Default: the whole root. |
| `extensions` | File extensions to scan. Default: `.ts .tsx .mts .cts .js .mjs .cjs .jsx`. Declaration files are always skipped. |
| `ignoredDirectories` | Directory names skipped anywhere in the tree. Default includes `node_modules`, `dist`, `.next`, `coverage`. |
| `exclude` | Root-relative files to skip, for a file that spells the patterns out as literals (a test of your own tooling, say). |
| `lintConfig` | A config with `rules` and `overrides[].rules`: `.oxlintrc.json` or a legacy `.eslintrc.json`. Comments are tolerated. Omit to skip the rule audit. ESLint flat config is JavaScript and is not read. |
| `baseline` | Ceiling per category key. |
| `minimumTestFiles` | Floor on files matching `.test.* ` or `.spec.*`. |

A rule that is `"off"` at the top level only so an `overrides` block can apply it where it matters (`max-lines` for two file-size budgets, say) is configuration, not debt. It is reported as scoped and not counted.

## CLI

```
suppression-census                 # reads ./suppression-census.json
suppression-census --config other.json
suppression-census --root ../repo
suppression-census --init          # print a config at today's counts
suppression-census --json          # the census as JSON, no verdict
```

## Library

```ts
import { takeCensus, compareToBaseline } from "suppression-census";

const census = takeCensus({ root: process.cwd(), roots: ["src"], lintConfig: ".oxlintrc.json" });
const verdict = compareToBaseline(census, baseline, minimumTestFiles);
```

`census.hits[key]` lists every site with file, line, and text. `census.lintRules` separates `disabled`, `scoped`, and `overrideDisabled`.

## Raising a ceiling

Raising one is a policy change. Put it in its own commit with the reason, not folded into the change that needed the suppression.

## License

MIT
