/**
 * lifeos-hooks-bridge.ts (v2) — runs LifeOS Claude-Code hooks inside omp (Oh My Pi).
 *
 * v1 (PR danielmiessler/LifeOS#1945 — closed): shimmed the Claude Code hook
 * contract onto the omp event bus, but ran hooks with placeholder session ids
 * (`"omp"` / `"unknown"`), an empty transcript_path, and Stop hooks on
 * `turn_end` (notification-only, no block/continue contract).
 *
 * v2 fixes, using omp's native extension API (omp ≥ 18):
 *   - real session ids: `ctx.sessionManager.getSessionId()` (no placeholders)
 *   - real transcript_path: `ctx.sessionManager.getSessionFile()` / event fields
 *   - Stop hooks moved to `session_stop`, which carries the real CC Stop
 *     contract: `stop_hook_active`, `session_id`, `session_file`, and maps
 *     hook block decisions to omp continuations (`{ decision: "block", reason }`)
 *   - UserPromptSubmit wired to the `input` event: real prompt text, CC deny
 *     semantics (prompt not processed), with `turn_start` as the print/rpc
 *     fallback (omp fires `input` in interactive/rpc modes only)
 *   - hook registry re-read from settings.json on every session_start
 *     (edits take effect next session, no omp restart of the bridge logic)
 *   - v1 bug fix: the vision `input` handler was registered inside the
 *     `context` handler, stacking one handler per context injection
 *
 * Claude Code hook contract (unchanged): hooks are `sh -c <command>` with the
 * CC JSON payload on stdin, registry read from ${LIFEOS_DIR}/settings.json.
 * Hooks run in the omp process event bus; failures are logged, never fatal.
 * Per-hook timeout 30s.
 *
 * Config:
 *   - LIFEOS_DIR env overrides the LifeOS config root (default ~/.claude)
 *   - OMP_BRIDGE_LOG overrides the audit log path (default ~/.omp/lifeos-bridge.log)
 *
 * Every invocation is logged to the audit log.
 */

import { appendFileSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Container, Text } from "@oh-my-pi/pi-tui";

const HOME = homedir();
const LIFEOS_DIR = process.env.LIFEOS_DIR ?? join(HOME, ".claude");
const SETTINGS_PATH = join(LIFEOS_DIR, "settings.json");
const LOG_PATH = process.env.OMP_BRIDGE_LOG ?? join(HOME, ".omp", "lifeos-bridge.log");
const PULSE_NOTIFY = "http://127.0.0.1:31337/notify";
const VOICE_ID = process.env.OMP_VOICE_ID ?? "fTtv3eikoepIosk8dTZ5";
const HOOK_TIMEOUT_MS = 30_000;
const OMP_VERSION = (() => {
  try {
    return Bun.spawnSync(["omp", "--version"], { stdout: "pipe" }).stdout.toString().trim().replace(/^omp\//, "");
  } catch {
    return "";
  }
})();
/** ตัวอ่านภาพ: gemma4 (ollama vision) — ตัวหลัก (deepseek-flash) อ่านรูปไม่ได้
 *  เมื่อผู้ใช้ส่งภาพมา ให้ vision model อ่านแล้วแทนที่ด้วยคำบรรยายใน prompt */
const VISION_MODEL = process.env.OMP_VISION_MODEL ?? "gemma4:cloud";

async function describeImage(dataBase64: string): Promise<string> {
  try {
    const res = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: "บรรยายภาพนี้สั้น ๆ ว่าเห็นอะไร (ภาษาไทย 1-3 ประโยค เจาะจงสิ่งที่สำคัญในภาพ)",
        images: [dataBase64],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "response" in body && typeof body.response === "string") {
      return body.response.trim();
    }
    return "";
  } catch (e) {
    return `[อ่านภาพไม่สำเร็จ: ${String(e).slice(0, 100)}]`;
  }
}

interface HookReg {
  event: string;
  matcher: string;
  command: string;
}

interface HookResult {
  ok: boolean;
  out: string;
  err: string;
  ms: number;
}

interface HookOutput {
  decision?: string;
  reason?: string;
  context?: string;
  block?: boolean;
  /** omp-native continuation: hook returned `{ continue: true, additionalContext }`. */
  continueTurn?: boolean;
}

/** omp tool name → Claude Code tool name (known map; unknown pass through). */
const TOOL_UP: Record<string, string> = {
  bash: "Bash", read: "Read", write: "Write", edit: "Edit", glob: "Glob",
  grep: "Grep", task: "Task", todo: "Todo", ask: "AskUserQuestion",
  web_search: "WebSearch", hub: "Hub", eval: "Eval", lsp: "Lsp",
  debug: "Debug", browser: "Browser", inspect_image: "InspectImage",
};

function log(line: Record<string, unknown>): void {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...line }) + "\n");
  } catch { /* never crash on logging */ }
}

/** CC hook commands may contain $HOME / ${HOME}; expand against the real home. */
function expandHome(s: string): string {
  return s.replaceAll("$HOME", HOME).replaceAll("${HOME}", HOME);
}

/** Claude Code matcher: `*` wildcard + `|` alternation (e.g. "Bash|Write|Edit|MultiEdit", "mcp__.*"). */
function matcherToRegex(matcher: string): RegExp {
  if (!matcher || matcher === "*") return /^.*$/;
  const parts = matcher.split("|").map((p) => p.trim()).filter(Boolean);
  const body = parts
    .map((p) => p.split("*").map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*"))
    .join("|");
  return new RegExp(`^(?:${body})$`);
}

function hookName(command: string): string {
  return command.split("/").pop() ?? command;
}

/** Load the hook registry snapshot from ${LIFEOS_DIR}/settings.json. */
function loadRegistry(): HookReg[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || !("hooks" in raw)) return [];
    const hooksMap = raw.hooks;
    if (!hooksMap || typeof hooksMap !== "object") return [];
    const out: HookReg[] = [];
    for (const [ev, entries] of Object.entries(hooksMap)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const matcher = "matcher" in entry && typeof entry.matcher === "string" ? entry.matcher : "*";
        if (!("hooks" in entry) || !Array.isArray(entry.hooks)) continue;
        for (const hk of entry.hooks) {
          if (!hk || typeof hk !== "object") continue;
          if (!("type" in hk) || hk.type !== "command") continue;
          if (!("command" in hk) || typeof hk.command !== "string" || !hk.command) continue;
          out.push({ event: ev, matcher, command: expandHome(hk.command) });
        }
      }
    }
    return out;
  } catch (e) {
    log({ err: "registry_load_failed", detail: String(e) });
    return [];
  }
}

let registry: HookReg[] = loadRegistry();

/** Claude Code `statusLine` hook (display-only in CC). omp has no native slot for
 *  it, so its stdout is rendered as hook-status lines below the omp status line. */
function statusLineCommand(): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    if (!raw || typeof raw !== "object" || !("statusLine" in raw)) return null;
    const sl = raw.statusLine;
    if (!sl || typeof sl !== "object") return null;
    if (!("type" in sl) || sl.type !== "command") return null;
    if (!("command" in sl) || typeof sl.command !== "string" || !sl.command) return null;
    return expandHome(sl.command);
  } catch {
    return null;
  }
}

/** Run one hook: `sh -c <command>` with the CC JSON payload on stdin. */
async function runHook(reg: HookReg, payload: Record<string, unknown>): Promise<HookResult> {
  const t0 = Date.now();
  try {
    const proc = Bun.spawn(["sh", "-c", reg.command], {
      cwd: LIFEOS_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    const outP = new Response(proc.stdout).text();
    const errP = new Response(proc.stderr).text();
    const exited = await Promise.race([proc.exited, Bun.sleep(HOOK_TIMEOUT_MS).then(() => "timeout" as const)]);
    if (exited === "timeout") proc.kill();
    const [out, err] = await Promise.all([outP, errP]);
    return {
      ok: exited !== "timeout",
      out,
      err: exited === "timeout" ? "timeout" : err.slice(0, 300),
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, out: "", err: String(e).slice(0, 300), ms: Date.now() - t0 };
  }
}

/** Parse CC hook stdout → { permissionDecision, reason, additionalContext, block }. */
function parseOutput(raw: string): HookOutput {
  for (const line of raw.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (!parsed || typeof parsed !== "object") continue;
      const maybe = "hookSpecificOutput" in parsed ? parsed.hookSpecificOutput : parsed;
      if (!maybe || typeof maybe !== "object") continue;
      const out = maybe as Record<string, unknown>; // object-checked above; member access below is `in`-guarded
      const context = "additionalContext" in out && typeof out.additionalContext === "string" ? out.additionalContext : undefined;
      let decision = "permissionDecision" in out && typeof out.permissionDecision === "string" ? out.permissionDecision : undefined;
      const reason = "permissionDecisionReason" in out && typeof out.permissionDecisionReason === "string"
        ? out.permissionDecisionReason
        : "reason" in out && typeof out.reason === "string" ? out.reason : undefined;
      let block = "shouldBlockFurtherMessages" in out && out.shouldBlockFurtherMessages === true;
      // CC Stop-hook contract: {"decision":"block","reason":...} or {"continue":false}
      if ("decision" in out && out.decision === "block") block = true;
      if ("continue" in out && out.continue === false) block = true;
      const continueTurn = "continue" in out && out.continue === true;
      // `decision: "block"` is a block, not a permission decision — normalize so
      // Stop-hook blocks aren't mistaken for the PreToolUse deny/ask vocabulary.
      if (decision === "block") { block = true; decision = undefined; }
      return { decision, reason, context, block, continueTurn };
    } catch { /* keep scanning */ }
  }
  return {};
}

interface ToolCallInfo {
  name: string;
  input: unknown;
  toolCallId: string;
}

function readToolCall(v: unknown): ToolCallInfo | null {
  if (!v || typeof v !== "object") return null;
  const name = "toolName" in v ? v.toolName : undefined;
  if (typeof name !== "string") return null;
  return {
    name,
    input: "input" in v ? v.input : undefined,
    toolCallId: "toolCallId" in v && typeof v.toolCallId === "string" ? v.toolCallId : "",
  };
}

interface ToolResultInfo {
  name: string;
  input: unknown;
  toolCallId: string;
  isError: boolean;
  content: string;
}

function readToolResult(v: unknown): ToolResultInfo | null {
  if (!v || typeof v !== "object") return null;
  const name = "tool_name" in v && typeof v.tool_name === "string"
    ? v.tool_name
    : "toolName" in v && typeof v.toolName === "string" ? v.toolName : "";
  const isErr = "isError" in v ? v.isError === true : false;
  const contentRaw = "content" in v ? v.content : undefined;
  let contentText: string;
  if (Array.isArray(contentRaw)) {
    contentText = contentRaw
      .map((c: unknown) => {
        if (c && typeof c === "object" && "text" in c && typeof c.text === "string") return c.text;
        return JSON.stringify(c);
      })
      .join("\n");
  } else if (typeof contentRaw === "string") {
    contentText = contentRaw;
  } else {
    contentText = JSON.stringify(contentRaw ?? "");
  }
  return {
    name,
    input: "input" in v ? v.input : undefined,
    toolCallId: "toolCallId" in v && typeof v.toolCallId === "string" ? v.toolCallId : "",
    isError: isErr,
    content: contentText,
  };
}

/** Session identity surface on the handler context (omp ReadonlySessionManager).
 *  Structurally identical to the omp host interface — named cast, checked by use. */
interface SessionManagerView {
  getSessionId?: () => string | undefined;
  getSessionFile?: () => string | undefined;
}

function sessionManagerOf(ctx: unknown): SessionManagerView | undefined {
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) return undefined;
  const sm: unknown = ctx.sessionManager;
  if (!sm || typeof sm !== "object") return undefined;
  return sm as SessionManagerView;
}

interface CtxWithUI {
  ui?: {
    confirm?: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, level?: string) => void;
    setWidget?: (
      key: string,
      content: unknown,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => void;
  };
}

function readCtxUI(v: unknown): CtxWithUI {
  const out: CtxWithUI = {};
  if (!v || typeof v !== "object" || !("ui" in v)) return out;
  const ui: unknown = v.ui;
  if (!ui || typeof ui !== "object") return out;
  const view: CtxWithUI = { ui: {} };
  if ("confirm" in ui && typeof ui.confirm === "function") view.ui!.confirm = ui.confirm as (title: string, message: string) => Promise<boolean>;
  if ("notify" in ui && typeof ui.notify === "function") view.ui!.notify = ui.notify as (message: string, level?: string) => void;
  if ("setWidget" in ui && typeof ui.setWidget === "function") {
    view.ui!.setWidget = ui.setWidget as CtxWithUI["ui"] extends { setWidget?: infer F } ? F : never;
  }
  return view;
}

let cachedSessionId = "";
let cachedSessionFile = "";

/** Real session id: ctx.sessionManager.getSessionId(), event-provided fallback,
 *  cached value, then env — never a hard placeholder. */
function sessionIdOf(ctx: unknown, fallback?: string): string {
  try {
    const id = sessionManagerOf(ctx)?.getSessionId?.();
    if (typeof id === "string" && id) return id;
  } catch { /* fall through */ }
  if (fallback) return fallback;
  if (cachedSessionId) return cachedSessionId;
  return process.env.OMP_SESSION_ID ?? "omp";
}

/** Real transcript path: event-provided session_file, then
 *  ctx.sessionManager.getSessionFile(), then the cached value. */
function transcriptOf(ctx: unknown, fallback?: string): string {
  if (fallback) return fallback;
  try {
    const f = sessionManagerOf(ctx)?.getSessionFile?.();
    if (typeof f === "string" && f) return f;
  } catch { /* fall through */ }
  return cachedSessionFile ?? "";
}

/** Build the CC-style JSON payload the statusline script expects — real omp
 *  harness/model/context instead of the script's Claude Code defaults. */
function statuslinePayload(ctx: unknown): Record<string, unknown> {
  if (!ctx || typeof ctx !== "object") {
    return { harness: { name: "omp", version: OMP_VERSION }, model: { display_name: "" }, workspace: { current_dir: process.cwd() }, session_id: sessionIdOf(ctx) };
  }
  const modelQuery = "models" in ctx && ctx.models && typeof ctx.models === "object"
    ? (ctx.models as { current?: () => unknown }) // host-owned model facade; optional-call only
    : undefined;
  const model = modelQuery?.current?.() as Record<string, unknown> | undefined;
  const usageFn = "getContextUsage" in ctx && typeof ctx.getContextUsage === "function" ? ctx.getContextUsage : undefined;
  const usage = usageFn?.call(ctx);
  const payload: Record<string, unknown> = {
    harness: { name: "omp", version: OMP_VERSION },
    model: { display_name: model ? String(model.name ?? model.display_name ?? model.displayName ?? model.id ?? "") : "" },
    workspace: { current_dir: process.cwd() },
    session_id: sessionIdOf(ctx),
  };
  if (usage && typeof usage === "object") {
    const tokens = "tokens" in usage && typeof usage.tokens === "number" ? usage.tokens : 0;
    const windowSize = "contextWindow" in usage && typeof usage.contextWindow === "number" ? usage.contextWindow : 0;
    const percent = "percent" in usage && typeof usage.percent === "number" ? usage.percent : 0;
    payload.context_window = {
      context_window_size: windowSize > 0 ? windowSize : 200_000,
      used_percentage: percent,
      total_input_tokens: tokens,
    };
  }
  return payload;
}

/** Managed-timer accessor on the handler context (setInterval/clearTimer). */
function timerApi(ctx: unknown): { setInterval: (fn: () => void, ms: number) => unknown; clearTimer: (h: unknown) => void } | null {
  if (!ctx || typeof ctx !== "object") return null;
  if (!("setInterval" in ctx) || !("clearTimer" in ctx)) return null;
  if (typeof ctx.setInterval !== "function" || typeof ctx.clearTimer !== "function") return null;
  return {
    setInterval: ctx.setInterval.bind(ctx),
    clearTimer: ctx.clearTimer.bind(ctx),
  };
}

/** Render the LifeOS status line (settings.json `statusLine` hook) as a colored
 *  widget below the input editor — the display-only equivalent of Claude Code's
 *  statusLine hook. The script emits 24-bit ANSI, which pi-tui Text preserves;
 *  the hook-status path would strip it (sanitizeStatusText). Refreshed on turn
 *  events and a 60s timer so the banner stays live. Async, best-effort. */
async function showLifeosStatusline(ctx: unknown): Promise<void> {
  const cmd = statusLineCommand();
  if (!cmd) return;
  const ui = readCtxUI(ctx).ui;
  if (!ui?.setWidget) return;
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], {
      cwd: LIFEOS_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, STATUSLINE_MODE: process.env.STATUSLINE_MODE ?? "mini" },
    });
    proc.stdin.write(JSON.stringify(statuslinePayload(ctx)));
    proc.stdin.end();
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const lines = out.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    const banner = new Container();
    for (const line of lines) banner.addChild(new Text(line, 1, 0));
    ui.setWidget("lifeos", () => banner, { placement: "belowEditor" });
  } catch (e) {
    log({ err: "statusline_failed", detail: String(e) });
  }
}

function forEvent(event: string): HookReg[] {
  return registry.filter((r) => r.event === event && r.matcher === "*");
}

function forTool(event: string, ccName: string): HookReg[] {
  return registry.filter((r) => r.event === event && matcherToRegex(r.matcher).test(ccName));
}

function toolCcName(name: string): string {
  return TOOL_UP[name] ?? name;
}

let pendingContext: string[] = [];
let statuslineTimer: unknown = null;
/** Dedupe: omp fires `input` (interactive/rpc, real prompt) AND `turn_start`
 *  (every mode). Run prompt-side hooks once per turn — on the real prompt when
 *  `input` fired, else the turn_start fallback for print mode. */
let inputRanForTurn = false;

/** omp-native voice line: the VoiceCompletion hook needs a Claude transcript,
 *  which omp doesn't have — extract the 🗣️ closer from the message that just
 *  completed the turn instead. */
function extractVoiceLine(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // Accept both `🗣️ <ZEN>:` and `🗣️ ZEN:` — the constitution template's
    // `<DA>` is a placeholder, and TranscriptParser.extractVoiceCompletion
    // accepts both. Angle-bracket-only matching silently dropped every closer
    // written without brackets, so sessions spoke nothing. (2026-08-22)
    const m = lines[i].match(/^🗣️\s*(?:<[^>]{1,32}>|[^:\n]{1,32})\s*:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function assistantMessageText(msg: unknown): string {
  if (!msg || typeof msg !== "object" || !("content" in msg)) return "";
  const content = msg.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: unknown): c is { text?: string } => !!c && typeof c === "object" && "text" in c)
      .map((c) => c.text ?? "")
      .join("\n");
  }
  return typeof content === "string" ? content : "";
}

/** `input` event view: real prompt text + pasted images (omp InputEvent). */
interface InputEventView {
  text?: string;
  images?: Array<{ data?: string; mimeType?: string }>;
}

function readInputEvent(v: unknown): InputEventView {
  if (!v || typeof v !== "object") return {};
  const out: InputEventView = {};
  if ("text" in v && typeof v.text === "string") out.text = v.text;
  if ("images" in v && Array.isArray(v.images)) {
    out.images = v.images.filter((img): img is { data?: string; mimeType?: string } =>
      !!img && typeof img === "object" && "data" in img);
  }
  return out;
}

/** `session_stop` event view: omp carries the CC Stop contract fields directly. */
interface SessionStopView {
  session_id?: string;
  session_file?: string;
  stop_hook_active?: boolean;
}

function readSessionStop(v: unknown): SessionStopView {
  const out: SessionStopView = {};
  if (!v || typeof v !== "object") return out;
  if ("session_id" in v && typeof v.session_id === "string") out.session_id = v.session_id;
  if ("session_file" in v && typeof v.session_file === "string") out.session_file = v.session_file;
  if ("stop_hook_active" in v) out.stop_hook_active = v.stop_hook_active === true;
  return out;
}

export default function lifeosBridge(pi: ExtensionAPI): void {
  log({ event: "bridge_init", version: 2, hooks: registry.length, lifeosDir: LIFEOS_DIR });

  pi.on("session_start", async (_event: unknown, ctx: unknown) => {
    // Re-read the registry: settings.json edits take effect next session.
    registry = loadRegistry();
    cachedSessionId = sessionIdOf(ctx);
    cachedSessionFile = transcriptOf(ctx);
    log({ event: "session_start", hooks: registry.length, session_id: cachedSessionId, transcript: !!cachedSessionFile });
    for (const reg of forEvent("SessionStart")) {
      const res = await runHook(reg, {
        session_id: cachedSessionId,
        transcript_path: cachedSessionFile,
        source: "startup",
        cwd: process.cwd(),
        hook_event_name: "SessionStart",
      });
      const parsed = parseOutput(res.out);
      if (parsed.context) pendingContext.push(parsed.context);
      log({ hook: hookName(reg.command), cc: "SessionStart", ok: res.ok, ms: res.ms, err: res.err || null, context: !!parsed.context });
    }
    showLifeosStatusline(ctx).catch(() => {});
    // Keep the LifeOS status line live: refresh every 60s (weather/time/context
    // drift) and on turn events below. One timer per process; session switches
    // replace it instead of stacking.
    const timers = timerApi(ctx);
    if (timers) {
      if (statuslineTimer) timers.clearTimer(statuslineTimer);
      statuslineTimer = timers.setInterval(() => {
        showLifeosStatusline(ctx).catch(() => {});
      }, 60_000);
    }
  });

  // ภาพที่ผู้ใช้ส่ง → ให้ gemma4 (ollama vision) อ่าน แล้วแทนที่ด้วยคำบรรยาย
  // (ตัวหลักอ่านรูปไม่ได้ — ต้องมี vision model คอยอ่านให้)
  // + prompt-side hooks: real prompt text (omp `input` event; interactive/rpc).
  // Top-level registration — v1 registered this inside the `context` handler,
  // stacking one image handler per context injection.
  pi.on("input", async (event: unknown, ctx: unknown) => {
    const ev = readInputEvent(event);
    inputRanForTurn = true;
    const sid = sessionIdOf(ctx);
    const transcript = transcriptOf(ctx);
    if (typeof ev.text === "string") {
      for (const reg of forEvent("UserPromptSubmit")) {
        const res = await runHook(reg, {
          prompt: ev.text,
          session_id: sid,
          transcript_path: transcript,
          cwd: process.cwd(),
          hook_event_name: "UserPromptSubmit",
        });
        const parsed = parseOutput(res.out);
        if (parsed.context) pendingContext.push(parsed.context);
        log({ hook: hookName(reg.command), cc: "UserPromptSubmit", via: "input", ok: res.ok, ms: res.ms, err: res.err || null, context: !!parsed.context, decision: parsed.decision || null });
        // CC semantics: UserPromptSubmit deny prevents the prompt from processing.
        if (parsed.decision === "deny") {
          const reason = parsed.reason ?? `denied by LifeOS hook ${hookName(reg.command)}`;
          const ui = readCtxUI(ctx).ui;
          if (ui?.notify) ui.notify(`LifeOS: ${reason}`, "warning");
          log({ hook: hookName(reg.command), cc: "UserPromptSubmit", note: "deny → prompt blocked" });
          return { handled: true };
        }
      }
    }
    if (!ev.images?.length) return;
    const descs: string[] = [];
    for (const img of ev.images) {
      if (!img.data) continue;
      descs.push(await describeImage(img.data));
    }
    if (!descs.length) return;
    const text = `${ev.text ?? ""}\n\n[ภาพที่ผู้ใช้ส่ง — อ่านโดย ${VISION_MODEL}]\n${descs.join("\n")}`;
    log({ event: "input_image_read", images: ev.images.length, chars: text.length });
    return { text, images: [] };
  });

  pi.on("turn_start", async (_event: unknown, ctx: unknown) => {
    log({ event: "turn_start", inputRan: inputRanForTurn });
    // `input` already ran prompt-side hooks with the real prompt — skip the
    // fallback (print/rpc mode never fires `input`, so the fallback still runs
    // there with a placeholder prompt).
    if (inputRanForTurn) {
      inputRanForTurn = false;
      showLifeosStatusline(ctx).catch(() => {});
      return;
    }
    const sid = sessionIdOf(ctx);
    const transcript = transcriptOf(ctx);
    for (const reg of forEvent("UserPromptSubmit")) {
      const res = await runHook(reg, {
        prompt: "(omp turn_start; input payload unavailable)",
        session_id: sid,
        transcript_path: transcript,
        cwd: process.cwd(),
        hook_event_name: "UserPromptSubmit",
      });
      const parsed = parseOutput(res.out);
      if (parsed.context) pendingContext.push(parsed.context);
      log({ hook: hookName(reg.command), cc: "UserPromptSubmit", via: "turn_start", ok: res.ok, ms: res.ms, err: res.err || null, context: !!parsed.context });
    }
    showLifeosStatusline(ctx).catch(() => {});
  });

  pi.on("tool_call", async (event: unknown, ctx: unknown) => {
    const info = readToolCall(event);
    if (!info) return;
    log({ event: "tool_call", tool: info.name });
    const ccName = toolCcName(info.name);
    for (const reg of forTool("PreToolUse", ccName)) {
      const res = await runHook(reg, {
        tool_name: ccName,
        tool_input: info.input ?? {},
        session_id: sessionIdOf(ctx),
        transcript_path: transcriptOf(ctx),
        cwd: process.cwd(),
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        source: "omp",
        tool_use_id: info.toolCallId,
      });
      const parsed = parseOutput(res.out);
      if (parsed.context) pendingContext.push(parsed.context);
      log({ hook: hookName(reg.command), cc: "PreToolUse", tool: info.name, ok: res.ok, ms: res.ms, err: res.err || null, decision: parsed.decision || null, context: !!parsed.context });
      if (parsed.decision === "deny") {
        return { block: true, reason: parsed.reason || `blocked by LifeOS hook ${hookName(reg.command)}` };
      }
      if (parsed.decision === "ask") {
        const ui = readCtxUI(ctx).ui;
        if (ui?.confirm) {
          const allow = await ui.confirm("LifeOS hook", parsed.reason ?? "allow this tool call?");
          if (!allow) return { block: true, reason: parsed.reason ?? "denied by user" };
        } else {
          // Claude Code headless behavior: ask → deny (fail closed)
          log({ hook: hookName(reg.command), cc: "PreToolUse", tool: info.name, note: "ask→deny (headless)" });
          return { block: true, reason: parsed.reason ?? "ask denied (headless)" };
        }
      }
    }
  });

  pi.on("tool_result", async (event: unknown, ctx: unknown) => {
    const info = readToolResult(event);
    if (!info) return;
    const ccEvent = info.isError ? "PostToolUseFailure" : "PostToolUse";
    log({ event: "tool_result", tool: info.name, isError: info.isError });
    const sid = sessionIdOf(ctx);
    const transcript = transcriptOf(ctx);
    for (const reg of forTool(ccEvent, toolCcName(info.name))) {
      const res = await runHook(reg, info.isError
        ? {
            tool_name: toolCcName(info.name),
            tool_input: info.input ?? {},
            tool_response_error: info.content,
            session_id: sid,
            transcript_path: transcript,
            cwd: process.cwd(),
            hook_event_name: "PostToolUseFailure",
            tool_use_id: info.toolCallId,
          }
        : {
            tool_name: toolCcName(info.name),
            tool_input: info.input ?? {},
            tool_response: info.content,
            tool_response_error: null,
            session_id: sid,
            transcript_path: transcript,
            cwd: process.cwd(),
            hook_event_name: "PostToolUse",
            permission_mode: "default",
            source: "omp",
            tool_use_id: info.toolCallId,
          });
      const parsed = parseOutput(res.out);
      if (parsed.context) pendingContext.push(parsed.context);
      log({ hook: hookName(reg.command), cc: ccEvent, tool: info.name, ok: res.ok, ms: res.ms, err: res.err || null, context: !!parsed.context });
    }
  });

  // Stop hooks: omp `session_stop` carries the real CC Stop contract —
  // session_id, transcript (session_file), stop_hook_active — and its result
  // maps CC block decisions onto omp continuations (capped at 8 by omp).
  pi.on("session_stop", async (event: unknown) => {
    const ev = readSessionStop(event);
    const sid = ev.session_id ?? cachedSessionId;
    const transcript = ev.session_file ?? cachedSessionFile;
    log({ event: "session_stop", stop_hook_active: ev.stop_hook_active === true });
    for (const reg of forEvent("Stop")) {
      const res = await runHook(reg, {
        stop_hook_active: ev.stop_hook_active === true,
        transcript_path: transcript,
        cwd: process.cwd(),
        hook_event_name: "Stop",
        session_id: sid,
      });
      const parsed = parseOutput(res.out);
      if (parsed.context) pendingContext.push(parsed.context);
      log({ hook: hookName(reg.command), cc: "Stop", ok: res.ok, ms: res.ms, err: res.err || null, context: !!parsed.context, block: parsed.block === true, continueTurn: parsed.continueTurn === true });
      // CC block / omp continuation contract → omp session_stop result.
      if (parsed.block) {
        return {
          decision: "block" as const,
          reason: parsed.reason ?? parsed.context ?? `blocked by LifeOS hook ${hookName(reg.command)}`,
        };
      }
      if (parsed.continueTurn) {
        return parsed.context ? { continue: true, additionalContext: parsed.context } : { continue: true };
      }
    }
  });

  pi.on("turn_end", async (event: { message?: unknown }, ctx: unknown) => {
    log({ event: "turn_end" });
    showLifeosStatusline(ctx).catch(() => {});
    // omp-native voice: VoiceCompletion.hook.ts needs a Claude transcript omp
    // doesn't have. Speak the turn's OWN final message — the old path read the
    // newest session log globally, so with parallel sessions it picked the
    // wrong session's line (or none) and voice silently died. (2026-08-22)
    if (process.env.OMP_VOICE === "0") return;
    const line = extractVoiceLine(assistantMessageText(event?.message));
    if (!line) return;
    const t0 = Date.now();
    try {
      const res = await fetch(PULSE_NOTIFY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: line, voice_id: VOICE_ID }),
        signal: AbortSignal.timeout(10_000),
      });
      log({ voice: res.ok ? "sent" : "failed", status: res.status, ms: Date.now() - t0, line: line.slice(0, 40) });
    } catch (e) {
      log({ voice: "failed", err: String(e).slice(0, 120) });
    }
  });

  pi.on("session_shutdown", async () => {
    log({ event: "session_shutdown", session_id: cachedSessionId });
    for (const reg of forEvent("SessionEnd")) {
      const res = await runHook(reg, {
        session_id: cachedSessionId,
        transcript_path: cachedSessionFile,
        cwd: process.cwd(),
        hook_event_name: "SessionEnd",
      });
      const parsed = parseOutput(res.out);
      if (parsed.context) pendingContext.push(parsed.context);
      log({ hook: hookName(reg.command), cc: "SessionEnd", ok: res.ok, ms: res.ms, err: res.err || null, context: !!parsed.context });
    }
  });

  // Inject queued additionalContext (delta blocks, rules) as a system message
  // before the next LLM call — replaces Claude Code's implicit injection.
  pi.on("context", async (event: unknown) => {
    if (pendingContext.length === 0) return;
    const text = pendingContext.join("\n");
    pendingContext = [];
    log({ event: "context_inject", chars: text.length });
    const messages = event && typeof event === "object" && "messages" in event && Array.isArray(event.messages)
      ? [...event.messages]
      : [];
    messages.push({ role: "system", content: [{ type: "text", text }] });
    return { messages };
  });
}