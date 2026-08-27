import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const coreSpecifier = 'from "@qoder-agent-bridge/core"';
const packageOutputs = [
  "packages/cli/dist/run-qoder.js",
  "packages/cli/dist/qoder-worktree.js",
  "packages/cli/dist/qoder-agent-task.js",
];

for (const relativePath of packageOutputs) {
  const path = resolve(root, relativePath);
  const source = await readFile(path, "utf8");
  if (!source.includes(coreSpecifier)) {
    throw new Error(`${relativePath} must import core through its package boundary.`);
  }
  if (((await stat(path)).mode & 0o111) === 0) {
    throw new Error(`${relativePath} must be executable.`);
  }
}
