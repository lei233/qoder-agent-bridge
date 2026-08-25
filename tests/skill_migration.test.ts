import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("Qoder Skill Task migration", () => {
  it("uses the task-aware CLI as the primary Skill lifecycle", async () => {
    const skill = await source("skill/qoder-agent/SKILL.md");
    const review = await source("skill/qoder-agent/references/worktree-review.md");
    const protocol = await source("skill/qoder-agent/references/protocol.md");

    expect(skill).toContain("scripts/qoder_agent_task.mjs");
    expect(skill).toContain("qoder_agent_task.mjs start");
    expect(skill).toContain("qoder_agent_task.mjs inspect");
    expect(review).toContain("qoder_agent_task.mjs candidate");
    expect(review).toContain("qoder_agent_task.mjs repair");
    expect(review).toContain("qoder_agent_task.mjs apply");
    expect(protocol).toContain("Task-owned immutable Invocation result artifact");
    expect(protocol).toContain('"resultRef"');

    expect(skill).not.toMatch(/qoder_worktree\.mjs\s+(prepare|diff|reopen|apply)/u);
    expect(skill).not.toMatch(/run_qoder\.mjs\s+\\?\s*--cwd/u);
    expect(review).not.toMatch(/qoder_worktree\.mjs\s+(prepare|inspect|diff|reopen|apply)/u);
    expect(review).not.toMatch(/qoder_agent_task\.mjs\s+recover/u);
  });

  it("preserves explicit failed-run strategy and pre-transfer successor disclosure", async () => {
    const skill = await source("skill/qoder-agent/SKILL.md");
    const review = await source("skill/qoder-agent/references/worktree-review.md");

    expect(skill).toContain("retry --worktree current");
    expect(review).toContain("prepare-retry");
    expect(review).toContain("preparedStatePath");
    expect(review).toContain("--prepared-state");
    expect(review).toContain("discard-retry");
    expect(review).toContain("No retry is automatic");
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
