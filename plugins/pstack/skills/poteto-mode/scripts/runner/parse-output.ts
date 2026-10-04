import type {
  NormalizedUsage,
  ParsedOutput,
  Provider,
} from "./types.ts";
import {
  concreteModelMatchesRollingAlias,
  isRollingClaudeAlias,
} from "./model-aliases.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedUsage(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finiteNumber(usage.input_tokens),
    cachedInputTokens: finiteNumber(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheCreationInputTokens: finiteNumber(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens
    ),
    outputTokens: finiteNumber(usage.output_tokens),
    reasoningTokens: finiteNumber(
      usage.reasoning_tokens ?? usage.reasoning_output_tokens
    ),
    totalTokens: finiteNumber(usage.total_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined)
    ? result
    : null;
}

function modelFromUsage(
  value: unknown,
  provider: Provider,
  requestedModel: string
): string | null {
  const usage = object(value);
  if (usage === null) return null;
  const models = Object.keys(usage);
  return models.find((model) =>
    reportedModelMatches(provider, requestedModel, model)
  )
    ?? models[0]
    ?? null;
}

function parseClaude(stdout: string, requestedModel: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("claude did not emit valid JSON");
  }
  const value = object(raw);
  if (value === null) throw new Error("claude emitted a non-object result");

  const text = nullableString(value.result);
  if (text === null) throw new Error("claude result did not contain final text");
  if (value.is_error === true) throw new Error("claude reported an error result");

  return {
    text,
    reportedModel: modelFromUsage(value.modelUsage, "claude", requestedModel),
    sessionId: nullableString(value.session_id ?? value.sessionId),
    usage: normalizedUsage(value.usage),
    costUsd: finiteNumber(value.total_cost_usd) ?? null,
    appliedEffort: null,
  };
}

function parsePi(stdout: string): ParsedOutput {
  let assistant: JsonObject | null = null;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("pi emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.type === "session") {
      sessionId = nullableString(event.id) ?? sessionId;
    }
    if (event.type === "message_end") {
      const message = object(event.message);
      if (message?.role === "assistant") assistant = message;
    }
  }

  if (assistant === null) {
    throw new Error("pi result did not contain an assistant message_end event");
  }
  if (assistant.stopReason !== "stop") {
    throw new Error(`pi assistant message stopped with ${String(assistant.stopReason)}`);
  }

  const content = Array.isArray(assistant.content) ? assistant.content : [];
  let text = "";
  for (const item of content) {
    const part = object(item);
    if (part?.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }
  if (text.length === 0) throw new Error("pi result did not contain final text");

  const assistantProvider = nullableString(assistant.provider);
  const assistantModel = nullableString(assistant.model);
  const reportedModel = assistantProvider !== null && assistantModel !== null
    ? `${assistantProvider}/${assistantModel}`
    : null;

  const usage = object(assistant.usage);
  const normalizedUsageValue: NormalizedUsage | null = usage === null
    ? null
    : (() => {
      const candidate: NormalizedUsage = {
        inputTokens: finiteNumber(usage.input),
        cachedInputTokens: finiteNumber(usage.cacheRead),
        cacheCreationInputTokens: finiteNumber(usage.cacheWrite),
        outputTokens: finiteNumber(usage.output),
        reasoningTokens: finiteNumber(usage.reasoning),
        totalTokens: finiteNumber(usage.totalTokens),
      };
      return Object.values(candidate).some((entry) => entry !== undefined)
        ? candidate
        : null;
    })();
  const cost = object(usage?.cost);

  return {
    text,
    reportedModel,
    sessionId,
    usage: normalizedUsageValue,
    costUsd: finiteNumber(cost?.total) ?? null,
    appliedEffort: nullableString(assistant.thinkingLevel),
  };
}

function parseCodex(stdout: string): ParsedOutput {
  let text: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("codex emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.type === "thread.started") {
      sessionId = nullableString(event.thread_id) ?? sessionId;
    }
    if (event.type === "item.completed") {
      const item = object(event.item);
      if (item?.type === "agent_message") {
        text = nullableString(item.text) ?? text;
      }
    }
    if (event.type === "turn.completed") {
      usage = normalizedUsage(event.usage) ?? usage;
    }
    if (event.type === "turn.failed") {
      const error = object(event.error);
      throw new Error(nullableString(error?.message) ?? "codex reported a failed turn");
    }
  }

  if (text === null) throw new Error("codex result did not contain a final agent message");
  return {
    text,
    reportedModel: null,
    sessionId,
    usage,
    costUsd: null,
    appliedEffort: null,
  };
}

export function parseProviderOutput(
  provider: Provider,
  stdout: string,
  stderr: string,
  requestedModel: string
): ParsedOutput {
  switch (provider) {
    case "claude":
      return parseClaude(stdout, requestedModel);
    case "codex":
      return parseCodex(stdout);
    case "pi":
      return parsePi(stdout);
  }
}

export function reportedModelMatches(
  provider: Provider,
  requested: string,
  reported: string | null
): boolean {
  if (reported === null) return false;
  if (provider === "pi") return reported === requested;
  if (provider === "claude" && isRollingClaudeAlias(requested)) {
    return concreteModelMatchesRollingAlias(requested, reported);
  }
  if (reported === requested || reported.startsWith(`${requested}-`)) {
    return true;
  }
  return false;
}
