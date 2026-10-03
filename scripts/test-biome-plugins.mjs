// Runs each Biome GritQL plugin alone against its fail and pass fixtures.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const pluginsDir = join(root, "biome", "plugins");

const biome = join(root, "node_modules", ".bin", "biome");

let failures = 0;

function lint(plugin, fixture) {
  const configDir = mkdtempSync(join(tmpdir(), "eden-lint-biome-"));

  const config = {
    root: true,
    formatter: { enabled: false },
    linter: { rules: { recommended: false } },
    plugins: [join(pluginsDir, plugin)],
  };

  writeFileSync(join(configDir, "biome.json"), JSON.stringify(config));

  return spawnSync(
    biome,
    ["lint", "--max-diagnostics=none", "--config-path", configDir, fixture],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

// Each run loads one plugin, so every plugin diagnostic belongs to the plugin under test.
function pluginDiagnostics(result) {
  return (`${result.stdout}${result.stderr}`.match(/:\d+:\d+ plugin /g) ?? [])
    .length;
}

function fixtureFor(kind, name) {
  const file = readdirSync(join(root, "biome", "tests", kind)).find(
    (f) => f.replace(/\.[^.]+$/, "") === name,
  );

  return join("biome", "tests", kind, file);
}

for (const plugin of readdirSync(pluginsDir).filter((f) =>
  f.endsWith(".grit"),
)) {
  const name = basename(plugin, ".grit");

  const failCount = pluginDiagnostics(lint(plugin, fixtureFor("fail", name)));
  const passing = lint(plugin, fixtureFor("pass", name));
  const passCount = pluginDiagnostics(passing);
  const ok = failCount > 0 && passCount === 0;

  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}: fail fixture ${failCount}, pass fixture ${passCount}`,
  );

  if (passCount > 0) console.log(passing.stdout);
}

process.exit(failures === 0 ? 0 : 1);
