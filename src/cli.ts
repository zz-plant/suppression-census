#!/usr/bin/env node
/**
 * Usage:
 *   suppression-census                       # reads ./suppression-census.json
 *   suppression-census --config path.json
 *   suppression-census --config census.config.ts --export suppressionCensus
 *   suppression-census --root ../other-repo
 *   suppression-census --init                # prints a config pinned at today's counts
 *   suppression-census --json                # machine-readable census, no verdict
 *
 * Exit 1 when any count rose above its baseline or the test-file count fell
 * below the floor. A decrease passes and prints the ceiling to lower.
 */
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  censusFromConfig,
  compareToBaseline,
  parseConfig,
  readConfig,
  takeCensus,
  type CensusConfig,
} from "./index.js";

const args = process.argv.slice(2);
const hasFlag = (flag: string) => args.includes(flag);
const readArg = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? undefined : args[index + 1];
};

const root = resolve(readArg("--root") ?? process.cwd());
const configPath = resolve(root, readArg("--config") ?? "suppression-census.json");
const exportName = readArg("--export") ?? "default";

/**
 * A JSON config is read as data. A module config is imported, so it can share constants
 * with other tooling and carry a RegExp; a `.ts` one needs Bun or Node 22.18 or later.
 */
const loadConfig = async (): Promise<CensusConfig> => {
  if (!/\.[cm]?[jt]s$/.test(configPath)) return readConfig(configPath);
  const loaded: unknown = await import(pathToFileURL(configPath).href);
  const exported: unknown = loaded !== null && typeof loaded === "object" ? Reflect.get(loaded, exportName) : undefined;
  if (exported === undefined) throw new Error(`${configPath} has no export named "${exportName}"`);
  return parseConfig(exported, `${configPath}#${exportName}`);
};

const printInit = () => {
  const lintConfig = [".oxlintrc.json", ".eslintrc.json"].find((candidate) => existsSync(resolve(root, candidate)));
  const roots = ["src", "app", "lib", "scripts", "tests", "test"].filter((candidate) => existsSync(resolve(root, candidate)));
  const census = takeCensus({ root, roots: roots.length > 0 ? roots : undefined, lintConfig });
  const config: CensusConfig = {
    ...(roots.length > 0 ? { roots } : {}),
    ...(lintConfig ? { lintConfig } : {}),
    exclude: [],
    baseline: census.counts,
    minimumTestFiles: census.testFiles,
  };
  console.log(JSON.stringify(config, null, 2));
};

const main = async (): Promise<number> => {
  if (hasFlag("--init")) {
    printInit();
    return 0;
  }

  if (!existsSync(configPath)) {
    console.error(`No config at ${configPath}. Run \`suppression-census --init > suppression-census.json\` to pin today's counts.`);
    return 2;
  }

  const config = await loadConfig();
  const census = censusFromConfig(root, config);

  if (hasFlag("--json")) {
    console.log(JSON.stringify({ counts: census.counts, testFiles: census.testFiles, lintRules: census.lintRules, hits: census.hits }, null, 2));
    return 0;
  }

  const verdict = compareToBaseline(census, config.baseline, config.minimumTestFiles);

  if (verdict.improvements.length > 0) {
    console.log(`\n⚠ BASELINE IS LOOSE. Tighten it in ${relative(process.cwd(), configPath)}:`);
    for (const improvement of verdict.improvements) console.log(`  ⚠ ${improvement}`);
  }

  if (census.lintRules && census.lintRules.scoped.length > 0) {
    console.log(`\n  ℹ off globally, enforced by an override (not counted): ${census.lintRules.scoped.join(", ")}`);
  }

  const summary = Object.entries(census.counts)
    .map(([key, value]) => `${key} ${value}/${config.baseline[key] ?? "–"}`)
    .join(", ");
  console.log(
    `\n${verdict.ok ? "✅ Suppression census within baseline" : "❌ SUPPRESSIONS ROSE:"}  (${summary}, ${census.testFiles} test files, ${census.filesScanned} scanned)\n`,
  );

  if (!verdict.ok) {
    for (const error of verdict.errors) console.error(`  ❌ ${error}`);
    return 1;
  }
  return 0;
};

process.exitCode = await main();
