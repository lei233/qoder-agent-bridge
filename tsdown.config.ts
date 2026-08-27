import { defineConfig } from "tsdown";

const outputExtensions = () => ({ js: ".js", dts: ".d.ts" });

export default defineConfig([
  {
    entry: "packages/core/src/index.ts",
    outDir: "packages/core/dist",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: false,
    clean: true,
  },
  {
    entry: {
      "run-qoder": "packages/cli/src/run-qoder.ts",
      "qoder-worktree": "packages/cli/src/qoder-worktree.ts",
      "qoder-agent-task": "packages/cli/src/qoder-agent-task.ts",
    },
    outDir: "packages/cli/dist",
    outExtensions: outputExtensions,
    format: ["esm"],
    dts: true,
    sourcemap: true,
    treeshake: false,
    clean: true,
    deps: {
      neverBundle: ["@qoder-agent-bridge/core"],
    },
  },
]);
