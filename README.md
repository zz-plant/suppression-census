# suppression-census

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Fail CI when your codebase gains a new way of ignoring a check, such as an `eslint-disable` comment, a `@ts-ignore`, a skipped test, or a lint rule switched off in config.

```console
$ suppression-census
❌ SUPPRESSIONS ROSE:  (lintSuppressions 1/1, typeSuppressions 2/1, skippedTests 1/0, …)

  ❌ type-checker suppressions: 2 (baseline 1, +1): type the value, or narrow to @ts-expect-error with a reason
  ❌     src/c.ts:1  // @ts-ignore
  ❌ skipped or todo tests: 1 (baseline 0, +1): fix the test or delete it; a permanently skipped test is dead weight
  ❌     test/b.test.ts:2  it.skip("flaky", () => {});
```

## Contents

- [Why](#why)
- [What it counts](#what-it-counts)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Using it as a library](#using-it-as-a-library)
- [How it compares](#how-it-compares)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Why

Linters, type checkers, and test suites all have an escape hatch. You can add a comment that tells the tool to look away, and the check goes green while the problem stays in the code. That is usually the fastest way to make a red build pass. It is also the path an AI coding agent tends to find first when it is asked to "make CI green".

The usual metrics don't catch this. Your lint error count goes down when someone adds `// eslint-disable-next-line`, which looks like progress.

suppression-census turns the escape hatches into a number of their own. You record today's count as a baseline. From then on, the count may go down but never up, and CI fails if it rises. This one-way rule is often called a *ratchet*.

## What it counts

| Category | Key in config | What matches |
| --- | --- | --- |
| Inline lint suppressions | `lintSuppressions` | `eslint-disable`, `eslint-disable-line`, `eslint-disable-next-line`, the same three for `oxlint`, and `biome-ignore` |
| Type-checker suppressions | `typeSuppressions` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| Skipped tests | `skippedTests` | `it.skip(`, `test.skip(`, `describe.skip(`, and the same with `.todo(` |
| Lint rules turned off | `disabledLintRules` | A rule set to `"off"` in your lint config with no override that turns it back on |
| Lint rules turned off for some files | `overrideDisabledRules` | A rule that is on everywhere except inside an `overrides` block |

It also enforces a minimum number of test files. Deleting tests is another way to make a suite pass, and none of the counts above would notice it.

A rule that is off at the top level only so that an `overrides` block can turn it on for certain files is treated as configuration, not debt. A common example is `max-lines` enforced for a few large files. These rules are listed in the output and not counted.

## Install

Not yet published to npm. Install it from GitHub; npm builds it on install:

```bash
npm install --save-dev github:zz-plant/suppression-census
```

Requires Node.js 20 or later, or Bun 1.1 or later.

## Quick start

**1. Record today's counts as the baseline.** Run this from your repository root:

```bash
npx suppression-census --init > suppression-census.json
```

It detects common source folders and a lint config, and writes something like this:

```json
{
  "roots": ["src", "test"],
  "lintConfig": ".oxlintrc.json",
  "exclude": [],
  "baseline": {
    "lintSuppressions": 1,
    "typeSuppressions": 1,
    "skippedTests": 0,
    "disabledLintRules": 0,
    "overrideDisabledRules": 0
  },
  "minimumTestFiles": 1
}
```

Commit this file.

**2. Add it to your checks.** In `package.json`:

```json
{
  "scripts": {
    "check:suppressions": "suppression-census"
  }
}
```

Run that script in CI, a pre-push hook, or both.

**3. Read the result.** There are three outcomes.

- **Within baseline.** Nothing rose, so the command exits with code `0`.
- **Something rose.** The command exits with code `1`, lists each category that went up, and shows the first ten new lines in each.
- **Something fell.** The command still passes, and it prints the lower number to write into your baseline:

  ```console
  ⚠ BASELINE IS LOOSE. Tighten it in suppression-census.json:
    ⚠ inline lint suppressions: 0 (baseline 1): lower it to 0
  ```

  Lowering the baseline in the same pull request that removed the suppression keeps the improvement locked in and visible in review.

## Configuration

All settings live in `suppression-census.json` at the repository root. The file may contain comments.

| Field | Required | Default | Meaning |
| --- | --- | --- | --- |
| `baseline` | Yes | | The highest allowed count per category, using the keys from [What it counts](#what-it-counts). Only the keys you list are checked. |
| `minimumTestFiles` | No | No minimum | The fewest test files allowed. By default a test file is any file ending in `.test` or `.spec` plus a JavaScript or TypeScript extension. |
| `testFilePattern` | No | `\\.(?:test\|spec)\\.[cm]?[jt]sx?$` | A regular expression that decides which scanned files count toward `minimumTestFiles`. |
| `roots` | No | The whole repository | Folders to scan, relative to the repository root. A folder that doesn't exist is skipped. |
| `lintConfig` | No | No rule audit | Path to a JSON lint config with `rules` and `overrides`. This covers `.oxlintrc.json` and the older `.eslintrc.json` format. |
| `exclude` | No | `[]` | Individual files to skip, as paths from the repository root. |
| `extensions` | No | `.ts` `.tsx` `.mts` `.cts` `.js` `.mjs` `.cjs` `.jsx` | File extensions to scan. Type declaration files such as `.d.ts` are always skipped. |
| `ignoredDirectories` | No | `node_modules`, `dist`, `build`, `coverage`, `.git`, `.next`, and a few more | Folder names to skip wherever they appear. |

Use `exclude` for a file that contains these patterns as plain text, such as a test of your own lint tooling. Otherwise every pattern in it would be counted.

### A TypeScript or JavaScript config

The config can also be an export of a `.ts`, `.mts`, `.js`, or `.mjs` module. This helps when the folder lists are shared with other tooling, or when you want comments next to each number:

```ts
// scripts/census.config.ts
import type { CensusConfig } from "suppression-census";

export const suppressionCensus: CensusConfig = {
  roots: ["src", "test"],
  lintConfig: ".oxlintrc.json",
  baseline: { lintSuppressions: 3, typeSuppressions: 1, skippedTests: 0 },
  minimumTestFiles: 40,
  testFilePattern: /\.test\.tsx?$/,
};
```

```bash
suppression-census --config scripts/census.config.ts --export suppressionCensus
```

Without `--export`, the module's default export is used. A `.ts` config needs Bun, or Node.js 22.18 or later.

### Changing the baseline

Lowering a number is the expected way the baseline changes. Raising one is a policy decision. Put it in its own commit with the reason, so it doesn't slip in alongside the change that needed the suppression.

## CLI reference

```text
suppression-census [options]

  --config <path>   Config file to read: JSON, or a .ts/.js module. Default: suppression-census.json
  --export <name>   Which export of a module config to read. Default: default
  --root <path>     Repository root to scan. Default: the current directory
  --init            Print a config with today's counts as the baseline, then exit
  --json            Print every count and every matching line as JSON, without pass or fail
```

| Exit code | Meaning |
| --- | --- |
| `0` | Every count is at or below its baseline, and the test-file minimum is met. |
| `1` | A count rose above its baseline, or the number of test files fell below the minimum. |
| `2` | No config file was found. |

## Using it as a library

```ts
import { takeCensus, compareToBaseline } from "suppression-census";

const census = takeCensus({
  root: process.cwd(),
  roots: ["src", "test"],
  lintConfig: ".oxlintrc.json",
});

console.log(census.counts);
// { lintSuppressions: 1, typeSuppressions: 2, skippedTests: 0, disabledLintRules: 0, overrideDisabledRules: 0 }

const verdict = compareToBaseline(census, { typeSuppressions: 1 }, 1);
if (!verdict.ok) {
  console.error(verdict.errors.join("\n"));
  process.exit(1);
}
```

| Export | Purpose |
| --- | --- |
| `takeCensus(options)` | Scans files and returns `counts`, `hits` with the file, line, and text of every match, `lintRules`, and the number of test files. |
| `compareToBaseline(census, baseline, minimumTestFiles?)` | Returns `{ ok, errors, improvements }`. |
| `auditLintRules(path)` | Reads a lint config and returns rules that are `disabled`, `scoped`, or `overrideDisabled`. |
| `walkFiles(options)` | Lists the files a census would scan. |
| `readConfig(path)`, `censusFromConfig(root, config)` | The same steps the command-line tool runs. |
| `DEFAULT_CATEGORIES` | The built-in patterns. Pass your own `categories` to `takeCensus` to count something else. |

## How it compares

| Tool | Lint comments | Type suppressions | Skipped tests | Rules off in config | Test-file minimum | Runs locally |
| --- | --- | --- | --- | --- | --- | --- |
| **suppression-census** | Yes | Yes | Yes | Yes | Yes | Yes |
| [Suppress Ratchet], [Type Ratchet], [Test Ratchet] | Yes | Yes | Yes | No | No | No, GitHub Actions only |
| [eslint-ratchet] | Counts lint errors, not suppressions | No | No | No | No | Yes |
| [betterer] | Write your own test for each metric | | | | | Yes |

The three Ratchet actions also cover Python and catch `.only` in tests. If you only use GitHub Actions and don't need the config-file checks, they are a good fit.

[Suppress Ratchet]: https://github.com/marketplace/actions/suppress-ratchet
[Type Ratchet]: https://github.com/marketplace/actions/type-ratchet
[Test Ratchet]: https://github.com/marketplace/actions/test-ratchet
[eslint-ratchet]: https://www.npmjs.com/package/eslint-ratchet
[betterer]: https://phenomnomnominal.github.io/betterer/

## Limitations

- Matching is done line by line on the text. It doesn't parse code, so a pattern inside a string or a comment about suppressions still counts. Use `exclude` for files where that happens.
- ESLint's flat config (`eslint.config.js`) is JavaScript, not JSON, so the rule audit can't read it. The comment and test counts still work.
- Only JavaScript and TypeScript files are scanned by default.

## Development

```bash
git clone https://github.com/zz-plant/suppression-census.git
cd suppression-census
bun install
bun run check   # type check and tests
bun run build   # compile to dist/
```

## License

[MIT](LICENSE)
