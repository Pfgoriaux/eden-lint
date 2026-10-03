import { readFileSync } from "node:fs";
import { EXAMPLE_FILE, REAL_ENV_FILE } from "./scan.mjs";

const registry = JSON.parse(
  readFileSync(new URL("./registry.json", import.meta.url), "utf8"),
);

const runtimeNames = new Set(registry.providedByRuntime.names);

const runtimePrefixes = registry.providedByRuntime.prefixes;

function providedByRuntime(name) {
  return (
    runtimeNames.has(name) ||
    runtimePrefixes.some((prefix) => name.startsWith(prefix))
  );
}

/** Real env files (`.env`, `.env.production`, ...) that git tracks or does not ignore. */
export function envFileViolations(files) {
  return files
    .filter((file) => REAL_ENV_FILE.test(file) && !EXAMPLE_FILE.test(file))
    .map((file) => ({
      rule: "env-file",
      file,
      line: 1,
      name: "",
      message: `${file} is tracked or not gitignored. Keep local values in a gitignored .env and production values in Coolify.`,
    }));
}

function needsExample(ref, documented) {
  const isRead = ref.role === "read" && ref.kind !== "shell";

  return isRead && !documented.has(ref.name) && !providedByRuntime(ref.name);
}

/** Names read by code or compose interpolation that no example file documents. */
export function missingExampleViolations(references, files) {
  const documented = new Set(
    references.filter((ref) => ref.kind === "example").map((ref) => ref.name),
  );

  const firstRead = new Map();

  for (const ref of references.filter((candidate) =>
    needsExample(candidate, documented),
  )) {
    if (!firstRead.has(ref.name)) firstRead.set(ref.name, ref);
  }

  if (firstRead.size === 0) return [];

  if (!files.some((file) => EXAMPLE_FILE.test(file)))
    return [noExampleFile([...firstRead.keys()])];

  return [...firstRead.values()].map(({ file, line, name }) => ({
    rule: "example",
    file,
    line,
    name,
    message: `${name} is read but missing from .env.example`,
  }));
}

function noExampleFile(names) {
  return {
    rule: "example",
    file: ".env.example",
    line: 1,
    name: "",
    message: `missing. The project reads ${names.length} env var(s): ${names.sort().join(", ")}`,
  };
}
