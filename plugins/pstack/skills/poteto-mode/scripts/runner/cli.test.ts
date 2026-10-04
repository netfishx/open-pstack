import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseArgs } from "./cli.ts";

function argv(
  values: { provider?: string; model?: string } = {},
  extra: readonly string[] = []
): string[] {
  return [
    "--parent",
    "claude",
    "--provider",
    values.provider ?? "codex",
    "--model",
    values.model ?? "gpt-6.1-sol",
    "--effort",
    "high",
    "--mode",
    "read-only",
    "--prompt",
    join(process.cwd(), "prompt.md"),
    "--cwd",
    process.cwd(),
    "--output",
    join(process.cwd(), "output.md"),
    "--receipt",
    join(process.cwd(), "receipt.json"),
    ...extra,
  ];
}

describe("runner CLI parsing", () => {
  it("does not invent a timeout", () => {
    expect(parseArgs(argv())?.timeoutMs).toBeNull();
  });

  it("honors an explicit positive timeout", () => {
    expect(parseArgs(argv({}, ["--timeout", "5400"]))?.timeoutMs).toBe(5_400_000);
  });

  it("rejects a non-positive timeout", () => {
    expect(() => parseArgs(argv({}, ["--timeout", "0"]))).toThrow(
      "greater than zero"
    );
  });

  it("accepts the pi provider with the literal default model", () => {
    const parsed = parseArgs(argv({ provider: "pi", model: "default" }));
    expect(parsed?.provider).toBe("pi");
    expect(parsed?.model).toBe("default");
  });
});
