import type { ExtensionAPI } from "@anthropic/pi-sdk";
import { ChildProcess } from "node:child_process";

async function runGit(pi: ExtensionAPI, args: string[]) {
  const result = await pi.exec("git", args);
  return result;
}
