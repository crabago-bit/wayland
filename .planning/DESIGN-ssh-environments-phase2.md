# SSH environments - phase 2: run the agent on a remote host

Branch: `feat/ssh-environments`. Phase 1 (host list from `~/.ssh/config`, remote folder browse) is done.

## Goal
A chat can be bound to `(sshHost, remoteWorkspace)`. The agent process runs on that
host with that folder as its cwd. The Wayland UI and database stay on this server.

## Findings that shape the design
1. Agents are child processes speaking ACP over stdio, so `ssh -T host 'cd DIR && exec AGENT'`
   is a drop-in transport. Spawn choke points:
   - `spawnLegacyChild` in `src/process/acp/compat/LegacyConnectorFactory.ts` (new stack)
   - `createGenericSpawnConfig` / `spawnGenericBackend` / `connectNpxBackend` in `src/process/agent/acp/acpConnectors.ts`
   - `AcpConnection.connect` in `src/process/agent/acp/AcpConnection.ts` (legacy stack)
2. DANGER: Wayland advertises `fs.readTextFile/writeTextFile = true` in `initialize`
   (`AcpConnection.ts` ~791) and serves those requests from the LOCAL disk
   (`handleReadOperation` / `handleWriteOperation`). A remote agent would read and write
   files on this server at the remote path. Remote sessions MUST advertise both as false
   (agents then use their own file tools on the remote) and the handlers must refuse
   when the connection is remote.
3. `spawnGenericBackend` runs `fs.mkdir(workingDir, {recursive:true})` locally. Remote
   sessions must skip it or it creates the remote path on this server.
4. Local stdio MCP servers (paths on this server) cannot run on the remote host. Send
   no stdio `mcpServers` for remote sessions; http/sse only, or none at first.
5. Per-spawn env (Flux/ANTHROPIC_* routing) is not forwarded over ssh. The remote agent
   uses its own login and config. That is a feature: no keys leave this server.
6. Non-interactive ssh has a minimal PATH (Mac: `claude`, `codex`, `gemini`, `node` only
   resolve in a login shell). Wrap the remote command in `bash -lc`.
7. The workspace panel, previews and diffs read local fs. Remote chats need those gated
   (show "remote workspace" instead of reading local paths) until phase 3.

## Plumbing
- `AgentConfig.sshHost?: string` and conversation `extra.sshHost`; `workspace` holds the remote path.
- `sshHost` is validated against `findSshHost()` at every use, never trusted from the client.
- New `buildSshSpawn(host, cwd, argv)` in `src/process/services/sshHosts/`:
  `ssh -T -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -- alias "bash -lc 'cd Q && exec Q...'"`,
  every word through `shellQuote`. stdio stays `pipe`; kill = kill the local ssh (add `-o ExitOnForwardFailure`-free; remote sees SIGHUP on closed stdin).
- Backends: claude / codex via their ACP bridge packages (`npx` on the remote), or any
  CLI the host already has.

## Remote side effects (need consent per host)
Using the npx bridges fetches `@zed-industries/claude-agent-acp` etc. into the remote
user's npm cache. Nothing else is written outside the chosen folder by Wayland itself.
Do not run the first live test on a host without the owner's go-ahead.

## Order of work
1. `buildSshSpawn` + unit tests (quoting, argv).
2. Thread `sshHost` through both stacks; force fs capability false and refuse local fs ops when remote.
3. Skip local mkdir for remote cwd; drop stdio MCP servers for remote.
4. Gate workspace panel / previews for remote chats.
5. Enable "Select" for remote folders in `DirectorySelectionModal`; carry `{host, path}` to chat creation.
6. Live test: Claude Code on `mac` (already has `claude`, `node`).
