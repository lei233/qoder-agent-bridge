import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "tsdown";

const root = resolve(import.meta.dirname, "..");
process.chdir(root);
const temporaryRoot = await mkdtemp(join(tmpdir(), "qoder-agent-skill-build-"));
const artifacts = [
  {
    name: "run_qoder",
    entry: "packages/cli/src/run-qoder.ts",
    committed: "skill/qoder-agent/scripts/run_qoder.mjs",
  },
  {
    name: "qoder_worktree",
    entry: "packages/cli/src/qoder-worktree.ts",
    committed: "skill/qoder-agent/scripts/qoder_worktree.mjs",
  },
  {
    name: "qoder_agent_task",
    entry: "packages/cli/src/qoder-agent-task.ts",
    committed: "skill/qoder-agent/scripts/qoder_agent_task.mjs",
  },
];

try {
  for (const artifact of artifacts) {
    const outDir = join(temporaryRoot, artifact.name);
    await build({
      config: false,
      entry: { [artifact.name]: artifact.entry },
      outDir,
      outExtensions: () => ({ js: ".mjs" }),
      format: ["esm"],
      dts: false,
      sourcemap: false,
      treeshake: false,
      clean: true,
      report: false,
      logLevel: "silent",
      deps: {
        alwaysBundle: ["@qoder-agent-bridge/core"],
      },
    });

    const generated = await readFile(join(outDir, `${artifact.name}.mjs`));
    const committed = await readFile(resolve(root, artifact.committed));
    if (!generated.equals(committed)) {
      throw new Error(
        `${artifact.committed} is stale. Run pnpm skill:build and commit the regenerated artifact.`,
      );
    }
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
