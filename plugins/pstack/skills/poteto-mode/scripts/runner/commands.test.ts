import { describe, expect, it } from "bun:test";
import { invocationCommand, preflightCommand, type LaneTarget } from "./commands.ts";
import type { RunnerOptions } from "./types.ts";

function options(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    parent: "claude",
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    mode: "read-only",
    promptPath: "/tmp/prompt.md",
    cwd: "/tmp/worktree",
    outputPath: "/tmp/output.md",
    receiptPath: "/tmp/receipt.json",
    timeoutMs: null,
    ...overrides,
  };
}

function target(overrides: Partial<RunnerOptions> = {}): LaneTarget {
  const merged = options(overrides);
  switch (merged.provider) {
    case "claude":
      return { provider: "claude", model: merged.model };
    case "codex":
      return { provider: "codex", model: merged.model };
    case "pi":
      return {
        provider: "pi",
        model: merged.model === "default" ? "auto-deepseek-v4-1-flash" : merged.model,
        defaultProvider: "magpie",
      };
  }
}

describe("preflightCommand", () => {
  it("checks pi authentication and the resolved default model as JSON", () => {
    const spec = preflightCommand(
      target({ provider: "pi", model: "default" })
    );
    expect(spec).toEqual({
      command: "pi",
      args: [
        "auth",
        "check",
        "--provider",
        "magpie",
        "--model",
        "auto-deepseek-v4-1-flash",
        "--json",
      ],
      stdin: "none",
    });
  });
});

describe("invocationCommand", () => {
  it("pins Codex model, effort, sandbox, cwd, and JSONL output", () => {
    const spec = invocationCommand(options(), target());
    expect(spec.command).toBe("codex");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "exec",
      "--model",
      "gpt-6.1-sol",
      "--config",
      'model_reasoning_effort="high"',
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/worktree",
      "--skip-git-repo-check",
      "--ephemeral",
      "--disable",
      "plugins",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "memories",
      "--json",
      "-",
    ]);
    expect(spec.args).not.toContain("danger-full-access");
  });

  it("passes Claude model, effort, permissions, and no-recursion controls", () => {
    const spec = invocationCommand(
      options({
        parent: "codex",
        provider: "claude",
        model: "fable",
        effort: "max",
      }),
      target({ provider: "claude", model: "fable", effort: "max" })
    );
    expect(spec.command).toBe("claude");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "-p",
      "--model",
      "fable",
      "--effort",
      "max",
      "--permission-mode",
      "plan",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      "Read,Grep,Glob,Bash",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--disallowed-tools",
      "Agent,Task,WebSearch,WebFetch,Edit,Write,NotebookEdit",
      "--output-format",
      "json",
    ]);
    expect(spec.args).not.toContain("bypassPermissions");
  });

  it("passes the resolved pi default provider and model with stdin and no bash", () => {
    const spec = invocationCommand(
      options({ provider: "pi", model: "default" }),
      target({ provider: "pi", model: "default" })
    );
    expect(spec.command).toBe("pi");
    expect(spec.stdin).toBe("prompt");
    expect(spec.args).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--provider",
      "magpie",
      "--model",
      "auto-deepseek-v4-1-flash",
      "--thinking",
      "high",
      "--tools",
      "read,grep,find,ls",
    ]);
    expect(spec.args).not.toContain("bash");
    expect(spec.args.join(" ")).not.toContain("Return the marker.");
  });

  it("uses bounded write modes without blanket bypasses", () => {
    const codex = invocationCommand(options({ mode: "isolated-write" }), target({ mode: "isolated-write" }));
    expect(codex.args).toEqual(
      expect.arrayContaining(["--sandbox", "workspace-write"])
    );
    const pi = invocationCommand(
      options({ provider: "pi", model: "default", mode: "isolated-write" }),
      target({ provider: "pi", model: "default", mode: "isolated-write" })
    );
    expect(pi.args).toEqual(
      expect.arrayContaining([
        "--tools",
        "read,grep,find,ls,bash,edit,write",
      ])
    );

    const claude = invocationCommand(
      options({ provider: "claude", model: "fable", mode: "isolated-write" }),
      target({ provider: "claude", model: "fable", mode: "isolated-write" })
    );
    expect(claude.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Write,Edit,Grep,Glob,Bash",
      ])
    );
  });

  it("covers low, medium, and high for every external provider", () => {
    const cases = [
      {
        provider: "claude" as const,
        model: "fable",
        flag: (effort: "low" | "medium" | "high") => ["--effort", effort],
      },
      {
        provider: "codex" as const,
        model: "gpt-6.1-sol",
        flag: (effort: "low" | "medium" | "high") => [
          "--config",
          `model_reasoning_effort="${effort}"`,
        ],
      },
      {
        provider: "pi" as const,
        model: "default",
        flag: (effort: "low" | "medium" | "high") => ["--thinking", effort],
      },
    ];
    for (const { provider, model, flag } of cases) {
      for (const effort of ["low", "medium", "high"] as const) {
        const overrides = { provider, model, effort };
        const spec = invocationCommand(options(overrides), target(overrides));
        expect(spec.args).toEqual(expect.arrayContaining(flag(effort)));
      }
    }
  });
});
