import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("Qoder Skill Task migration", () => {
  it("uses only the task-aware CLI for the normal Skill lifecycle", async () => {
    const skill = await source("skill/qoder-agent/SKILL.md");
    const review = await source("skill/qoder-agent/references/worktree-review.md");
    const protocol = await source("skill/qoder-agent/references/protocol.md");

    expect(skill).toContain("scripts/qoder_agent_task.mjs");
    expect(skill).toContain("qoder_agent_task.mjs start");
    expect(skill).toContain("qoder_agent_task.mjs inspect");
    expect(review).toContain("qoder_agent_task.mjs candidate");
    expect(review).toContain("qoder_agent_task.mjs repair");
    expect(review).toContain("qoder_agent_task.mjs apply");
    expect(protocol).toContain('"resultRef"');

    expect(skill).not.toMatch(/qoder_worktree\.mjs\s+(prepare|diff|reopen|apply)/u);
    expect(skill).not.toMatch(/run_qoder\.mjs\s+\\?\s*--cwd/u);
    expect(review).not.toMatch(/qoder_worktree\.mjs\s+(prepare|inspect|diff|reopen|apply)/u);
    expect(review).not.toMatch(/qoder_agent_task\.mjs\s+recover/u);
  });

  it("uses task-facing workspace disclosure and opaque retry preparation", async () => {
    const skill = await source("skill/qoder-agent/SKILL.md");
    const review = await source("skill/qoder-agent/references/worktree-review.md");
    const delegation = await source("skill/qoder-agent/references/delegation-prompt.md");

    for (const text of [skill, review, delegation]) {
      expect(text).toContain("workspace.cwd");
      expect(text).not.toContain("qoderCwd");
      expect(text).not.toContain("preparedStatePath");
      expect(text).not.toContain("--prepared-state");
    }

    expect(skill).toContain("--strategy continue");
    expect(skill).toContain("--strategy restart");
    expect(review).toContain("preparationId");
    expect(review).toContain("--preparation <preparationId>");
    expect(review).toContain("retryEligibility.current === true");
    expect(review).toContain("No retry is automatic");
  });

  it("keeps Runner mechanics hidden while preserving the pre-MCP blocking wait shim", async () => {
    const skill = await source("skill/qoder-agent/SKILL.md");
    const protocol = await source("skill/qoder-agent/references/protocol.md");

    expect(skill).toContain("--long-task");
    expect(protocol).toContain("--long-task");
    expect(skill).not.toContain("--timeout-ms 3600000");

    expect(skill).toContain("host-tool wait budget");
    expect(skill).toContain("do not perform unrelated work between waits");
    expect(protocol).toContain("pre-MCP compatibility shim");
    expect(protocol).toContain("exec_command.yield_time_ms: 15000");
    expect(protocol).toContain('"yield_time_ms": 200000');
    expect(protocol).toContain("yield_time_ms: 180000");
    expect(protocol).toContain("`yield_time_ms` to `300000`");
    expect(protocol).toContain("`write_stdin` wait to `280000`");
    expect(protocol).toContain("exactly one empty-stdin wait");
    expect(protocol).toContain("Do not issue shorter or higher-frequency waits");

    expect(protocol).not.toContain("taskkill.exe");
    expect(protocol).not.toContain("SIGKILL");
    expect(protocol).not.toContain("process group");
  });

  it("tracks the task-aware standalone Skill artifact in build freshness checks", async () => {
    const config = await source("tsdown.config.ts");
    const buildValidation = await source("scripts/validate_build.mjs");
    const freshness = await source("scripts/check_skill_artifacts.mjs");
    const packageJson = await source("package.json");

    expect(config).toContain('qoder_agent_task: "packages/cli/src/qoder-agent-task.ts"');
    expect(buildValidation).toContain("skill/qoder-agent/scripts/qoder_agent_task.mjs");
    expect(freshness).toContain("skill/qoder-agent/scripts/qoder_agent_task.mjs");
    expect(packageJson).toContain("node --check skill/qoder-agent/scripts/qoder_agent_task.mjs");
  });
});
