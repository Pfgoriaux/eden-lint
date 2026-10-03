import { execSync } from "child_process";
import { execFileSync } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";

const result = execSync("git status");
