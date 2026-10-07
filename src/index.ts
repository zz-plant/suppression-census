/**
 * Counts the ways a repo can tell a check to look away, and reports when the
 * count goes up.
 *
 * Every ratchet in a gate shares one cheap defeat: suppress the finding instead
 * of fixing it. `// eslint-disable-next-line`, `@ts-expect-error`, and `it.skip`
 * all turn a red check green while leaving the defect in place, and none of them
 * show up in the number the ratchet reports. An agent (or a person) optimizing
 * "lint is clean" finds that path before the fix, because it is shorter.
 *
 * So the suppressions are themselves a metric, with a baseline that may fall and
 * may not rise. A burn-down that trades a lint finding for a disable comment
 * moves one number down and this one up, and the gate rejects it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export type Category = {
  key: string;
  label: string;
  /** What a reader should do about a finding in this category. */
  remedy: string;
  pattern: RegExp;
};

export const DEFAULT_CATEGORIES: readonly Category[] = [
  {
    key: "lintSuppressions",
    label: "inline lint suppressions",
    remedy: "fix the finding, or narrow the disable to one line with a `--` reason",
    // oxlint and biome honour eslint-disable comments, so every spelling suppresses.
    pattern: /\b(?:es|ox|biome-ignore )?lint-disable(?:-next-line|-line)?\b|\bbiome-ignore\b/g,
  },
  {
    key: "typeSuppressions",
    label: "type-checker suppressions",
    remedy: "type the value, or narrow to @ts-expect-error with a reason",
    pattern: /@ts-(?:ignore|expect-error|nocheck)\b/g,
  },
  {
    key: "skippedTests",
    label: "skipped or todo tests",
    remedy: "fix the test or delete it; a permanently skipped test is dead weight",
    pattern: /\b(?:it|test|describe)\.(?:skip|todo)\s*\(/g,
  },
];

export const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

export const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  ".next",
  ".vercel",
  ".wrangler",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
];

export const DEFAULT_TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export interface WalkOptions {
  /** Absolute path every reported path is relative to. */
  root: string;
  /** Directories under `root` to scan. Default: `root` itself. */
  roots?: readonly string[] | undefined;
  extensions?: readonly string[] | undefined;
  ignoredDirectories?: readonly string[] | undefined;
  /** Root-relative paths to skip, e.g. a file that spells the patterns out as literals. */
  exclude?: readonly string[] | undefined;
}

const toPosix = (value: string) => value.split(sep).join("/");

/** Every scannable file under the roots, as sorted root-relative POSIX paths. */
export function walkFiles(options: WalkOptions): string[] {
  const root = resolve(options.root);
  const roots = options.roots ?? ["."];
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const ignored = new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES);
  const excluded = new Set(options.exclude ?? []);
  const files: string[] = [];

  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      if (ignored.has(entry)) continue;
      const child = join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!extensions.some((extension) => entry.endsWith(extension))) continue;
      if (/\.d\.[cm]?ts$/.test(entry)) continue;
      const relativePath = toPosix(relative(root, child));
      if (excluded.has(relativePath)) continue;
      files.push(relativePath);
    }
  };

  for (const scanRoot of roots) {
    const absolute = resolve(root, scanRoot);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute);
    // A root that does not exist is not a failure; the repo layout may change.
  }

  return files.sort();
}

/**
 * Rules switched off in a lint config without a scoped override that turns them
 * back on. Reads the `rules` + `overrides[].rules` shape that `.oxlintrc.json`
 * and legacy `.eslintrc.json` share. A rule that is globally off only so an
 * `overrides` block can apply it where it matters is configuration, not debt,
 * and is reported as `scoped` rather than counted.
 */
export type RuleAudit = {
  disabled: string[];
  scoped: string[];
  /** Enforced everywhere except inside an override: a suppression with a wider blast radius than a comment. */
  overrideDisabled: string[];
};

const isOff = (value: unknown): boolean =>
  value === "off" || value === 0 || (Array.isArray(value) && (value[0] === "off" || value[0] === 0));

const isEnabled = (value: unknown): boolean =>
  value === "error" ||
  value === "warn" ||
  value === 1 ||
  value === 2 ||
  (Array.isArray(value) && value[0] !== "off" && value[0] !== 0);

/**
 * Narrow a parsed JSON value to a plain object. Asserting the config's shape
 * instead would let a malformed file report zero disabled rules; a meter that
 * lies clean is worse than one that fails, so `auditLintRules` throws instead.
 */
const toRecord = (value: unknown): Record<string, unknown> => {
  const record: Record<string, unknown> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return record;
  for (const [key, entry] of Object.entries(value)) record[key] = entry;
  return record;
};

export function auditLintRulesFromConfig(parsed: unknown, source = "lint config"): RuleAudit {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source} did not parse to an object; the rule census cannot be trusted`);
  }

  const config = toRecord(parsed);
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];

  const overridden = new Set<string>();
  const silenced = new Set<string>();
  for (const override of overrides) {
    for (const [rule, value] of Object.entries(toRecord(toRecord(override).rules))) {
      if (isEnabled(value)) overridden.add(rule);
      if (isOff(value)) silenced.add(rule);
    }
  }

  const topLevel = toRecord(config.rules);

  const disabled: string[] = [];
  const scoped: string[] = [];
  for (const [rule, value] of Object.entries(topLevel)) {
    if (!isOff(value)) continue;
    (overridden.has(rule) ? scoped : disabled).push(rule);
  }

  const overrideDisabled = [...silenced].filter((rule) => !isOff(topLevel[rule]));

  return {
    disabled: disabled.sort(),
    scoped: scoped.sort(),
    overrideDisabled: overrideDisabled.sort(),
  };
}

/** Strips `//` and `/* *\/` comments so a JSONC lint config parses. Strings are left alone. */
export const stripJsonComments = (text: string): string =>
  text.replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, str: string | undefined) => str ?? "");

export function auditLintRules(configPath: string): RuleAudit {
  const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  return auditLintRulesFromConfig(parsed, configPath);
}

export type CensusHit = { file: string; line: number; text: string };

export type Census = {
  counts: Record<string, number>;
  hits: Record<string, CensusHit[]>;
  /** Absent when no lint config was given. */
  lintRules: RuleAudit | null;
  testFiles: number;
  filesScanned: number;
};

export interface CensusOptions extends WalkOptions {
  categories?: readonly Category[] | undefined;
  /** Path to a `rules` + `overrides` lint config, relative to `root`. Omit to skip the rule audit. */
  lintConfig?: string | undefined;
  testFilePattern?: RegExp | undefined;
}

export function takeCensus(options: CensusOptions): Census {
  const root = resolve(options.root);
  const categories = options.categories ?? DEFAULT_CATEGORIES;
  const testFilePattern = options.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN;
  const files = walkFiles(options);

  const hits: Record<string, CensusHit[]> = {};
  for (const category of categories) hits[category.key] = [];

  for (const file of files) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const category of categories) {
        category.pattern.lastIndex = 0;
        const matches = line.match(category.pattern);
        if (!matches) continue;
        for (let occurrence = 0; occurrence < matches.length; occurrence += 1) {
          hits[category.key]?.push({ file, line: index + 1, text: line.trim() });
        }
      }
    });
  }

  const lintRules = options.lintConfig ? auditLintRules(resolve(root, options.lintConfig)) : null;

  const counts: Record<string, number> = Object.fromEntries(
    categories.map((category) => [category.key, hits[category.key]?.length ?? 0]),
  );
  if (lintRules) {
    counts.disabledLintRules = lintRules.disabled.length;
    counts.overrideDisabledRules = lintRules.overrideDisabled.length;
  }

  return {
    counts,
    hits,
    lintRules,
    testFiles: files.filter((file) => testFilePattern.test(file)).length,
    filesScanned: files.length,
  };
}

export type Verdict = {
  /** Lines a gate should print and fail on. */
  errors: string[];
  /** Keys whose count fell below the baseline, with the suggested new ceiling. */
  improvements: string[];
  ok: boolean;
};

const RULE_LABELS: Record<string, { label: string; remedy: string }> = {
  disabledLintRules: {
    label: "disabled lint rules",
    remedy: "enforce the rule in the lint config instead of leaving it off",
  },
  overrideDisabledRules: {
    label: "lint rules disabled by an override",
    remedy: "enforce the rule in that override too, or fix the files it covers",
  },
};

/**
 * Every baseline entry is a ceiling: lower it when the work earns it, never raise it.
 * `minimumTestFiles` is a floor, because deleting tests is the other way to make a
 * suite green and it moves no number above.
 *
 * A decrease passes and is reported, rather than failing: the gate's job is stopping
 * regressions, and failing a build because someone deleted an unused import teaches
 * people to avoid the check rather than to lower it.
 */
export function compareToBaseline(
  census: Census,
  baseline: Record<string, number>,
  minimumTestFiles?: number,
  categories: readonly Category[] = DEFAULT_CATEGORIES,
): Verdict {
  const errors: string[] = [];
  const improvements: string[] = [];

  for (const key of Object.keys(baseline)) {
    const actual = census.counts[key] ?? 0;
    const allowed = baseline[key] ?? 0;
    const category = categories.find((entry) => entry.key === key);
    const label = category?.label ?? RULE_LABELS[key]?.label ?? key;
    const remedy = category?.remedy ?? RULE_LABELS[key]?.remedy ?? "fix the finding";

    if (actual > allowed) {
      errors.push(`${label}: ${actual} (baseline ${allowed}, +${actual - allowed}): ${remedy}`);
      for (const hit of (census.hits[key] ?? []).slice(0, 10)) {
        errors.push(`    ${hit.file}:${hit.line}  ${hit.text.slice(0, 100)}`);
      }
      if (key === "disabledLintRules") {
        for (const rule of census.lintRules?.disabled ?? []) errors.push(`    off: ${rule}`);
      }
      if (key === "overrideDisabledRules") {
        for (const rule of census.lintRules?.overrideDisabled ?? []) errors.push(`    off in an override: ${rule}`);
      }
    } else if (actual < allowed) {
      improvements.push(`${label}: ${actual} (baseline ${allowed}): lower it to ${actual}`);
    }
  }

  if (minimumTestFiles !== undefined && census.testFiles < minimumTestFiles) {
    errors.push(
      `test files: ${census.testFiles} (floor ${minimumTestFiles}): a suite that shrinks is a suite that got easier to pass`,
    );
  }

  return { errors, improvements, ok: errors.length === 0 };
}

/** The on-disk config shape, usually `suppression-census.json` at the repo root. */
export interface CensusConfig {
  roots?: string[];
  extensions?: string[];
  ignoredDirectories?: string[];
  exclude?: string[];
  lintConfig?: string;
  baseline: Record<string, number>;
  minimumTestFiles?: number;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

export function parseConfig(parsed: unknown, source = "config"): CensusConfig {
  const record = toRecord(parsed);
  const baseline = toRecord(record.baseline);
  const typedBaseline: Record<string, number> = {};
  for (const [key, value] of Object.entries(baseline)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw new Error(`${source}: baseline.${key} must be a non-negative integer`);
    }
    typedBaseline[key] = value;
  }
  if (Object.keys(typedBaseline).length === 0) {
    throw new Error(`${source}: baseline is empty; nothing would be ratcheted`);
  }

  const config: CensusConfig = { baseline: typedBaseline };
  if (isStringArray(record.roots)) config.roots = record.roots;
  if (isStringArray(record.extensions)) config.extensions = record.extensions;
  if (isStringArray(record.ignoredDirectories)) config.ignoredDirectories = record.ignoredDirectories;
  if (isStringArray(record.exclude)) config.exclude = record.exclude;
  if (typeof record.lintConfig === "string") config.lintConfig = record.lintConfig;
  if (typeof record.minimumTestFiles === "number") config.minimumTestFiles = record.minimumTestFiles;
  return config;
}

export function readConfig(configPath: string): CensusConfig {
  return parseConfig(JSON.parse(stripJsonComments(readFileSync(configPath, "utf8"))), configPath);
}

/** Runs a census from a config file's settings, relative to `root`. */
export function censusFromConfig(root: string, config: CensusConfig): Census {
  return takeCensus({
    root,
    roots: config.roots,
    extensions: config.extensions,
    ignoredDirectories: config.ignoredDirectories,
    exclude: config.exclude,
    lintConfig: config.lintConfig,
  });
}
