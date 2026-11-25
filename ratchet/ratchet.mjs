import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  biomeBinPath,
  oxlintBinPath,
  oxlintConfigFor,
  oxlintIgnoreFlags,
} from "../lib/tools.mjs";

const TOOLS = ["oxlint", "biome"];

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Count findings per Oxlint rule code and Biome category. Warnings and
 * errors both count toward a rule's cap. A diagnostic that carries no rule
 * code, or a Biome `fatal` one, is a parse error: the linter could not read
 * a file, so it never counts as a rule finding and always fails.
 */
export function countByRule(oxlintJson, biomeJson) {
  const counts = { oxlint: {}, biome: {}, parseErrors: 0 };

  for (const diagnostic of oxlintJson?.diagnostics ?? []) {
    if (diagnostic.code === undefined) {
      counts.parseErrors += 1;
      continue;
    }

    counts.oxlint[diagnostic.code] = (counts.oxlint[diagnostic.code] ?? 0) + 1;
  }

  for (const diagnostic of biomeJson?.diagnostics ?? []) {
    if (diagnostic.severity === "fatal" || diagnostic.category === undefined) {
      counts.parseErrors += 1;
      continue;
    }

    counts.biome[diagnostic.category] =
      (counts.biome[diagnostic.category] ?? 0) + 1;
  }

  return counts;
}

/** Compare counts with caps. A rule that is not listed has cap 0. */
export function compare(counts, caps) {
  const safeCaps = caps ?? {};
  const rows = [];

  for (const tool of TOOLS) {
    const toolCounts = counts[tool] ?? {};
    const toolCaps = safeCaps[tool] ?? {};

    const rules = new Set([
      ...Object.keys(toolCounts),
      ...Object.keys(toolCaps),
    ]);

    for (const rule of rules) {
      const count = toolCounts[rule] ?? 0;
      const cap = toolCaps[rule] ?? 0;

      rows.push({ tool, rule, count, cap, over: Math.max(0, count - cap) });
    }
  }

  const failed = rows.some((row) => row.over > 0) || counts.parseErrors > 0;

  return { rows, failed };
}

/**
 * Caps to write after `--update`: a rule's new cap is its current count,
 * never above the existing one. A rule that is not listed gets cap 0, so
 * `--update` can only lower a cap; new caps come from `--init`.
 */
export function nextCaps(counts, caps) {
  const safeCaps = caps ?? {};
  const next = { oxlint: {}, biome: {} };
  const lowered = [];

  for (const tool of TOOLS) {
    const toolCounts = counts[tool] ?? {};
    const toolCaps = safeCaps[tool] ?? {};

    const rules = new Set([
      ...Object.keys(toolCounts),
      ...Object.keys(toolCaps),
    ]);

    for (const rule of rules) {
      const count = toolCounts[rule] ?? 0;
      const current = toolCaps[rule];
      const cap = Math.min(count, current ?? 0);
      next[tool][rule] = cap;

      if (current !== undefined && cap < current)
        lowered.push({ tool, rule, from: current, to: cap });
    }
  }

  return { caps: next, lowered, raised: [] };
}

function isPlainObject(value) {
  return value?.constructor === Object;
}

/** Return an error message for a malformed caps file, or null when valid. */
export function validateCaps(caps, configPath) {
  if (!isPlainObject(caps)) return `${configPath} must contain a JSON object`;

  for (const tool of TOOLS) {
    const section = caps[tool];

    if (section === undefined) continue;

    if (!isPlainObject(section))
      return `${configPath}: ${tool} must be an object`;

    for (const [rule, cap] of Object.entries(section)) {
      if (!Number.isInteger(cap) || cap < 0)
        return `${configPath}: ${tool}.${rule} must be a non-negative integer`;
    }
  }

  return null;
}

export function parseArgs(args) {
  const flags = { init: false, update: false, config: "lint-ratchet.json" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--init") flags.init = true;
    else if (arg === "--update") flags.update = true;
    else if (arg.startsWith("--config="))
      flags.config = arg.slice("--config=".length);
    else if (arg === "--config") {
      index += 1;

      if (args[index] === undefined) return { error: "--config needs a value" };

      flags.config = args[index];
    } else return { error: `unknown flag: ${arg}` };
  }

  if (flags.init && flags.update)
    return { error: "--init and --update cannot be combined" };

  return { flags };
}

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });

  if (result.error?.code === "ENOBUFS") {
    console.error(
      `ratchet: ${command} produced more than ${MAX_BUFFER / 1024 / 1024} MiB of output.`,
    );

    return null;
  }

  if (result.error) {
    console.error(`ratchet: cannot run ${command}: ${result.error.message}`);

    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error(
      `ratchet: ${command} did not print JSON (exit ${result.status}).`,
    );

    return null;
  }
}

function oxlintJsonFor(cwd) {
  return runJson(
    process.execPath,
    [
      oxlintBinPath(),
      "-c",
      oxlintConfigFor(cwd),
      ...oxlintIgnoreFlags(),
      "--format",
      "json",
      ".",
    ],
    cwd,
  );
}

function biomeJsonFor(cwd) {
  return runJson(
    biomeBinPath(cwd),
    ["check", "--reporter=json", "--max-diagnostics=none", "."],
    cwd,
  );
}

function printRows(rows) {
  if (rows.length === 0) {
    console.log("ratchet: no rules to compare (no findings, no caps).");

    return;
  }

  const ruleWidth = Math.max(...rows.map((row) => row.rule.length));

  for (const row of rows) {
    const status = row.over > 0 ? `over by ${row.over}` : "ok";

    console.log(
      `${row.tool.padEnd(7)}${row.rule.padEnd(ruleWidth)}  ${String(row.count).padStart(5)}  ${String(row.cap).padStart(5)}  ${status}`,
    );
  }
}

export function loadCaps(configPath) {
  if (!existsSync(configPath)) {
    console.log(`${configPath} not found; every cap is 0.`);

    return {};
  }

  let caps;

  try {
    caps = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`ratchet: cannot read ${configPath}: ${error.message}`);

    return null;
  }

  const problem = validateCaps(caps, configPath);

  if (problem !== null) {
    console.error(`ratchet: ${problem}`);

    return null;
  }

  return caps;
}

function report(counts, configPath) {
  const caps = loadCaps(configPath);

  if (caps === null) return 1;

  const { rows, failed } = compare(counts, caps);
  printRows(rows);

  if (counts.parseErrors > 0)
    console.log(
      `${counts.parseErrors} parse error(s); the linter could not read a file.`,
    );

  return failed ? 1 : 0;
}

/** Write the current counts as caps, only for a config that does not exist yet. */
export function initConfig(configPath, counts) {
  if (existsSync(configPath)) {
    console.error(
      `ratchet: ${configPath} already exists; --init only writes a missing file. Use --update to lower caps.`,
    );

    return 1;
  }

  if (counts.parseErrors > 0) {
    console.error(
      `ratchet: ${counts.parseErrors} parse error(s); fix them before --init.`,
    );

    return 1;
  }

  const caps = { oxlint: counts.oxlint ?? {}, biome: counts.biome ?? {} };

  writeFileSync(configPath, `${JSON.stringify(caps, null, 2)}\n`);
  console.log(`ratchet: wrote ${configPath} with the current counts as caps.`);

  return 0;
}

export function updateConfig(configPath, counts) {
  const caps = loadCaps(configPath);

  if (caps === null) return 1;

  if (counts.parseErrors > 0) {
    console.error(
      `ratchet: ${counts.parseErrors} parse error(s); fix them instead of writing caps.`,
    );

    return 1;
  }

  const { rows } = compare(counts, caps);
  const over = rows.filter((row) => row.over > 0);

  if (over.length > 0) {
    printRows(over);
    console.error(
      "ratchet: current counts exceed existing caps; fix the regression instead of raising caps.",
    );

    return 1;
  }

  const { caps: next, lowered } = nextCaps(counts, caps);
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);

  for (const change of lowered)
    console.log(
      `ratchet: lowered ${change.tool} ${change.rule}: ${change.from} -> ${change.to}`,
    );

  console.log(
    `ratchet: wrote ${configPath} (${lowered.length} lowered, 0 raised).`,
  );

  return 0;
}

/** Run `eden-lint ratchet`. Returns the process exit code. */
export function runRatchet(args, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();

  const parsed = parseArgs(args);

  if (parsed.error !== undefined) {
    console.error(
      `ratchet: ${parsed.error}\nusage: eden-lint ratchet [--init] [--update] [--config lint-ratchet.json]`,
    );

    return 2;
  }

  const configPath = isAbsolute(parsed.flags.config)
    ? parsed.flags.config
    : join(cwd, parsed.flags.config);

  const reports = [
    ["oxlint", oxlintJsonFor(cwd)],
    ["biome", biomeJsonFor(cwd)],
  ];

  for (const [tool, json] of reports) {
    if (json === null) return 1;

    if (!Array.isArray(json?.diagnostics)) {
      console.error(`ratchet: ${tool} did not print a diagnostics array`);

      return 1;
    }
  }

  const counts = countByRule(reports[0][1], reports[1][1]);

  if (parsed.flags.init) return initConfig(configPath, counts);

  if (parsed.flags.update) return updateConfig(configPath, counts);

  return report(counts, configPath);
}
