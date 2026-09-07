# lifeos-omp-bridge

Runs [LifeOS](https://github.com/danielmiessler/LifeOS) Claude-Code hooks inside
[omp (Oh My Pi)](https://github.com/can1357/oh-my-pi) as a **native omp extension**.

LifeOS's hook layer runs on the Claude Code hook contract
(`${LIFEOS_DIR}/settings.json`: JSON on stdin, JSON on stdout). omp does not execute
that contract natively, so this extension shims it onto the omp event bus — LifeOS's
enforcement layer (observability, memory capture, gates, permission guards) runs in
omp without touching the LifeOS repo.

This is the omp-ecosystem home for the adapter rejected from LifeOS in
[PR #1945](https://github.com/danielmiessler/LifeOS/pull/1945); v2 addresses the
review objections.

## Event mapping

| omp event | Claude Code event | Notes |
|---|---|---|
| `session_start` | `SessionStart` | registry re-read from settings.json each session |
| `input` (interactive/rpc) + `turn_start` (fallback) | `UserPromptSubmit` | real prompt text; `deny` blocks the prompt |
| `tool_call` | `PreToolUse` | `deny` → block; `ask` → UI confirm (fail-closed headless) |
| `tool_result` | `PostToolUse` / `PostToolUseFailure` | isError routes to the failure event |
| `session_stop` | `Stop` | real `stop_hook_active`; hook `block` maps to an omp continuation |
| `session_shutdown` | `SessionEnd` | |

Hooks are invoked exactly as Claude Code invokes them: `sh -c <command>` with the
Claude Code JSON payload on stdin. Any `additionalContext` a hook returns is queued
and injected as a system message before the next LLM call via omp's `context` event.

## v2 vs v1 (PR #1945)

- **Real session ids** — `ctx.sessionManager.getSessionId()`; no `"omp"`/`"unknown"` placeholders.
- **Real `transcript_path`** — `ctx.sessionManager.getSessionFile()` / `session_stop.session_file`.
- **Stop hooks on `session_stop`** — carries the real CC Stop contract
  (`stop_hook_active`, `session_id`, `session_file`) and maps
  `{"decision":"block","reason":...}` / `{"continue":false}` to omp continuations;
  omp-native `{continue:true, additionalContext}` also honored.
- **UserPromptSubmit via `input`** — real prompt text; CC deny semantics
  (`permissionDecision: deny` → prompt not processed, reason shown). `turn_start`
  remains the print-mode fallback (omp fires `input` in interactive/rpc only).
- **Registry hot reload** — settings.json edits take effect next session.
- **Bug fix** — v1 registered the vision `input` handler inside the `context`
  handler, stacking one handler per context injection.

omp-native voice (Pulse `/notify`, 🗣️ closer extraction at `turn_end`) and the
LifeOS status-line widget are carried over from v1.

## Install

```bash
mkdir -p ~/.omp/agent/extensions
cp lifeos-hooks-bridge.ts ~/.omp/agent/extensions/
```

Restart omp — the extension auto-loads in every new session. Alternatively pass it
explicitly: `omp --hook /path/to/lifeos-hooks-bridge.ts`.

Configuration:

- `LIFEOS_DIR` — LifeOS config root (default `~/.claude`)
- `OMP_BRIDGE_LOG` — audit log path (default `~/.omp/lifeos-bridge.log`)
- `OMP_VOICE=0` — disable voice; `OMP_VOICE_ID` — override voice id
- `OMP_VISION_MODEL` — image-describer model (default `gemma4:cloud` via ollama)

## Verification

Headless smoke test:

```bash
OMP_BRIDGE_LOG=/tmp/bridge-test.log omp -p --auto-approve "run: echo bridge-v2-test"
```

Audit log shows per-hook invocations with real session ids and transcript paths,
plus `session_stop` entries for Stop hooks.