# MCP gateway

This repository is the canonical source for `~/.config/mcp-gateway`. Chezmoi
clones it as a `git-repo` external configured by the xnoto `dotfiles` repo.

It runs local stdio MCP servers once and exposes each server over
Streamable HTTP for OpenCode, Claude Code, and Codex. A small Node supervisor
runs one `mcp-proxy` process per server so a failed credential, VPN, or Podman
dependency cannot prevent unrelated MCP servers from starting.

Each proxy listens only on a dedicated localhost port recorded in
`servers.json`, with its MCP endpoint at `http://127.0.0.1:<port>/mcp`. The
supervisor probes `tools/list` and restarts only the failed proxy after repeated
protocol failures.

## Shared GitHub integration

The `github` entry serves `http://127.0.0.1:8767/mcp` through the existing
`bin/github` launcher. It sources the private `~/.shellenv` and passes
`GITHUB_MCP_TOKEN` to the official GitHub MCP container as
`GITHUB_PERSONAL_ACCESS_TOKEN`. The image remains pinned to `v1.9.0`;
this integration does not upgrade the server or change token permissions.

OpenCode, Claude Code, and Codex connect to that endpoint using independent
HTTP sessions; they do not launch their own GitHub process or carry token
headers. OpenCode's global entry is disabled by default; projects opt in with
`"github": { "enabled": true }`. All clients share the gateway's GitHub
identity, repository access, API limits, and backend availability. They can
still conflict when modifying the same GitHub resource; shared transport is
not a coordination or per-client authorization boundary.

The endpoint is unauthenticated. Loopback limits network exposure but does not
authenticate other local processes. Use it only on a trusted workstation and
never forward it to another host. Keep `GITHUB_MCP_TOKEN` unexported in
shellenv and keep `GITHUB_TOKEN` reserved for the `gh` CLI.

Install the gateway source before activating the client connections. Dotfiles
owns the external checkouts, the Claude archive mapping, encrypted credential
rendering, and platform service definitions. After an owner-approved source
update, sync the installed gateway, restart its service with explicit approval,
and reload the clients. Podman must be available (and its machine running on
macOS); the first GitHub launch may pull the pinned image. No container pull
or workstation activation is performed by CI.

`make test-github` validates the manifest, credential scoping with a synthetic
shellenv and mocked Podman, and independent concurrent HTTP sessions over one
synthetic stdio backend using the pinned proxy/SDK. It does not contact GitHub
or prove token validity, permissions, image compatibility, or live client
behavior. Authenticated read-only checks from the installed clients remain a
separate owner-run verification stage. The proxy does not route elicitation or
sampling callbacks; do not assume callback-dependent tools work through it.

The launcher must be executable in Git (`git ls-files -s bin/github` should
show `100755` after staging). Otherwise the gateway's `exec` fails with
permission denied before credentials or Podman are reached. The manifest test
checks this mode; running the launcher as `/bin/sh bin/github` alone does not
catch the failure.

## Process lifecycle

Each proxy is started in its own process group, and every stop signals that
whole group. A server's `uvx` or `npx` entry point is only the head of a tree:
`npx` starts `npm exec`, which starts the server itself. A signal aimed at the
proxy alone leaves those wrappers running, and a leaked wrapper keeps whatever
the downstream server holds. A server built around a singleton daemon, such as
`codebase-memory`, then refuses every later generation: the leaked client still
holds the daemon's admission locks, each replacement waits out its handshake
timeout and exits, and `mcp-proxy` never binds its port, so clients see a
connection refused on a port the supervisor believes it is serving.

A stop escalates to `SIGKILL` after `MCP_GATEWAY_TERMINATE_GRACE_MS`
(10s by default), and a proxy that exits on its own is swept the same way,
because it can die while the wrappers it started keep running. Replacement
startup and its backoff timer wait for that sweep; shutdown also waits for
pending sweeps. Cleanup allows up to one additional second after SIGKILL.
If a group still exists, the supervisor exits unsuccessfully without starting
a conflicting replacement and retains the group for next-run recovery.

The supervisor records its process group ids in
`~/.cache/mcp-gateway/supervisor-state.json` and sweeps any that survive into
the next run, including exited proxies whose descendant sweeps are still pending. State
updates use atomic replacement, covering the case where the supervisor itself was killed outright
rather than asked to stop. Group ids cannot outlive a reboot, so the file
records the boot it was written under and is discarded when that no longer
matches; a recycled group id is never signalled. Run a second supervisor only
with `MCP_GATEWAY_STATE` pointed elsewhere, or it will sweep the first one's
children.

The `codebase-memory` server is confined to repositories below `~/git`. It
indexes each repository only when a client requests it and keeps derived graph
state in a gateway-specific local cache below `~/.cache/mcp-gateway`; it does
not clone repositories. The full upstream tool surface is required for explicit
indexing, so clients must obtain confirmation before an indexing or other
non-read operation. Clients must keep optional shared graph-artifact persistence
disabled so indexing does not write graph artifacts into source trees. Its graph
UI is disabled because the gateway exposes MCP only.

## Dependencies

On macOS, the managed Brewfile provides `node`, `uv`, `podman`, and `tmux`.

On Fedora Linux, install `nodejs`, `uv`, `podman`, and `tmux` with the system
package manager. The gateway uses `npx` and `uvx` to run pinned MCP packages.

## Services

Platform integration remains owned by the `dotfiles` repo:

- macOS: `~/Library/LaunchAgents/com.xnoto.mcp-gateway.plist`
- Linux: `~/.config/systemd/user/mcp-gateway.service`
- credentials: the private `~/.shellenv` rendered from encrypted dotfiles

After applying the dotfiles, load the service for the current platform.

### Restarting an installed service

From the gateway checkout, use:

```sh
make restart
```

The target selects the registered macOS LaunchAgent or Linux systemd user unit
from `uname`. It only restarts an existing service; it does not bootstrap a
LaunchAgent, enable a unit, or run `systemctl --user daemon-reload`. After a
platform service-definition change, apply the dotfiles and use the platform
steps below before restarting. Restarting a service changes live workstation
state and requires explicit confirmation.

### macOS

```sh
launchctl bootout "gui/$(id -u)/com.xnoto.mcp-gateway" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" \
  "$HOME/Library/LaunchAgents/com.xnoto.mcp-gateway.plist"
```

To restart the service without re-bootstrapping:

```sh
launchctl kickstart -k "gui/$(id -u)/com.xnoto.mcp-gateway"
```

### Fedora Linux

```sh
systemctl --user daemon-reload
systemctl --user enable mcp-gateway.service
systemctl --user restart mcp-gateway.service
```

## Migrating an existing installation

Before the first apply that enables the external repository, stop the platform
service and move the existing non-Git `~/.config/mcp-gateway` directory aside.
Chezmoi clones a missing external directory but attempts to pull an existing
one, which requires that directory to already be a Git checkout.

After applying the updated dotfiles, restart the service and verify the gateway
before removing the backup.

## Development

Run the static checks from this checkout:

```sh
make check
```

Run the static checks and the supervisor tests together:

```sh
make test
```

The GitHub transport test additionally needs `mcp-proxy==0.12.0` and
`mcp==1.30.0` available to its Python interpreter; CI installs the same
versions selected by the supervisor. It uses a temporary HOME and an ephemeral
loopback port, never the installed gateway or production credentials.

The supervisor tests spawn real process trees. Each one points
`MCP_GATEWAY_STATE` at a temporary file so the suite never sweeps the process
groups of an installed gateway.

The `run` and `healthcheck` wrappers intentionally resolve the installed files
under `~/.config/mcp-gateway`; use the static checks when working only in this
source checkout.

## Verification

```sh
"$HOME/.config/mcp-gateway/healthcheck"
```

The GitHub, Grafana, Argo CD, and Parallel Search launchers source the private
`~/.shellenv` file and export only the credential required by that MCP server.
Parallel Search uses a pinned `mcp-remote` bridge to convert its hosted
Streamable HTTP endpoint to stdio before the supervisor publishes it on the
standard loopback endpoint.

Codebase Memory has no credentials or OAuth flow. After the gateway is healthy,
connect a client to `http://127.0.0.1:8771/mcp` and index individual repositories
below `~/git` with shared graph-artifact persistence disabled; do not index the
parent directory as one project.

Context-mode remains a client-local MCP because it owns per-session capture
and compaction behavior; it is not routed through this shared gateway.

The endpoints are unauthenticated and intentionally bound to loopback. Do not
forward or expose these ports to other hosts.

On macOS, initialize and start the Podman machine before using the
`terraform-docs` endpoint.
