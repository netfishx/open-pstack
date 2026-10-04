import { describe, expect, it } from "bun:test";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";

describe("parseProviderOutput", () => {
  it("extracts Claude text, model, usage, cost, and session", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        session_id: "claude-session",
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.05,
        modelUsage: { "claude-fable-9-9": { inputTokens: 10 } },
      }),
      "",
      "fable"
    );
    expect(parsed).toMatchObject({
      text: "CLAUDE_OK",
      reportedModel: "claude-fable-9-9",
      sessionId: "claude-session",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.05,
      appliedEffort: null,
    });
  });

  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = parseProviderOutput(
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "CODEX_OK" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join("\n"),
      "model: gpt-6.1-sol\nreasoning effort: high\n",
      "gpt-6.1-sol"
    );
    expect(parsed).toMatchObject({
      text: "CODEX_OK",
      reportedModel: null,
      sessionId: "codex-session",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
      },
      appliedEffort: null,
    });
  });

  it("drops pi thinking blocks and keeps the resolved model, usage, cost, and applied effort", () => {
    const parsed = parseProviderOutput(
      "pi",
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "pi-session",
          cwd: "/tmp/worktree",
        }),
        JSON.stringify({
          type: "message_end",
          message: { role: "user", content: "Return the marker." },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "magpie",
            model: "auto-deepseek-v4-1-flash",
            content: [
              { type: "thinking", thinking: "internal reasoning" },
              { type: "text", text: "PI_OK" },
            ],
            stopReason: "stop",
            thinkingLevel: "xhigh",
            usage: {
              input: 30,
              output: 7,
              cacheRead: 6,
              cacheWrite: 1,
              reasoning: 3,
              totalTokens: 44,
              cost: { total: 0.02 },
            },
          },
        }),
      ].join("\n"),
      "",
      "magpie/auto-deepseek-v4-1-flash"
    );
    expect(parsed).toMatchObject({
      text: "PI_OK",
      reportedModel: "magpie/auto-deepseek-v4-1-flash",
      sessionId: "pi-session",
      usage: {
        inputTokens: 30,
        outputTokens: 7,
        cachedInputTokens: 6,
        cacheCreationInputTokens: 1,
        reasoningTokens: 3,
        totalTokens: 44,
      },
      costUsd: 0.02,
      appliedEffort: "xhigh",
    });
    expect(reportedModelMatches(
      "pi",
      "magpie/auto-deepseek-v4-1-flash",
      parsed.reportedModel
    )).toBe(true);
  });

  it("selects the last assistant message_end and rejects non-stop or non-JSON streams", () => {
    const stopped = [
      JSON.stringify({ type: "session", id: "pi-session" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "magpie",
          model: "m",
          content: [{ type: "text", text: "first" }],
          stopReason: "stop",
          thinkingLevel: "low",
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "magpie",
          model: "m",
          content: [{ type: "text", text: "last" }],
          stopReason: "stop",
          thinkingLevel: "high",
        },
      }),
    ].join("\n");
    expect(parseProviderOutput("pi", stopped, "", "magpie/m").text).toBe("last");

    const nonStop = [
      JSON.stringify({ type: "session", id: "pi-session" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "magpie",
          model: "m",
          content: [{ type: "text", text: "partial" }],
          stopReason: "error",
        },
      }),
    ].join("\n");
    expect(() => parseProviderOutput("pi", nonStop, "", "magpie/m")).toThrow();

    expect(() =>
      parseProviderOutput("pi", "not-json", "", "magpie/m")
    ).toThrow("pi emitted a non-JSON event");
  });

  it("selects the requested Claude model when usage includes a side model", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        modelUsage: {
          "claude-haiku-4-5-20251001": {},
          "claude-fable-9-9": {},
        },
      }),
      "",
      "fable"
    );
    expect(parsed.reportedModel).toBe("claude-fable-9-9");
  });

  it("matches only concrete Claude revisions from the requested rolling family", () => {
    expect(reportedModelMatches("claude", "fable", "claude-fable-9-9")).toBe(true);
    expect(reportedModelMatches("claude", "opus", "claude-opus-9")).toBe(true);
    expect(reportedModelMatches("claude", "fable", "claude-opus-9")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "claude-fable-beta")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "fable")).toBe(false);
    expect(reportedModelMatches("claude", "fable", "fable-preview")).toBe(false);
    expect(reportedModelMatches("pi", "magpie/m", "magpie/m")).toBe(true);
    expect(reportedModelMatches("pi", "magpie/m", "magpie/m-build")).toBe(false);
    expect(reportedModelMatches("pi", "fable", "claude-fable-9-9")).toBe(false);
  });

  it("rejects malformed or textless responses", () => {
    expect(() =>
      parseProviderOutput("claude", "not-json", "", "fable")
    ).toThrow("valid JSON");
    expect(() =>
      parseProviderOutput(
        "codex",
        JSON.stringify({ type: "turn.completed" }),
        "",
        "gpt-6.1-sol"
      )
    ).toThrow("final agent message");
  });
});
