# pi-gear

**Sandboxed Bash, filesystem and network policy, and task planning for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent).**

pi-gear is a security-focused extension for `@earendil-works/pi-coding-agent`. It runs agent Bash inside [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) on macOS, applies policy checks to Pi's `read`/`edit`/`write` tools, renders task plans in the Pi interface, and delegates focused research to an isolated read-only subagent.

## Table of contents

- [Why pi-gear](#why-pi-gear)
- [Features](#features)
- [Requirements](#requirements)
- [Install and load](#install-and-load)
- [Configuration](#configuration)
- [Commands and tools](#commands-and-tools)
- [Security model](#security-model)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Project layout](#project-layout)

## Why pi-gear

Pi runs shell commands in the host environment and its built-in file tools have no policy layer. pi-gear closes both gaps:

- **Bash is sandboxed.** Agent commands execute inside Anthropic Sandbox Runtime with constrained filesystem and network access. If the sandbox cannot initialize, Bash does not run — there is no unsandboxed fallback.
- **Filesystem access is policy-driven.** Pi's `read`, `edit`, and `write` tools are checked against a deny/read-only/read-write rule set with path normalization and symlink-aware resolution.
- **Plans and research are structured.** `task_state` tracks goals, todos, constraints, and findings inside the session; a child-process researcher keeps read-only investigation isolated from the main agent.

## Features

- **Sandboxed Bash** — Runs Bash through Anthropic Sandbox Runtime on macOS. Sandbox initialization failures block Bash; the extension never falls back to unsandboxed host execution.
- **Filesystem guard** — Applies policy checks to Pi's `read`, `edit`, and `write` tools. Outside-workspace access requires confirmation in interactive sessions and is denied in headless sessions.
- **Sensitive-path protection** — Credential files and directories are denied by default, and deny rules always outrank allow rules.
- **Recursive-tool warning** — Warns when Pi enables unguarded recursive filesystem tools (`grep`, `find`, `ls`), but does not block them.
- **Network approvals** — Sandboxed Bash uses configured allow, deny, and approval rules. Unknown hosts require approval by default.
- **Task state** — Provides the `task_state` tool for goals, bounded todos, constraints, findings, and verifiable completion criteria.
- **Plan UI** — Renders task plans in the Pi interface and restores active state across session branches and compaction.
- **Researcher** — Provides an isolated, read-only `researcher` subagent with the `read` tool and selected MCP research capabilities.
- **Code intelligence** — Uses configured stdio language servers for diagnostics, definitions, and references. Servers start lazily and are never installed automatically.
- **Loop guard** — Sends advisory check-ins after 15 and 25 consecutive turns, then resets after the agent settles.

## Requirements

| Requirement | Version or platform |
| --- | --- |
| **Operating system** | macOS for Sandbox Runtime |
| **Node.js** | >= 22.19.0 |
| **Package manager** | bun |
| **Pi** | `@earendil-works/pi-coding-agent` runtime |

## Install and load

Install dependencies from the repository root:

```sh
bun install
```

pi-gear is a Pi extension, not a standalone CLI. Configure your Pi runtime to load the extension entry point:

```text
/path/to/pi-gear/index.ts
```

## Configuration

Policy is loaded from `<PI_CODING_AGENT_DIR>/pi-gear/config.json` (default: `~/.pi/agent/pi-gear/config.json`). If that file does not exist, the repository-root `config.json` is used as the default and copyable example. An invalid global config fails closed instead of falling back silently.

Filesystem rules use workspace-relative paths, absolute paths, or `~/` selectors. More restrictive rules take precedence over less restrictive rules. A rule with `"follow": true` also authorizes the symlink-resolved target of a matching path, so opt-in rules work through symlinks without prompting; explicit deny rules on the target still win.

Review policy changes before using the extension. Do not weaken sensitive-file deny rules without understanding the resulting access boundary.

LSP support is enabled only when `lsp` is present. Each server owns one or more extensions and supplies its executable plus arguments as an argv array; duplicate extension ownership is invalid:

```json
{
  "lsp": {
    "servers": [
      {
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "command": ["typescript-language-server", "--stdio"]
      }
    ]
  }
}
```

pi-gear does not install language servers. Commands run with `shell: false`, use the workspace cwd as their v1 root, and start only when a matching source file is first used.

## Commands and tools

### `/gear:doctor`

Shows sandbox diagnostics plus each active subagent's resolved model and thinking level:

```text
Sandbox: enabled
Platform: darwin
Workspace: /path/to/workspace
Filesystem: read/edit/write guarded; other tools warn when unguarded
Network: configured rules; unknown hosts require approval

Subagents:
- researcher: enabled · inherit · (provider) model • low
- worker: enabled · override · (provider) model • medium

LSP:
- ✓ .go · gopls
- ✗ .ts .tsx .js .jsx · typescript-language-server · not found
```

When the sandbox is unavailable, `/gear:doctor` inserts a `Reason:` line below the status.

Other commands:

- `/gear:subagent-inspect` — inspect recorded subagent runs.
- `/gear:subagent-model` — set the persistent model and thinking default for a subagent.

Settings are written to `<PI_CODING_AGENT_DIR>/pi-gear/runtime.json` (default: `~/.pi/agent/pi-gear/runtime.json`) and apply across sessions. Each subagent can inherit the current main model or override provider, model, and thinking level.

### `task_state`

Use `task_state` for non-trivial work:

```text
set_plan → update_todo → add_constraint / add_finding → show → clear
```

A plan contains one goal and 1–10 todos. Each todo has a status and a `doneWhen` verification condition. Active state is reconstructed from session history and preserved through compaction.

### `diagnostics` and `navigation`

`diagnostics` reports normalized errors and warnings for Git working-tree changes by default, or configured files across the workspace with `scope: "workspace"`. In a non-Git workspace, changed scope falls back to workspace diagnostics.

`navigation` resolves `definition` or `references` for a configured source path. Its input and output line/column positions are 1-based. Results are limited to workspace file locations.

Successful built-in `edit` and `write` calls synchronize matching files and append only new or changed errors. A workspace watcher refreshes language-server state for changes made by Bash, formatters, scripts, or external tools; it does not parse Bash commands. Warnings remain available through `diagnostics`.

### `researcher`

The researcher runs in a separate Pi child process. It is read-only and cannot modify files, run Bash, or update task state.

Available research capabilities:

- **Exa** — Web search, code context, papers, and crawling
- **Context7** — Library and framework documentation
- **grep.app** — GitHub code search

The researcher inherits the active session working directory so local reads resolve against the same project.

## Security model

- **No fallback** — If Sandbox Runtime cannot initialize, Bash and `user_bash` remain unavailable.
- **Path normalization** — File paths are normalized and checked for traversal, symlink escape, and dangling symlink writes.
- **Approval isolation** — Network approvals are scoped to the current sandbox generation and cleared on session shutdown.
- **Process cleanup** — Abort, timeout, and session shutdown terminate sandboxed command process groups and clean up runtime state.
- **Headless safety** — Operations requiring user approval are denied when no UI is available.

## Known limitations

- **Platform support** — Sandbox Runtime is currently supported only on macOS.
- **Researcher networking** — Researcher MCP connections use their own child-process capability path and are not currently governed by the sandboxed Bash network approval flow.
- **Environment inheritance** — Sandboxed Bash currently receives the host process environment, subject to the runtime configuration. Avoid exposing credentials through the shell environment.
- **LSP workspace root** — LSP v1 uses the session cwd as one workspace root; root-marker and monorepo discovery are not implemented.
- **Filesystem races** — File-tool authorization is a preflight check. It does not fully eliminate TOCTOU races caused by another local process changing paths concurrently.
- **Runtime integration tests** — Sandbox-dependent tests require permission to create Sandbox Runtime sockets under `/tmp/claude`.

## Development

Run the type checker:

```sh
bun run typecheck
```

Run the test suite:

```sh
bun run test
```

The suite covers policy, path, sandbox lifecycle, researcher runtime, task-state, Plan UI, and tool-renderer behavior. Two tests exercise the real Sandbox Runtime (sandbox integration and spawn lifecycle); in restricted environments they fail with `EPERM` when `/tmp/claude/srt-mux-*.sock` cannot be created — an environment permission issue, not an assertion failure.

## Project layout

| Path | Purpose |
| --- | --- |
| **`index.ts`** | Extension entry point |
| **`config.json`** | Filesystem and network policy |
| **`config/`** | Policy loading, parsing, and selector helpers |
| **`execution/`** | Sandbox controller, filesystem guard, and policy evaluation |
| **`lifecycle/`** | Loop guard |
| **`context/`** | Prompt composition and task state |
| **`subagents/`** | Isolated researcher runtime and profiles |
| **`capabilities/`** | MCP capability definitions and adapters |
| **`ui/`** | Plan, subagent, and tool renderers |

---

Built for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). Related: [pi-tui](https://github.com/earendil-works/pi-tui), [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime).

Released under the [MIT License](LICENSE).
