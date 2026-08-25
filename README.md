# pi-gear

A user-facing extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that adds sandboxed Bash, filesystem and network policy, task planning, research subagents, and language-server tools.

## What pi-gear adds to Pi

- **Sandboxed Bash** through [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) on macOS. Initialization failures block Bash instead of falling back to the host.
- **Filesystem policy** for Pi's `read`, `edit`, and `write` tools, including path normalization and symlink-aware checks.
- **Network policy and approvals** for sandboxed Bash.
- **Task state and Plan UI** through the `task_state` tool.
- **Read-only research and worker subagents** with configurable model defaults.
- **LSP tools** for diagnostics, definitions, and references.
- **Loop guard** advisory check-ins during long agent runs.

## Install and enable in Pi

pi-gear is a local Pi extension, not a standalone CLI. It imports local npm dependencies at runtime, so install them after cloning:

```sh
git clone https://github.com/ackneal/pi-gear.git ~/Developer/pi-gear
cd ~/Developer/pi-gear
bun install
```

Requirements: Node.js 22.19 or newer, Bun, and macOS when sandboxing is enabled.

Add the repository directory to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/Developer/pi-gear"
  ]
}
```

Pi resolves the repository's root `index.ts`; an explicit file path is not needed. To enable pi-gear for one project only, put the same `extensions` setting in that project's `.pi/settings.json` instead. Project-local extensions require the project to be trusted.

Restart Pi or reload extensions after changing settings.

## Configuration location and JSON Schema

pi-gear loads policy from:

```text
~/.pi/agent/pi-gear/config.json
```

More precisely, it uses `<PI_CODING_AGENT_DIR>/pi-gear/config.json`. If that file does not exist, the repository's [`config.json`](config.json) is used as the default and copyable example. An invalid user config fails closed; pi-gear does not silently fall back to defaults.

Start a user config from `config.json` and retain its schema reference for editor validation, autocomplete, and tooltips:

```json
{
  "$schema": "https://raw.githubusercontent.com/ackneal/pi-gear/main/config.schema.json",
  "version": 1,
  "sandbox": {
    "enabled": true,
    "network": { "strictAllowlist": false, "rules": [] }
  },
  "filesystem": { "rules": [] }
}
```

`$schema` is optional metadata and does not affect runtime behavior. Unknown fields and invalid values are rejected. The complete contract is in [`config.schema.json`](config.schema.json).

## Sandbox configuration

Sandboxing defaults to enabled, including when `sandbox` or `sandbox.enabled` is omitted:

```json
{
  "sandbox": {
    "enabled": true
  }
}
```

When enabled, pi-gear replaces Pi's Bash tool and `user_bash` operations with Sandbox Runtime implementations. If initialization or dependency checks fail, Bash remains unavailable; there is no automatic host fallback.

To intentionally use Pi's normal host Bash:

```json
{
  "sandbox": {
    "enabled": false
  }
}
```

With sandboxing disabled, pi-gear does not initialize Sandbox Runtime or replace Pi's Bash behavior. **Bash commands execute directly on the host.** Each new interactive session shows one warning; headless sessions do not prompt. Filesystem guards for Pi's `read`, `edit`, and `write` tools and all other pi-gear capabilities remain active.

## Filesystem and network policy

Filesystem selectors may be workspace-relative, absolute, or begin with `~/`. Access is `deny`, `read-only`, or `read-write`; more restrictive matching rules take precedence. A rule with `"follow": true` also authorizes the symlink-resolved target, while explicit target deny rules still win.

Outside-workspace file-tool access requires confirmation in interactive sessions and is denied in headless sessions. Sensitive credential paths are denied by the bundled policy. Review policy changes before use.

Network rules live under `sandbox.network` and use a DNS host, optional wildcard subdomain, and optional port:

```json
{
  "sandbox": {
    "network": {
      "strictAllowlist": false,
      "rules": [
        { "host": "github.com", "access": "allow" },
        { "host": "*.githubusercontent.com", "access": "allow" },
        { "host": "example.com:443", "access": "deny" }
      ]
    }
  }
}
```

Rules apply only to sandboxed Bash. `strictAllowlist` defaults to `false`, so unknown hosts require interactive approval. Set it to `true` to deny unknown hosts without prompting. When sandboxing is disabled, host Bash networking is not governed by this policy.

## LSP configuration

LSP support is enabled only when `lsp` is present. Servers start lazily and are never installed automatically.

```json
{
  "lsp": {
    "idleTimeoutMinutes": 15,
    "servers": [
      {
        "extensions": [".ts", ".tsx", ".js", ".jsx"],
        "languageIds": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
          ".jsx": "javascriptreact"
        },
        "command": ["tsc", "--lsp", "--stdio"]
      }
    ]
  }
}
```

Each extension may belong to only one server. `languageIds` must map every configured extension and no others. Commands run with `shell: false` from the workspace root. `idleTimeoutMinutes` defaults to 15; use `0` to disable idle shutdown. An empty `servers` array disables all servers.

## Commands and tools

- **`/gear:doctor`** — reports sandbox state (enabled and available, enabled but unavailable, or disabled by configuration), filesystem/network behavior, subagent settings, and LSP availability.
- **`/gear:subagent-inspect`** — inspects recorded subagent runs.
- **`/gear:subagent-model`** — sets persistent model and thinking defaults in `~/.pi/agent/pi-gear/runtime.json`.
- **`task_state`** — manages a goal, outcome steps, constraints, and decision-relevant findings.
- **`diagnostics`** — returns LSP diagnostics for changed files or the workspace.
- **`navigation`** — resolves definitions or references with 1-based positions.
- **`researcher`** — delegates focused read-only research to an isolated Pi child process.
- **`worker`** — delegates bounded implementation work to a child process.

Successful Pi `edit` and `write` calls synchronize matching LSP files and report new or changed diagnostics automatically.

## Security behavior and limitations

- Sandbox failures fail closed only when sandboxing is enabled. Explicitly disabling sandboxing opts into direct host command execution.
- File paths are checked for traversal, symlink escape, and dangling-symlink writes, but authorization remains a preflight check and cannot eliminate all filesystem races.
- Pi recursive tools such as `grep`, `find`, and `ls` are not filesystem-policy guarded; pi-gear warns when they are active.
- Network approvals are scoped to the current sandbox generation and cleared on shutdown.
- Researcher MCP connections are outside the sandboxed Bash network approval path.
- Sandboxed Bash inherits the host process environment subject to runtime configuration; avoid exposing credentials through environment variables.
- Sandbox Runtime currently supports macOS. LSP uses one session working directory as its workspace root and does not discover monorepo roots.

## Development

```sh
bun run typecheck
bun run test
```

Sandbox integration tests need permission to create Runtime sockets under `/tmp/claude`; restricted environments may report `EPERM`.

Main areas: `config/` parses policy, `execution/` implements sandbox and filesystem enforcement, `context/` manages prompt/task state, `subagents/` runs delegated agents, `lsp/` provides code intelligence, and `ui/` renders Pi components.

Released under the [MIT License](LICENSE).
