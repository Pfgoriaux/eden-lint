// Top-level imports are fine.
import { useState } from "react";
import fs from "fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Bar } from "./types";

const mod = await import("./module");
const pkg = require("top-level-pkg");

// Dynamic imports and inline types inside vi.mock factories are allowed.
vi.mock("./blobs", async () => {
  const { createMock } = await import("../tests/utils/mocks");
  return createMock<typeof import("./blobs")>({
    deleteBlob: async () => {},
  });
});
