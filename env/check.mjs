import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envFileViolations, missingExampleViolations } from "./files.mjs";
import { namingViolations } from "./naming.mjs";
import { listFiles, scanReferences } from "./scan.mjs";

export { suggest } from "./naming.mjs";

function loadSettings(dir) {
  const path = join(dir, ".eden-lint.json");

  const env = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")).env
    : undefined;

  return { allow: env?.allow ?? {}, ignorePaths: env?.ignorePaths ?? [] };
}

/** Runs the naming, env-file, and example-coverage checks on a project directory. */
export function checkEnv(dir) {
  const { allow, ignorePaths } = loadSettings(dir);

  const files = listFiles(dir).filter(
    (file) => !ignorePaths.some((prefix) => file.startsWith(prefix)),
  );

  const references = scanReferences(dir, files);

  const violations = [
    ...envFileViolations(files),
    ...namingViolations(references),
    ...missingExampleViolations(references, files),
  ];

  return violations.filter((violation) => !(violation.name in allow));
}

export function runEnvCheck(dir) {
  const violations = checkEnv(dir);

  for (const v of violations)
    console.log(`${v.file}:${v.line}: [${v.rule}] ${v.message}`);

  if (violations.length === 0) return 0;

  console.log(
    `\n${violations.length} env violation(s). Fix them, or list the name with a reason under env.allow in .eden-lint.json.`,
  );

  return 1;
}
