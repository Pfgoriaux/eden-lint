import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const baseOxlintConfig = join(packageRoot, "oxlint.base.json");

/** Absolute path to the vendored oxlint binary. */
export function oxlintBinPath() {
  return join(
    dirname(fileURLToPath(import.meta.resolve("oxlint"))),
    "..",
    "bin",
    "oxlint",
  );
}

/** The project `.oxlintrc.json` when present, otherwise the base config. */
export function oxlintConfigFor(cwd) {
  const projectConfig = join(cwd, ".oxlintrc.json");

  return existsSync(projectConfig) ? projectConfig : baseOxlintConfig;
}

/** Oxlint resolves ignorePatterns relative to the config that declares them, so the base patterns are passed as flags. */
export function oxlintIgnoreFlags() {
  return JSON.parse(
    readFileSync(baseOxlintConfig, "utf8"),
  ).ignorePatterns.flatMap((pattern) => ["--ignore-pattern", pattern]);
}

/** Absolute path to the project's biome binary. */
export function biomeBinPath(cwd) {
  return join(cwd, "node_modules", ".bin", "biome");
}
