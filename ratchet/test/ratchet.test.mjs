import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compare,
  countByRule,
  initConfig,
  loadCaps,
  nextCaps,
  parseArgs,
  updateConfig,
  validateCaps,
} from "../ratchet.mjs";

const oxlintJson = {
  diagnostics: [
    { code: "anti-slop(no-runtime-typeof)", severity: "warning" },
    { code: "anti-slop(no-runtime-typeof)", severity: "error" },
    { code: "oxc/no-accumulating-spread", severity: "error" },
    { message: "Missing initializer", severity: "error" },
  ],
};

const biomeJson = {
  diagnostics: [
    { category: "lint/suspicious/noExplicitAny", severity: "error" },
    {
      category: "lint/complexity/noExcessiveCognitiveComplexity",
      severity: "warning",
    },
  ],
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), "ratchet-"));
}

test("countByRule counts warnings and errors per rule code and category", () => {
  const counts = countByRule(oxlintJson, biomeJson);

  assert.deepEqual(counts.oxlint, {
    "anti-slop(no-runtime-typeof)": 2,
    "oxc/no-accumulating-spread": 1,
    "parse-error": 1,
  });
  assert.deepEqual(counts.biome, {
    "lint/suspicious/noExplicitAny": 1,
    "lint/complexity/noExcessiveCognitiveComplexity": 1,
  });
  assert.equal(counts.errorDiagnostics, 4);
});

test("countByRule counts Biome fatal severity as error-level", () => {
  const counts = countByRule(
    { diagnostics: [] },
    { diagnostics: [{ category: "lint/style/x", severity: "fatal" }] },
  );

  assert.deepEqual(counts.biome, { "lint/style/x": 1 });
  assert.equal(counts.errorDiagnostics, 1);
});

test("countByRule accepts empty reports", () => {
  const counts = countByRule({ diagnostics: [] }, { diagnostics: [] });

  assert.deepEqual(counts, { oxlint: {}, biome: {}, errorDiagnostics: 0 });
});

function counts() {
  return countByRule(oxlintJson, biomeJson);
}

test("compare reports a row per rule with over amounts", () => {
  const { rows } = compare(counts(), {
    oxlint: { "anti-slop(no-runtime-typeof)": 2 },
    biome: { "lint/complexity/noExcessiveCognitiveComplexity": 1 },
  });

  assert.deepEqual(rows, [
    {
      tool: "oxlint",
      rule: "anti-slop(no-runtime-typeof)",
      count: 2,
      cap: 2,
      over: 0,
    },
    {
      tool: "oxlint",
      rule: "oxc/no-accumulating-spread",
      count: 1,
      cap: 0,
      over: 1,
    },
    { tool: "oxlint", rule: "parse-error", count: 1, cap: 0, over: 1 },
    {
      tool: "biome",
      rule: "lint/suspicious/noExplicitAny",
      count: 1,
      cap: 0,
      over: 1,
    },
    {
      tool: "biome",
      rule: "lint/complexity/noExcessiveCognitiveComplexity",
      count: 1,
      cap: 1,
      over: 0,
    },
  ]);
});

test("compare fails when a rule exceeds its cap", () => {
  const { failed } = compare(counts(), {
    oxlint: { "anti-slop(no-runtime-typeof)": 3 },
    biome: {},
  });

  assert.equal(failed, true);
});

test("compare treats unlisted rules and a missing config as cap 0", () => {
  assert.equal(compare(counts(), {}).failed, true);
  assert.equal(compare(counts(), undefined).failed, true);
});

test("compare passes when every count is within its cap", () => {
  const clean = {
    oxlint: { "anti-slop(no-runtime-typeof)": 1 },
    biome: {},
    errorDiagnostics: 0,
  };

  const { rows, failed } = compare(clean, {
    oxlint: { "anti-slop(no-runtime-typeof)": 2 },
    biome: {},
  });

  assert.deepEqual(rows, [
    {
      tool: "oxlint",
      rule: "anti-slop(no-runtime-typeof)",
      count: 1,
      cap: 2,
      over: 0,
    },
  ]);
  assert.equal(failed, false);
});

test("compare fails on error diagnostics even within caps", () => {
  const { failed } = compare(
    { oxlint: { some: 0 }, biome: {}, errorDiagnostics: 1 },
    { oxlint: { some: 5 }, biome: {} },
  );

  assert.equal(failed, true);
});

test("nextCaps lowers caps to current counts", () => {
  const current = {
    oxlint: { a: 1, b: 0 },
    biome: { c: 2 },
    errorDiagnostics: 0,
  };

  const caps = { oxlint: { a: 3, z: 2 }, biome: { c: 2 } };

  const { caps: next, lowered, raised } = nextCaps(current, caps);

  assert.deepEqual(next, { oxlint: { a: 1, b: 0, z: 0 }, biome: { c: 2 } });
  assert.deepEqual(lowered, [
    { tool: "oxlint", rule: "a", from: 3, to: 1 },
    { tool: "oxlint", rule: "z", from: 2, to: 0 },
  ]);
  assert.deepEqual(raised, []);
});

test("nextCaps never raises a cap above its existing value", () => {
  const current = { oxlint: { a: 5 }, biome: {}, errorDiagnostics: 0 };

  const { caps } = nextCaps(current, { oxlint: { a: 2 }, biome: {} });

  assert.equal(caps.oxlint.a, 2);
});

test("nextCaps treats an unlisted rule as cap 0", () => {
  const current = { oxlint: { fresh: 4 }, biome: {}, errorDiagnostics: 0 };

  const { caps, lowered } = nextCaps(current, { oxlint: {}, biome: {} });

  assert.deepEqual(caps, { oxlint: { fresh: 0 }, biome: {} });
  assert.deepEqual(lowered, []);
});

test("nextCaps treats a missing config as all caps 0", () => {
  const current = { oxlint: {}, biome: {}, errorDiagnostics: 0 };

  const { caps } = nextCaps(current, undefined);

  assert.deepEqual(caps, { oxlint: {}, biome: {} });
});

test("parseArgs sets defaults and reads flags", () => {
  assert.deepEqual(parseArgs([]), {
    flags: { init: false, update: false, config: "lint-ratchet.json" },
  });
  assert.equal(parseArgs(["--init"]).flags.init, true);
  assert.equal(parseArgs(["--update"]).flags.update, true);
  assert.equal(parseArgs(["--config=x.json"]).flags.config, "x.json");
  assert.equal(parseArgs(["--config", "x.json"]).flags.config, "x.json");
});

test("parseArgs rejects unknown flags, missing values, and init with update", () => {
  assert.match(parseArgs(["--nope"]).error, /unknown flag: --nope/);
  assert.match(parseArgs(["--config"]).error, /--config needs a value/);
  assert.match(
    parseArgs(["--init", "--update"]).error,
    /--init and --update cannot be combined/,
  );
});

test("validateCaps accepts object sections with non-negative integer caps", () => {
  assert.equal(validateCaps({}, "c.json"), null);
  assert.equal(validateCaps({ oxlint: {}, biome: { a: 0 } }, "c.json"), null);
});

test("validateCaps rejects malformed configs with the offending key", () => {
  assert.match(validateCaps([], "c.json"), /c.json must contain a JSON object/);
  assert.match(
    validateCaps(null, "c.json"),
    /c.json must contain a JSON object/,
  );
  assert.match(
    validateCaps({ oxlint: [] }, "c.json"),
    /oxlint must be an object/,
  );
  assert.match(
    validateCaps({ oxlint: { a: -1 } }, "c.json"),
    /oxlint.a must be a non-negative integer/,
  );
  assert.match(
    validateCaps({ biome: { b: 1.5 } }, "c.json"),
    /biome.b must be a non-negative integer/,
  );
  assert.match(
    validateCaps({ biome: { b: "2" } }, "c.json"),
    /biome.b must be a non-negative integer/,
  );
});

test("loadCaps returns {} when the config is missing", () => {
  assert.deepEqual(loadCaps(join(tempDir(), "none.json")), {});
});

test("loadCaps returns the parsed config or null when it is malformed", () => {
  const configPath = join(tempDir(), "lint-ratchet.json");

  writeFileSync(configPath, JSON.stringify({ oxlint: { a: 2 }, biome: {} }));
  assert.deepEqual(loadCaps(configPath), { oxlint: { a: 2 }, biome: {} });

  writeFileSync(configPath, JSON.stringify({ oxlint: { a: -2 } }));
  assert.equal(loadCaps(configPath), null);
});

test("initConfig writes the current counts as caps when no config exists", () => {
  const configPath = join(tempDir(), "lint-ratchet.json");
  const current = { oxlint: { a: 2 }, biome: { c: 1 }, errorDiagnostics: 0 };

  assert.equal(initConfig(configPath, current), 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    oxlint: { a: 2 },
    biome: { c: 1 },
  });
});

test("initConfig refuses an existing config or error-level diagnostics", () => {
  const cwd = tempDir();
  const existing = join(cwd, "exists.json");
  const fresh = join(cwd, "fresh.json");

  writeFileSync(existing, "{}");

  assert.equal(
    initConfig(existing, { oxlint: {}, biome: {}, errorDiagnostics: 0 }),
    1,
  );
  assert.equal(
    initConfig(fresh, { oxlint: {}, biome: {}, errorDiagnostics: 1 }),
    1,
  );
  assert.equal(existsSync(fresh), false);
});

test("updateConfig returns 1 without writing when error diagnostics exist", () => {
  const configPath = join(tempDir(), "lint-ratchet.json");

  writeFileSync(configPath, JSON.stringify({ oxlint: {}, biome: {} }));

  assert.equal(
    updateConfig(configPath, {
      oxlint: { a: 1 },
      biome: {},
      errorDiagnostics: 2,
    }),
    1,
  );
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    oxlint: {},
    biome: {},
  });
});

test("updateConfig refuses counts above existing caps", () => {
  const configPath = join(tempDir(), "lint-ratchet.json");

  writeFileSync(configPath, JSON.stringify({ oxlint: { a: 1 }, biome: {} }));

  assert.equal(
    updateConfig(configPath, {
      oxlint: { a: 2 },
      biome: {},
      errorDiagnostics: 0,
    }),
    1,
  );
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    oxlint: { a: 1 },
    biome: {},
  });
});

test("updateConfig writes lowered caps", () => {
  const configPath = join(tempDir(), "lint-ratchet.json");

  writeFileSync(configPath, JSON.stringify({ oxlint: { a: 3 }, biome: {} }));

  assert.equal(
    updateConfig(configPath, {
      oxlint: { a: 1 },
      biome: {},
      errorDiagnostics: 0,
    }),
    0,
  );
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
    oxlint: { a: 1 },
    biome: {},
  });
});
