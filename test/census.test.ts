import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditLintRulesFromConfig,
  censusFromConfig,
  compareToBaseline,
  parseConfig,
  stripJsonComments,
  takeCensus,
  walkFiles,
} from "../src/index.js";

/**
 * The census guards every other ratchet in a gate, so the failure that matters is
 * not a wrong count: it is a scanner that quietly finds nothing and reports a clean
 * repo. These pin detection against a fixture tree with known suppressions.
 */
let root: string;

const write = (relativePath: string, content: string) => {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "suppression-census-"));
  write("src/a.ts", [
    "// eslint-disable-next-line no-console",
    "console.log(1); // oxlint-disable-line",
    "/* eslint-disable */",
    "// @ts-expect-error legacy",
    "// @ts-ignore",
    "const x: number = 1;",
  ].join("\n"));
  write("src/b.tsx", "// biome-ignore lint/suspicious/noExplicitAny: fine\nexport const y = 1;\n");
  write("src/types.d.ts", "// @ts-ignore in a declaration file is not scanned\n");
  write("tests/a.test.ts", "it.skip('later', () => {});\ndescribe.todo('x');\ntest('ok', () => {});\n");
  write("tests/b.spec.ts", "test('fine', () => {});\n");
  write("tests/meter.test.ts", "// this file spells `it.skip(` out and is excluded by config\n");
  write("node_modules/dep/index.js", "// eslint-disable\n// @ts-ignore\n");
  write("dist/out.js", "// eslint-disable\n");
  write("docs/readme.md", "// eslint-disable in prose is not code\n");
  write(".oxlintrc.json", JSON.stringify({
    rules: {
      "no-unused-vars": "error",
      "max-lines": "off",
      "no-console": "off",
      "no-debugger": ["off"],
      "react/purity": 2,
    },
    overrides: [
      { files: ["src/big.ts"], rules: { "max-lines": ["error", 400] } },
      { files: ["src/legacy.ts"], rules: { "no-unused-vars": "off" } },
    ],
  }));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("walkFiles", () => {
  it("skips ignored directories, declaration files, non-code, and excluded paths", () => {
    const files = walkFiles({ root, exclude: ["tests/meter.test.ts"] });
    assert.deepEqual(files, ["src/a.ts", "src/b.tsx", "tests/a.test.ts", "tests/b.spec.ts"]);
  });

  it("skips an entry it cannot stat instead of crashing the gate", () => {
    const linked = mkdtempSync(join(tmpdir(), "suppression-census-link-"));
    try {
      mkdirSync(join(linked, "src"));
      writeFileSync(join(linked, "src", "a.ts"), "export const a = 1;\n");
      symlinkSync(join(linked, "gone.ts"), join(linked, "src", "dangling.ts"));
      assert.deepEqual(walkFiles({ root: linked }), ["src/a.ts"]);
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });

  it("scans only the roots it was given, and tolerates a missing one", () => {
    assert.deepEqual(walkFiles({ root, roots: ["tests", "nowhere"] }), [
      "tests/a.test.ts",
      "tests/b.spec.ts",
      "tests/meter.test.ts",
    ]);
  });
});

describe("takeCensus", () => {
  it("counts every occurrence, per category, with file and line", () => {
    const census = takeCensus({ root, exclude: ["tests/meter.test.ts"], lintConfig: ".oxlintrc.json" });

    assert.equal(census.counts.lintSuppressions, 4, "two eslint spellings, one oxlint, one biome");
    assert.equal(census.counts.typeSuppressions, 2);
    assert.equal(census.counts.skippedTests, 2);
    assert.equal(census.counts.disabledLintRules, 2, "no-console and no-debugger; max-lines is scoped");
    assert.equal(census.counts.overrideDisabledRules, 1);
    assert.equal(census.testFiles, 2);
    assert.equal(census.filesScanned, 4);

    assert.deepEqual(census.hits.typeSuppressions, [
      { file: "src/a.ts", line: 4, text: "// @ts-expect-error legacy" },
      { file: "src/a.ts", line: 5, text: "// @ts-ignore" },
    ]);
  });

  it("omits the rule counts when no lint config is given", () => {
    const census = takeCensus({ root });
    assert.equal(census.lintRules, null);
    assert.equal("disabledLintRules" in census.counts, false);
  });
});

describe("auditLintRulesFromConfig", () => {
  it("separates off-everywhere from off-but-scoped, and counts an override that silences", () => {
    const audit = auditLintRulesFromConfig({
      rules: { a: "off", b: 0, c: "error", d: "warn" },
      overrides: [{ rules: { a: "error", c: "off" } }, { rules: { d: ["off"] } }],
    });
    assert.deepEqual(audit, { disabled: ["b"], scoped: ["a"], overrideDisabled: ["c", "d"] });
  });

  it("refuses a config that is not an object rather than reporting it clean", () => {
    assert.throws(() => auditLintRulesFromConfig([]), /cannot be trusted/);
    assert.throws(() => auditLintRulesFromConfig(null), /cannot be trusted/);
  });

  it("parses a config with comments", () => {
    const text = '{ // top\n "rules": { "x": "off" /* why */, "s": "a//b" } }';
    const parsed: unknown = JSON.parse(stripJsonComments(text));
    assert.deepEqual(parsed, { rules: { x: "off", s: "a//b" } });
  });
});

describe("compareToBaseline", () => {
  const fullCensus = () => takeCensus({ root, exclude: ["tests/meter.test.ts"], lintConfig: ".oxlintrc.json" });

  it("passes at the baseline and names what to lower when under it", () => {
    const census = fullCensus();
    const exact = compareToBaseline(census, { ...census.counts }, 2);
    assert.equal(exact.ok, true);
    assert.deepEqual(exact.improvements, []);

    const loose = compareToBaseline(census, { ...census.counts, skippedTests: 5 }, 1);
    assert.equal(loose.ok, true);
    assert.deepEqual(loose.improvements, ["skipped or todo tests: 2 (baseline 5): lower it to 2"]);
  });

  it("fails when a count rises, listing the sites, and when the test floor is breached", () => {
    const census = fullCensus();
    const verdict = compareToBaseline(census, { ...census.counts, typeSuppressions: 1, disabledLintRules: 0 }, 3);
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors[0] ?? "", /^type-checker suppressions: 2 \(baseline 1, \+1\)/);
    assert.match(verdict.errors[1] ?? "", /src\/a\.ts:4/);
    assert.ok(verdict.errors.some((line) => line === "    off: no-console"));
    assert.ok(verdict.errors.some((line) => /test files: 2 \(floor 3\)/.test(line)));
  });

  it("treats a baseline key the census has no count for as zero", () => {
    const verdict = compareToBaseline(takeCensus({ root }), { disabledLintRules: 0 });
    assert.equal(verdict.ok, true);
  });
});

describe("config", () => {
  it("round-trips through parseConfig and censusFromConfig", () => {
    const config = parseConfig({
      roots: ["src"],
      lintConfig: ".oxlintrc.json",
      baseline: { lintSuppressions: 4, typeSuppressions: 2 },
      minimumTestFiles: 0,
    });
    const census = censusFromConfig(root, config);
    assert.equal(census.filesScanned, 2);
    assert.equal(compareToBaseline(census, config.baseline, config.minimumTestFiles).ok, true);
  });

  it("counts test files by a configured pattern, given as a string or a RegExp", () => {
    const fromString = censusFromConfig(root, parseConfig({ roots: ["tests"], baseline: { skippedTests: 2 }, testFilePattern: "\\.spec\\.ts$" }));
    assert.equal(fromString.testFiles, 1);
    const fromRegExp = censusFromConfig(root, parseConfig({ roots: ["tests"], baseline: { skippedTests: 2 }, testFilePattern: /\.test\.ts$/ }));
    assert.equal(fromRegExp.testFiles, 2);
  });

  it("rejects an empty or malformed baseline", () => {
    assert.throws(() => parseConfig({ baseline: {} }), /baseline is empty/);
    assert.throws(() => parseConfig({ baseline: { x: -1 } }), /non-negative integer/);
    assert.throws(() => parseConfig({ baseline: { x: "3" } }), /non-negative integer/);
  });
});
