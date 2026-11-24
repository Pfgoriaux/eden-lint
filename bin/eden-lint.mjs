#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { runEnvCheck } from "../env/check.mjs";
import { runLedger } from "../ledger/ledger.mjs";
import {
  biomeBinPath,
  oxlintBinPath,
  oxlintConfigFor,
  oxlintIgnoreFlags,
} from "../lib/tools.mjs";
import { runRatchet } from "../ratchet/ratchet.mjs";

const cwd = process.cwd();

function run(command, args) {
  return spawnSync(command, args, { cwd, stdio: "inherit" }).status ?? 1;
}

function runOxlint(args) {
  return run(process.execPath, [
    oxlintBinPath(),
    "-c",
    oxlintConfigFor(cwd),
    ...oxlintIgnoreFlags(),
    ...(args.length > 0 ? args : ["."]),
  ]);
}

function runBiome(args) {
  return run(biomeBinPath(cwd), ["check", ...(args.length > 0 ? args : ["."])]);
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
  ratchet: (args) => runRatchet(args, { cwd }),
  ledger: (args) => runLedger(args, { cwd }),
};

const [name = "check", ...rest] = process.argv.slice(2);

const command = commands[name];

if (command === undefined) {
  console.error(
    `usage: eden-lint [check|fix|biome|oxlint|env|ratchet|ledger] [args]\nunknown command: ${name}`,
  );
  process.exit(2);
}

process.exit(command(rest));
