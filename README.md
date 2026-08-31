# pi-gear

**pi-gear is a [Pi coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that adds macOS-sandboxed Bash, filesystem and network policy, task planning, researcher and worker subagents, and Language Server Protocol (LSP) tools.**

## What pi-gear adds to Pi

- **Sandboxed Bash** through [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) on macOS. Initialization failures block Bash instead of falling back to the host.
- **Filesystem policy** for Pi's `read`, `edit`, and `write` tools, including path normalization and symlink-aware checks.
- **Network policy and approvals** for sandboxed Bash.
- **Task state and Plan UI** through the `task_state` tool.
- **Read-only research and worker subagents** with configurable model defaults.
- **LSP tools** for diagnostics, definitions, and references.
- **Loop guard** advisory check-ins during long agent runs.

## Install

Install pi-gear through Pi's package manager:

```sh
pi install git:github.com/ackneal/pi-gear
```

Requirements: Node.js 22.19 or newer, Bun 1.3.13, and macOS when sandboxing is enabled. Tested with Pi 0.84.3. Both `node` and `bun` must be on `PATH` when Pi starts (including when Pi is launched from an editor or GUI).

Pi's git install flow runs `npm install` in its managed checkout, so pi-gear's package dependencies—including `@ff-labs/fff-bun` and its platform-specific native package—are installed automatically. It does not install the Bun runtime itself. You do not need to run `bun install` in pi-gear's checkout.

If startup reports that Bun or the file finder is unavailable, check the environment seen by Pi:

```sh
node --version   # v22.19.0 or newer
bun --version    # 1.3.13
```

Update installed Pi packages with:

```sh
pi update --extensions
```


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
- Researcher queries may be sent to the remote Exa, Context7, and grep.app MCP services. These MCP connections are separate from sandboxed Bash network policy and approval. Understand this external trust and privacy boundary before using researcher.
- Sandboxed Bash inherits the host process environment subject to runtime configuration; avoid exposing credentials through environment variables.
- Sandbox Runtime currently supports macOS. LSP uses one session working directory as its workspace root and does not discover monorepo roots.

## Development

For local hacking, clone the repository and install with Bun:

```sh
git clone https://github.com/ackneal/pi-gear.git ~/Developer/pi-gear
cd ~/Developer/pi-gear
bun install
```

Load the checkout by adding it to `~/.pi/agent/settings.json` (or a trusted project's `.pi/settings.json`):

```json
{
  "extensions": [
    "~/Developer/pi-gear"
  ]
}
```

Then run:

```sh
bun run typecheck
bun run test
```

Sandbox integration tests require macOS, `/usr/bin/sandbox-exec`, and permission to create Runtime sockets under `/tmp/claude`; restricted environments may report `EPERM`.

Main areas: `config/` parses policy, `execution/` implements sandbox and filesystem enforcement, `context/` manages prompt/task state, `subagents/` runs delegated agents, `lsp/` provides code intelligence, and `ui/` renders Pi components.

Released under the [MIT License](LICENSE).
