import { readFileSync } from "node:fs";

const registry = JSON.parse(
  readFileSync(new URL("./registry.json", import.meta.url), "utf8"),
);

const bannedByLength = Object.keys(registry.banned).sort(
  (a, b) => b.length - a.length,
);

const alwaysAllowed = new Set(registry.alwaysAllowed);

/** Returns the canonical replacement for a banned name, or undefined when the name is fine. */
export function suggest(name) {
  if (alwaysAllowed.has(name)) return undefined;

  const banned = bannedByLength.find(
    (key) => name === key || name.endsWith(`_${key}`),
  );

  if (banned === undefined) return undefined;

  return name.slice(0, name.length - banned.length) + registry.banned[banned];
}

/** One violation per file, line, and banned name. */
export function namingViolations(references) {
  const byLocation = new Map();

  for (const { file, line, name } of references) {
    const replacement = suggest(name);

    if (replacement === undefined) continue;
    byLocation.set(`${file}:${line}:${name}`, {
      rule: "naming",
      file,
      line,
      name,
      message: `${name} -> use ${replacement}`,
    });
  }

  return [...byLocation.values()];
}
