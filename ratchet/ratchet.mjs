import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = ["oxlint", "biome"];

/**
 * Count findings per Oxlint rule code and Biome category. Warnings and
 * errors both count; `errorDiagnostics` totals every error-level finding.
 */
export function countByRule(oxlintJson, biomeJson) {
  const counts = { oxlint: {}, biome: {}, errorDiagnostics: 0 };

  for (const diagnostic of oxlintJson?.diagnostics ?? []) {
    const code = diagnostic.code ?? "parse-error";
    counts.oxlint[code] = (counts.oxlint[code] ?? 0) + 1;

    if (diagnostic.severity === "error") counts.errorDiagnostics += 1;
  }

  for (const diagnostic of biomeJson?.diagnostics ?? []) {
    const category = diagnostic.category ?? "unknown";
    counts.biome[category] = (counts.biome[category] ?? 0) + 1;

    if (diagnostic.severity === "error") counts.errorDiagnostics += 1;
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

  const failed =
    rows.some((row) => row.over > 0) || counts.errorDiagnostics > 0;

  return { rows, failed };
}

/**
 * Caps to write after `--update`: a rule's new cap is its current count,
 * never above the existing cap. Rules at count 0 keep cap 0 and stay
 * enforced, so `raised` is always empty.
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
      const cap = current === undefined ? count : Math.min(count, current);
      next[tool][rule] = cap;

      if (current !== undefined && cap < current)
        lowered.push({ tool, rule, from: current, to: cap });
    }
  }

  return { caps: next, lowered, raised: [] };
}

function parseArgs(args) {
  const flags = { update: false, config: "lint-ratchet.json" };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--update") flags.update = true;
    else if (arg.startsWith("--config="))
      flags.config = arg.slice("--config=".length);
    else if (arg === "--config") {
      index += 1;

      if (args[index] === undefined) return { error: "--config needs a value" };

      flags.config = args[index];
    } else return { error: `unknown flag: ${arg}` };
  }

  return { flags };
}

function runJson(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });

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

function oxlintJsonFor(cwd, packageRoot) {
  const oxlintBin = join(
    dirname(fileURLToPath(import.meta.resolve("oxlint"))),
    "..",
    "bin",
    "oxlint",
  );

  const baseConfig = join(packageRoot, "oxlint.base.json");
  const projectConfig = join(cwd, ".oxlintrc.json");
  const config = existsSync(projectConfig) ? projectConfig : baseConfig;

  // Oxlint resolves ignorePatterns relative to the config that declares them, so the base patterns are passed as flags.
  const ignores = JSON.parse(
    readFileSync(baseConfig, "utf8"),
  ).ignorePatterns.flatMap((pattern) => ["--ignore-pattern", pattern]);

  return runJson(
    process.execPath,
    [oxlintBin, "-c", config, ...ignores, "--format", "json", "."],
    cwd,
  );
}

function biomeJsonFor(cwd) {
  return runJson(
    join(cwd, "node_modules", ".bin", "biome"),
    ["check", "--reporter=json", "."],
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

function loadCaps(configPath) {
  if (!existsSync(configPath)) {
    console.log(`${configPath} not found; every cap is 0.`);

    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`ratchet: cannot read ${configPath}: ${error.message}`);

    return null;
  }
}

function report(counts, configPath) {
  const caps = loadCaps(configPath);

  if (caps === null) return 1;

  const { rows, failed } = compare(counts, caps);
  printRows(rows);

  if (counts.errorDiagnostics > 0)
    console.log(
      `${counts.errorDiagnostics} error-level diagnostic(s); errors never pass.`,
    );

  return failed ? 1 : 0;
}

function updateConfig(configPath, counts) {
  const caps = loadCaps(configPath);

  if (caps === null) return 1;

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

  const packageRoot =
    ctx.packageRoot ?? join(dirname(fileURLToPath(import.meta.url)), "..");

  const parsed = parseArgs(args);

  if (parsed.error !== undefined) {
    console.error(
      `ratchet: ${parsed.error}\nusage: eden-lint ratchet [--update] [--config lint-ratchet.json]`,
    );

    return 2;
  }

  const configPath = isAbsolute(parsed.flags.config)
    ? parsed.flags.config
    : join(cwd, parsed.flags.config);

  const oxlintJson = oxlintJsonFor(cwd, packageRoot);
  const biomeJson = biomeJsonFor(cwd);

  if (oxlintJson === null || biomeJson === null) return 1;

  const counts = countByRule(oxlintJson, biomeJson);

  if (parsed.flags.update) return updateConfig(configPath, counts);

  return report(counts, configPath);
}
