import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
let root: string;

const run = (...args: string[]) => {
  const result = Bun.spawnSync(["bun", cli, "--root", root, ...args]);
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "suppression-census-cli-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "// @ts-ignore\nexport const a = 1;\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("cli", () => {
  it("explains how to start when there is no config", () => {
    const { code, stderr } = run();
    assert.equal(code, 2);
    assert.match(stderr, /--init/);
  });

  it("--init prints a config pinned at today's counts, and that config then passes", () => {
    const init = run("--init");
    assert.equal(init.code, 0);
    const config: unknown = JSON.parse(init.stdout);
    assert.deepEqual(config, {
      roots: ["src"],
      exclude: [],
      baseline: { lintSuppressions: 0, typeSuppressions: 1, skippedTests: 0 },
      minimumTestFiles: 0,
    });
    writeFileSync(join(root, "suppression-census.json"), init.stdout);

    const check = run();
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /within baseline/);
  });

  it("fails once a suppression is added", () => {
    writeFileSync(join(root, "src", "b.ts"), "// @ts-expect-error\nexport const b = 1;\n");
    const { code, stderr } = run();
    assert.equal(code, 1);
    assert.match(stderr, /type-checker suppressions: 2 \(baseline 1, \+1\)/);
    assert.match(stderr, /src\/b\.ts:1/);
  });

  it("reads a named export of a TypeScript config module", () => {
    writeFileSync(
      join(root, "census.config.ts"),
      [
        'const shared: string[] = ["node_modules"];',
        "export const census = {",
        '  roots: ["src"],',
        "  ignoredDirectories: shared,",
        "  baseline: { typeSuppressions: 2 },",
        "  testFilePattern: /\\.test\\.ts$/,",
        "};",
      ].join("\n"),
    );
    const check = run("--config", "census.config.ts", "--export", "census");
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /within baseline/);

    const missing = run("--config", "census.config.ts");
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /no export named "default"/);
  });

  it("--json emits the census without a verdict", () => {
    const { code, stdout } = run("--json");
    assert.equal(code, 0);
    const parsed: unknown = JSON.parse(stdout);
    assert.ok(typeof parsed === "object" && parsed !== null && "counts" in parsed);
  });
});
