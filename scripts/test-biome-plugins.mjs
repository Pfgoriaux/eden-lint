// Runs each Biome GritQL plugin alone against its fail and pass fixtures.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

  return spawnSync(biome, ["lint", "--config-path", configDir, fixture], {
    cwd: root,
    encoding: "utf8",
  });
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

  const message = readFileSync(join(pluginsDir, plugin), "utf8").match(
    /message\s*=\s*"([^"]{20})/,
  )[1];

  const failing = lint(plugin, fixtureFor("fail", name));
  const passing = lint(plugin, fixtureFor("pass", name));
  const failOk = `${failing.stdout}${failing.stderr}`.includes(message);
  const passOk = passing.status === 0;

  if (!failOk || !passOk) failures += 1;
  console.log(
    `${failOk && passOk ? "ok  " : "FAIL"} ${name}${failOk ? "" : " (fail fixture not reported)"}${passOk ? "" : ` (pass fixture reported)\n${passing.stdout}${passing.stderr}`}`,
  );
}

process.exit(failures === 0 ? 0 : 1);
