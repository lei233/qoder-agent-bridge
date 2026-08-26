# Qoder Agent Bridge

[English](README.md)

Qoder Agent Bridge 是一个由 Skill 与 CLI 构成的编码 Harness，用来把本机安装的
Qoder CLI 接入主 Agent 工作流。主 Agent 继续负责规划、外部数据授权、独立审阅、
失败后的重试策略和最终验收；Qoder 只执行一个有边界的编码任务。

代码修改任务的主流程已经迁移到 Task-aware 工作流，不再要求 Skill 手工拼接 Runner
和 Worktree 命令：

```text
规划 / 授权
    ↓
start → inspect → run → candidate
                  ↓
              独立审阅
             ↙       ↘
       repair/retry   批准
             ↓         ↓
         candidate    apply
                        或
                     discard
```

## Task 层提供了什么

- 永久的纯 Task Core，统一实现 Invocation、Candidate、workspace lineage 与终态语义。
- 文件持久化的 Embedded Task Host，以及每个 Task mutation 的独占 fail-closed 锁。
- 每个 Invocation 的不可变结果 artifact，以及每个 Candidate 的不可变 patch artifact。
- 一等 Candidate 身份，把“已经审阅的 patch”和“之后实际 apply 的 patch”绑定起来。
- 明确的失败后 retry 策略：继续可信半成品，或在经批准的新 workspace 中干净重启。
- Task-facing Skill 接口，隐藏 Worktree session 路径、reopen/retry-of 机械细节、Runner
  进程细节以及手工 Runner timeout plumbing。

现有 one-shot Runner 与 Worktree Core 仍然负责底层执行与隔离安全；它们被包装复用，
没有被 Task Core 重写。

## 安全与审批模型

Codex 始终是规划、上下文编译、审阅、retry 策略和验收负责人；Qoder 是受边界约束的
执行器。

- Git 代码修改任务只允许 Qoder 在隔离的 Task workspace 中运行，不能直接修改源
  worktree。
- 向 Qoder 这个外部服务发送项目数据前，需要显式的 task-scoped 数据授权。
- 仓库说明和项目文件只能约束实现，不能放宽 Runner 固定安全策略，也不能授权凭证、
  发布或写出 Task workspace。
- Qoder 的完成报告只是证据，不是验收。主 Agent 必须独立检查不可变 Candidate patch
  和相关验证结果。
- 把 Candidate 应用到源 worktree 始终需要独立、明确的用户批准。
- Invocation 失败后永不自动 retry。是否继续半成品由 Skill 策略决定；干净重启需要先
  准备并批准新的替代 workspace。
- 外部副作用无法证明时采用 fail closed。出现保留的 Task lock 时应停止并诊断，不能
  自动 replay。

## 环境要求

- Node.js `>=22.18.0`
- pnpm `9.15.4` 或兼容的 pnpm 9 版本
- 已安装并完成认证的本地 Qoder CLI

请将 `qodercli` 放入 `PATH`，或通过 `QODERCLI_PATH` 配置绝对路径。Windows 上应使用
原生 `qodercli.exe`；Runner 安全边界会拒绝 shell command shim。

## 安装 Skills

项目级安装：

```sh
mkdir -p /path/to/project/.codex/skills
cp -R skill/qoder-agent /path/to/project/.codex/skills/qoder-agent
cp -R skill/qoder-worker /path/to/project/.codex/skills/qoder-worker
```

个人级使用时，把两个目录复制到 `~/.codex/skills/` 或已配置的 Codex Skill 目录。
`qoder-worker` 是兼容别名，会转发到同目录的 `qoder-agent` 工作流。

## Task-aware CLI

Skill 的正常入口是生成后的 standalone 可执行文件：
`skill/qoder-agent/scripts/qoder_agent_task.mjs`。

从 Codex 已授权的宿主目录启动一个隔离 Task：

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs start \
  --cwd /absolute/authorized/project
```

记录返回的 `taskStatePath`，然后读取 Task-facing workspace disclosure：

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs inspect \
  --task /absolute/path/to/task.json
```

正常 Skill 接口只依赖 `workspace.cwd`、`workspace.changedFiles`、
`workspace.includedData` 和 `retryEligibility`；调用方不再需要搬运 Worktree session
路径或 phase。

执行一次已经批准的 bounded delegation brief：

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs run \
  --task /absolute/path/to/task.json \
  --prompt-file /absolute/path/to/delegation-brief.md
```

所有 Task-managed Runner Invocation 都使用同一个 1 小时安全上限。Task CLI 不再提供
长任务模式，也不提供手工 timeout 参数。只有当用户显式说明某个 Invocation 是长任务
时，Codex 才改变终端工具的阻塞等待策略，让同一个 Task CLI 调用持续保持逻辑阻塞，
而不是转成后台轮询工作流。具体等待契约见下文的 `protocol.md`。

Invocation 成功后冻结不可变 Candidate：

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs candidate \
  --task /absolute/path/to/task.json
```

独立审阅并获得单独批准后，只按精确 Candidate ID apply：

```sh
node skill/qoder-agent/scripts/qoder_agent_task.mjs apply \
  --task /absolute/path/to/task.json \
  --candidate <candidate-id>
```

审查修正与失败后 retry 规则见
[skill/qoder-agent/references/worktree-review.md](skill/qoder-agent/references/worktree-review.md)。
Task-level retry 词汇是：

```text
--strategy continue   # 继续经批准、可信的失败半成品
--strategy restart    # 使用已准备并批准的替代 workspace
```

Task 层没有 `recover` 命令。

## 上下文感知委派

主 Agent 会根据有边界的目标、验收标准、相关项目说明、规格/OpenSpec 内容和适用
Skill 中可移植的工程规则，编译自包含的 `Qoder Delegation Brief v1`。Qoder 不需要
安装 Codex Skills，也不应该被要求调用它们。

权威说明：

- [skill/qoder-agent/SKILL.md](skill/qoder-agent/SKILL.md)：协作、审批与整体策略；
- [delegation-prompt.md](skill/qoder-agent/references/delegation-prompt.md)：上下文编译与
  preview fidelity；
- [worktree-review.md](skill/qoder-agent/references/worktree-review.md)：Candidate 审阅、
  repair/retry、apply 与 discard；
- [protocol.md](skill/qoder-agent/references/protocol.md)：Task-facing Runner evidence 与
  pre-MCP command-session 阻塞等待契约。

## 低层兼容与诊断

生成的 `run_qoder.mjs` 与 `qoder_worktree.mjs` 继续保留用于兼容和机械诊断；完整的
`task get` 也是诊断接口。低层 Runner CLI 可以暴露正常 Task CLI 刻意隐藏的 timeout
控制。诊断接口不能用来绕过 Task lock、Candidate identity、显式审批、retry 策略或
fail-closed 结果。

## 开发检查

```sh
pnpm install
pnpm format
pnpm typecheck
pnpm test
pnpm lint
pnpm skill:build
pnpm skill:artifacts:check
pnpm skill:check
pnpm build
pnpm format:check
```

维护源码位于 `packages/core` 和 `packages/cli` 的 TypeScript 文件中。
`pnpm skill:build` 会重新生成并提交到 `skill/qoder-agent/scripts/` 的 standalone
Skill artifact；不要直接编辑这些生成的 `.mjs` 文件。

## 架构停点评估

PR1–PR4 的迁移目标是建立 Task Core、Embedded Host、Task-aware Skill，以及更精简的
Task-facing Skill surface，然后明确停下来评估，而不是直接继续堆 Task Manager。

开始 SQLite Task Manager、daemon 或 MCP 之前，请先阅读
[docs/task-core-migration-evaluation.md](docs/task-core-migration-evaluation.md)。下一阶段真正
需要设计的是 durable operation semantics：request idempotency、expected version、
execution fencing、Runner durable completion、operation journal 与 crash reconciliation，
而不是继续扩大纯 Task Core。

## License

MIT。参见 [LICENSE](LICENSE)。
