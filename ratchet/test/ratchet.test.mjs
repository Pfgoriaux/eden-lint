import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, countByRule, nextCaps } from "../ratchet.mjs";

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

test("nextCaps sets new rules to their current count", () => {
  const current = { oxlint: {}, biome: { fresh: 4 }, errorDiagnostics: 0 };

  const { caps, lowered } = nextCaps(current, {});

  assert.deepEqual(caps, { oxlint: {}, biome: { fresh: 4 } });
  assert.deepEqual(lowered, []);
});

test("nextCaps treats a missing config as all caps 0", () => {
  const current = { oxlint: {}, biome: {}, errorDiagnostics: 0 };

  const { caps } = nextCaps(current, undefined);

  assert.deepEqual(caps, { oxlint: {}, biome: {} });
});
