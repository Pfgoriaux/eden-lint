#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEnvCheck } from "../env/check.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const cwd = process.cwd();

const baseOxlintConfig = join(packageRoot, "oxlint.base.json");

// Oxlint resolves ignorePatterns relative to the config that declares them, so the base patterns are passed as flags.
const oxlintIgnores = JSON.parse(
  readFileSync(baseOxlintConfig, "utf8"),
).ignorePatterns.flatMap((pattern) => ["--ignore-pattern", pattern]);

function run(command, args) {
  return spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;
}

function runOxlint(args) {
  const oxlintBin = join(
    dirname(fileURLToPath(import.meta.resolve("oxlint"))),
    "..",
    "bin",
    "oxlint",
  );

  const projectConfig = join(cwd, ".oxlintrc.json");

  const config = existsSync(projectConfig) ? projectConfig : baseOxlintConfig;

  return run(process.execPath, [
    oxlintBin,
    "-c",
    config,
    ...oxlintIgnores,
    ...(args.length > 0 ? args : ["."]),
  ]);
}

function runBiome(args) {
  return run(join(cwd, "node_modules", ".bin", "biome"), [
    "check",
    ...(args.length > 0 ? args : ["."]),
  ]);
}

// Oxlint's spacing autofix and Biome's formatter each change lines the other inspects; two rounds converge.
function runFix() {
  for (let round = 0; round < 2; round += 1) {
    runOxlint(["--fix", "."]);
    runBiome(["--write", "."]);
  }

  return runAll();
}

function runAll() {
  const results = [runBiome([]), runOxlint([]), runEnvCheck(cwd)];

  return Math.max(...results);
}

const commands = {
  check: runAll,
  fix: runFix,
  biome: runBiome,
  oxlint: runOxlint,
  env: (args) => runEnvCheck(args[0] ?? cwd),
};

const [name = "check", ...rest] = process.argv.slice(2);

const command = commands[name];

if (command === undefined) {
  console.error(
    `usage: eden-lint [check|fix|biome|oxlint|env] [args]\nunknown command: ${name}`,
  );
  process.exit(2);
}

process.exit(command(rest));
