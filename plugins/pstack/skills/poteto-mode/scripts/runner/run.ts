import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  invocationCommand,
  preflightCommand,
  type CommandSpec,
  type LaneTarget,
} from "./commands.ts";
import { versionedClaudeAlias } from "./model-aliases.ts";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";
import type {
  Provider,
  ReceiptStatus,
  RunnerOptions,
  RunnerReceipt,
} from "./types.ts";
import { UsageError } from "./types.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
}

type CancellationSignal = "SIGINT" | "SIGTERM";

interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  dispose(): void;
}

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
}

function evidence(value: string): string {
  return value.trim().slice(0, ERROR_EVIDENCE_LIMIT);
}

// A provider's terminal event ends its stream, so malformed output keeps the tail.
function trailingEvidence(value: string): string {
  return value.trim().slice(-ERROR_EVIDENCE_LIMIT);
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function reserve(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

function reserveOutputs(options: RunnerOptions): void {
  if (options.outputPath === options.receiptPath) {
    throw new UsageError("output and receipt paths must differ");
  }
  reserve(options.outputPath);
  try {
    reserve(options.receiptPath);
  } catch (error) {
    removeIfExists(options.outputPath);
    throw error;
  }
}

function writeReceipt(path: string, receipt: RunnerReceipt): void {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installRunCancellation(): RunCancellation {
  let signal: CancellationSignal | null = null;
  let resolveCancellation!: (value: CancellationSignal) => void;
  const promise = new Promise<CancellationSignal>((resolve) => {
    resolveCancellation = resolve;
  });

  const receive = (next: CancellationSignal): void => {
    if (signal === null) {
      signal = next;
      resolveCancellation(next);
    }
  };
  const onInterrupt = (): void => receive("SIGINT");
  const onTerminate = (): void => receive("SIGTERM");
  globalThis.process.on("SIGINT", onInterrupt);
  globalThis.process.on("SIGTERM", onTerminate);

  return {
    promise,
    get signal() {
      return signal;
    },
    dispose() {
      globalThis.process.off("SIGINT", onInterrupt);
      globalThis.process.off("SIGTERM", onTerminate);
    },
  };
}

const CODEX_IDENTITY = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
] as const;

const CLAUDE_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

export function childEnvironment(
  provider: Provider,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result = { ...source };
  const remove = provider === "claude"
    ? CODEX_IDENTITY
    : provider === "codex"
      ? CLAUDE_IDENTITY
      : [...CODEX_IDENTITY, ...CLAUDE_IDENTITY];
  for (const key of remove) delete result[key];
  return result;
}

async function terminate(
  child: Bun.Subprocess,
  signal: CancellationSignal = "SIGTERM"
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill(signal);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exited: boolean;
  try {
    exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
  return true;
}

interface StreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let cancellationRequested = false;

  const result = (async (): Promise<string> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      text += decoder.decode();
      if (!cancellationRequested) throw error;
      return text;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed and its reader released.
      }
    },
  };
}

type ProcessEvent =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly signal: CancellationSignal }
  | { readonly kind: "timed-out" };

async function runProcess(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<ProcessResult> {
  const child = Bun.spawn([executable, ...spec.args], {
    cwd,
    env,
    stdin: spec.stdin === "prompt" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const stdoutCapture = captureStream(child.stdout);
  const stderrCapture = captureStream(child.stderr);
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  const exited = child.exited.then((exitCode): ProcessEvent => ({
    kind: "exited",
    exitCode,
  }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({
    kind: "cancelled",
    signal,
  }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null
    ? null
    : new Promise((resolve) => {
      const arm = (): void => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolve({ kind: "timed-out" });
          return;
        }
        deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      arm();
    });
  try {
    if (spec.stdin === "prompt") {
      const stdin = child.stdin;
      if (stdin === undefined) throw new Error("child stdin pipe was not created");
      stdin.write(prompt);
      stdin.end();
    }

    const completions = [exited, cancelled];
    if (deadline !== null) completions.push(deadline);
    const first = await Promise.race(completions);

    let outcome = first;
    let captured: readonly [string, string] | null = null;
    let signalSent: CancellationSignal | null = null;

    if (first.kind === "exited") {
      const drains: Array<Promise<
        | { readonly kind: "drained"; readonly captured: readonly [string, string] }
        | ProcessEvent
      >> = [
        streams.then((value) => ({ kind: "drained" as const, captured: value })),
        cancelled,
      ];
      if (deadline !== null) drains.push(deadline);
      const drain = await Promise.race(drains);
      if (drain.kind === "drained") {
        captured = drain.captured;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          outcome = { kind: "timed-out" };
        }
      } else {
        outcome = drain;
      }
    }

    const cancelledBy = cancellation.signal;
    const timedOut = cancelledBy === null && outcome.kind === "timed-out";
    if (cancelledBy !== null) {
      if (await terminate(child, cancelledBy)) signalSent = cancelledBy;
    } else if (timedOut) {
      if (await terminate(child)) signalSent = "SIGTERM";
    }
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }

    return {
      exitCode: await child.exited,
      signal: signalSent,
      stdout: captured[0],
      stderr: captured[1],
      timedOut,
      cancelledBy,
    };
  } catch (error) {
    await terminate(child, cancellation.signal ?? "SIGTERM");
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    throw error;
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

function piSettingsPath(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_CODING_AGENT_DIR;
  const directory = configured === undefined || configured === ""
    ? join(homedir(), ".pi", "agent")
    : expandHome(configured);
  return join(directory, "settings.json");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type LaneResolution =
  | { readonly kind: "resolved"; readonly target: LaneTarget }
  | { readonly kind: "unavailable"; readonly evidence: string };

function resolvePiTarget(env: NodeJS.ProcessEnv): LaneResolution {
  let settingsPath: string;
  try {
    settingsPath = piSettingsPath(env);
  } catch (error) {
    return {
      kind: "unavailable",
      evidence: `pi settings path could not be resolved: ${errorReason(error)}`,
    };
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(settingsPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "unavailable",
      evidence: code === "ENOENT"
        ? `pi settings file not found: ${settingsPath}`
        : `pi settings path is unreadable: ${settingsPath}: ${errorReason(error)}`,
    };
  }
  if (!stats.isFile()) {
    return {
      kind: "unavailable",
      evidence: `pi settings path is not a regular file: ${settingsPath}`,
    };
  }

  let contents: string;
  try {
    contents = readFileSync(settingsPath, "utf8");
  } catch (error) {
    return {
      kind: "unavailable",
      evidence: `pi settings file is unreadable: ${settingsPath}: ${errorReason(error)}`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch (error) {
    return {
      kind: "unavailable",
      evidence: `pi settings file is not valid JSON: ${settingsPath}: ${errorReason(error)}`,
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      kind: "unavailable",
      evidence: `pi settings file is not a JSON object: ${settingsPath}`,
    };
  }
  const settings = raw as Record<string, unknown>;
  const provider = settings.defaultProvider;
  const model = settings.defaultModel;
  if (typeof provider !== "string" || provider.length === 0) {
    return {
      kind: "unavailable",
      evidence: `pi settings file ${settingsPath} is missing a string defaultProvider`,
    };
  }
  if (typeof model !== "string" || model.length === 0) {
    return {
      kind: "unavailable",
      evidence: `pi settings file ${settingsPath} is missing a string defaultModel`,
    };
  }
  return {
    kind: "resolved",
    target: { provider: "pi", model, defaultProvider: provider },
  };
}

function resolveLaneTarget(
  options: RunnerOptions,
  env: NodeJS.ProcessEnv
): LaneResolution {
  switch (options.provider) {
    case "claude":
      return { kind: "resolved", target: { provider: "claude", model: options.model } };
    case "codex":
      return { kind: "resolved", target: { provider: "codex", model: options.model } };
    case "pi":
      return resolvePiTarget(env);
  }
}

function preflightPassed(provider: Provider, result: ProcessResult): boolean {
  if (result.exitCode !== 0 || result.timedOut) return false;
  const combined = `${result.stdout}\n${result.stderr}`;
  switch (provider) {
    case "claude": {
      try {
        const value: unknown = JSON.parse(result.stdout);
        return (
          value !== null &&
          typeof value === "object" &&
          (value as { loggedIn?: unknown }).loggedIn === true
        );
      } catch {
        return false;
      }
    }
    case "codex":
      return /logged in/i.test(combined);
    case "pi": {
      try {
        const value: unknown = JSON.parse(result.stdout);
        return (
          value !== null &&
          typeof value === "object" &&
          (value as { status?: unknown }).status === "ready"
        );
      } catch {
        return false;
      }
    }
  }
}

function successfulPreflightEvidence(provider: Provider, model: string): string {
  return provider === "pi"
    ? `authenticated; default model ${model}`
    : "authenticated";
}

function unavailableStatus(value: string): ReceiptStatus {
  if (/not logged in|unauthenticated|authentication|sign in|login required/i.test(value)) {
    return "unauthenticated";
  }
  if (/model.{0,40}(not found|unknown|unavailable|unsupported|not supported|invalid)|invalid.{0,20}model/i.test(value)) {
    return "unavailable-model";
  }
  return "child-failed";
}

// pi auth check reports a machine-readable status and reason instead of prose.
function piPreflightFailureStatus(value: string): ReceiptStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return "unauthenticated";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "unauthenticated";
  }
  const reason = (parsed as { reason?: unknown }).reason;
  return typeof reason === "string" && /provider|model/i.test(reason)
    ? "unavailable-model"
    : "unauthenticated";
}

function preflightFailureStatus(
  provider: Provider,
  value: string
): ReceiptStatus {
  const status = unavailableStatus(value);
  if (status !== "child-failed") return status;
  return provider === "pi"
    ? piPreflightFailureStatus(value)
    : "unauthenticated";
}

function statusExitCode(status: ReceiptStatus): number {
  switch (status) {
    case "complete":
      return 0;
    case "cancelled":
      return 130;
    case "malformed-output":
      return 65;
    case "unavailable-cli":
    case "unavailable-model":
      return 69;
    case "child-failed":
      return 70;
    case "unauthenticated":
      return 77;
    case "timed-out":
      return 124;
  }
}

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): {
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
} {
  if (reportedModelMatches(provider, requested, reported)) {
    return {
      reportedModel: reported,
      modelVerified: true,
      modelEvidence: "provider-report",
    };
  }
  if (provider === "codex" && reported === null) {
    return {
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    };
  }
  return {
    reportedModel: reported,
    modelVerified: false,
    modelEvidence: null,
  };
}

function completeReceipt(
  options: RunnerOptions,
  partial: Omit<RunnerReceipt, "schemaVersion" | "parent" | "provider" | "model" | "effort" | "mode" | "cwd" | "promptPath" | "outputPath">
): RunnerReceipt {
  return {
    schemaVersion: 1,
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    ...partial,
  };
}

function writePiSettingsFailure(
  options: RunnerOptions,
  started: number,
  detail: string
): RunResult {
  const completed = Date.now();
  const receipt = completeReceipt(options, {
    status: "unavailable-model",
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable: null,
    preflight: {
      argv: [],
      status: "not-run",
      evidence: "",
    },
    argv: [],
    exitCode: null,
    signal: null,
    reportedModel: null,
    resolvedModel: null,
    modelVerified: false,
    modelEvidence: null,
    sessionId: null,
    usage: null,
    costUsd: null,
    appliedEffort: null,
    error: {
      message: "pi default model settings are unavailable",
      evidence: detail,
    },
  });
  removeIfExists(options.outputPath);
  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode("unavailable-model"), receipt };
}

export function validateOptions(options: RunnerOptions): void {
  if (options.parent === options.provider) {
    throw new UsageError(
      `provider ${options.provider} is native to parent ${options.parent}; use the parent subagent primitive`
    );
  }
  if (options.model.trim().length === 0) throw new UsageError("model must not be empty");
  if (options.provider === "pi" && options.model !== "default") {
    throw new UsageError("pi model must be the literal default");
  }
  const staleAlias = options.provider === "claude"
    ? versionedClaudeAlias(options.model)
    : null;
  if (staleAlias !== null) {
    throw new UsageError(
      `Claude model ${options.model} is a version pin; normalize it to ${staleAlias} before invoking the runner`
    );
  }
  if (
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new UsageError("timeout must be greater than zero");
  }
  if (!existsSync(options.promptPath) || !statSync(options.promptPath).isFile()) {
    throw new UsageError(`prompt is not a file: ${options.promptPath}`);
  }
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${options.cwd}`);
  }
  if (
    options.promptPath === options.outputPath ||
    options.promptPath === options.receiptPath
  ) {
    throw new UsageError("prompt, output, and receipt paths must be distinct");
  }
}

interface LaneProgress {
  executable: string | null;
  preflight: RunnerReceipt["preflight"];
  argv: readonly string[];
}

async function executeLane(
  options: RunnerOptions,
  cancellation: RunCancellation,
  started: number,
  deadlineAt: number | null,
  invocation: CommandSpec,
  preflight: CommandSpec,
  progress: LaneProgress,
  target: LaneTarget
): Promise<RunResult> {
  const startedAt = new Date(started).toISOString();
  const prompt = readFileSync(options.promptPath, "utf8");
  const env = childEnvironment(options.provider);
  const effectiveModel = target.provider === "pi"
    ? `${target.defaultProvider}/${target.model}`
    : target.model;
  const resolvedModel = target.provider === "pi" ? effectiveModel : null;
  const executable = Bun.which(invocation.command, {
    PATH: env.PATH,
    cwd: options.cwd,
  });
  progress.executable = executable;
  progress.argv = [executable ?? invocation.command, ...invocation.args];

  let preflightState = progress.preflight;
  let receipt: RunnerReceipt;

  const finishWithoutChild = (
    status: "cancelled" | "timed-out",
    phase: string
  ): RunResult => {
    const completed = Date.now();
    const receivedSignal = status === "cancelled" ? cancellation.signal : null;
    const terminalPreflight = preflightState.status === "not-run"
      ? { ...preflightState, status }
      : preflightState;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: terminalPreflight,
      argv: [executable ?? invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      resolvedModel,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      appliedEffort: null,
      error: {
        message: receivedSignal === null
          ? `explicit deadline elapsed ${phase}`
          : `launcher received ${receivedSignal} ${phase}`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  };

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before authentication preflight");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before authentication preflight");
  }

  if (executable === null) {
    const completed = Date.now();
    receipt = completeReceipt(options, {
      status: "unavailable-cli",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: preflightState,
      argv: [invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      resolvedModel,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      appliedEffort: null,
      error: {
        message: `${invocation.command} executable not found`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  const preflightExecutable = executable;
  let preflightResult = await runProcess(
    preflightExecutable,
    preflight,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation
  );
  let rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
  let passed = preflightPassed(options.provider, preflightResult);
  let preflightEvidence = passed
    ? successfulPreflightEvidence(options.provider, effectiveModel)
    : rawPreflightEvidence;

  preflightState = {
    argv: [preflightExecutable, ...preflight.args],
    status: preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : passed
          ? "passed"
          : "failed",
    evidence: preflightEvidence,
  };
  progress.preflight = preflightState;

  if (preflightState.status !== "passed") {
    const completed = Date.now();
    const preflightFailure = preflightFailureStatus(
      options.provider,
      rawPreflightEvidence
    );
    const status: ReceiptStatus = preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightFailure;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: preflightState,
      argv: [executable, ...invocation.args],
      exitCode: preflightResult.exitCode,
      signal: preflightResult.signal,
      reportedModel: null,
      resolvedModel,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      appliedEffort: null,
      error: {
        message: preflightResult.cancelledBy !== null
          ? `launcher received ${preflightResult.cancelledBy} during preflight`
          : preflightResult.timedOut
            ? "authentication preflight timed out"
            : "authentication or model preflight failed",
        evidence: preflightEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before model execution");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before model execution");
  }

  const result = await runProcess(
    executable,
    invocation,
    options.cwd,
    env,
    prompt,
    deadlineAt,
    cancellation
  );
  const completed = Date.now();
  const base = {
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable,
    preflight: preflightState,
    argv: [executable, ...invocation.args],
    exitCode: result.exitCode,
    signal: result.signal,
  } as const;

  if (result.cancelledBy !== null || result.timedOut || result.exitCode !== 0) {
    const rawFailureEvidence = `${result.stderr}\n${result.stdout}`;
    const failureEvidence = evidence(rawFailureEvidence);
    const status: ReceiptStatus = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : unavailableStatus(rawFailureEvidence);
    receipt = completeReceipt(options, {
      ...base,
      status,
      reportedModel: null,
      resolvedModel,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      appliedEffort: null,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : `child exited with status ${result.exitCode}`,
        evidence: failureEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  try {
    const parsed = parseProviderOutput(
      options.provider,
      result.stdout,
      result.stderr,
      effectiveModel
    );
    const proof = modelProof(
      options.provider,
      effectiveModel,
      parsed.reportedModel
    );
    if (!proof.modelVerified && proof.modelEvidence !== "pinned-argv") {
      throw new Error(
        `requested model ${effectiveModel} was not reported by ${options.provider}`
      );
    }
    if (options.provider === "pi" && parsed.appliedEffort !== options.effort) {
      removeIfExists(options.outputPath);
      receipt = completeReceipt(options, {
        ...base,
        status: "unavailable-model",
        ...proof,
        resolvedModel,
        appliedEffort: parsed.appliedEffort,
        sessionId: parsed.sessionId,
        usage: parsed.usage,
        costUsd: parsed.costUsd,
        error: {
          message: `pi applied thinking ${String(parsed.appliedEffort)}, requested ${options.effort}`,
          evidence: "",
        },
      });
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(receipt.status), receipt };
    }
    writeFileSync(options.outputPath, parsed.text, { encoding: "utf8", mode: 0o600 });
    receipt = completeReceipt(options, {
      ...base,
      status: "complete",
      ...proof,
      resolvedModel,
      appliedEffort: parsed.appliedEffort,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    removeIfExists(options.outputPath);
    receipt = completeReceipt(options, {
      ...base,
      status: "malformed-output",
      reportedModel: null,
      resolvedModel,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      appliedEffort: null,
      error: {
        message,
        evidence: trailingEvidence(`${result.stderr}\n${result.stdout}`),
      },
    });
  }

  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(receipt.status), receipt };
}

export async function runLane(
  options: RunnerOptions,
  started: number = Date.now()
): Promise<RunResult> {
  validateOptions(options);
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const cancellation = installRunCancellation();
  try {
    reserveOutputs(options);
    const resolution = resolveLaneTarget(options, process.env);
    if (resolution.kind === "unavailable") {
      return writePiSettingsFailure(options, started, resolution.evidence);
    }
    const target = resolution.target;
    const resolvedModel = target.provider === "pi"
      ? `${target.defaultProvider}/${target.model}`
      : null;
    const invocation = invocationCommand(options, target);
    const preflight = preflightCommand(target);
    const progress: LaneProgress = {
      executable: null,
      preflight: {
        argv: [preflight.command, ...preflight.args],
        status: "not-run",
        evidence: "",
      },
      argv: [invocation.command, ...invocation.args],
    };
    try {
      return await executeLane(
        options,
        cancellation,
        started,
        deadlineAt,
        invocation,
        preflight,
        progress,
        target
      );
    } catch (error) {
      const completed = Date.now();
      const signal = cancellation.signal;
      const status: ReceiptStatus = signal !== null
        ? "cancelled"
        : deadlineAt !== null && completed >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const message = error instanceof Error ? error.message : String(error);
      const terminalPreflight = progress.preflight.status === "not-run" && status !== "child-failed"
        ? { ...progress.preflight, status }
        : progress.preflight;
      const receipt = completeReceipt(options, {
        status,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable: progress.executable,
        preflight: terminalPreflight,
        argv: progress.argv,
        exitCode: null,
        signal: null,
        reportedModel: null,
        resolvedModel,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        appliedEffort: null,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: evidence(message),
        },
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(status), receipt };
    }
  } finally {
    cancellation.dispose();
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
  };
}
