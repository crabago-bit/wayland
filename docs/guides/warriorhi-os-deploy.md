# os.warriorhi.com runbook (WarriorHi fork)

How the Wayland WebUI at https://os.warriorhi.com is actually run, and how to keep it alive across upstream bumps. `docker-compose.webui.yml` is historical; the service does NOT run in Docker.

## Topology

| Piece | Where |
|---|---|
| Process | pm2 `wayland-webui` (id 17), launcher `/home/forge/wayland/bin/wayland-webui.sh` → `bun dist-server/server.mjs`, port 3403 loopback |
| Proxy | Traefik file route `/home/forge/docker-config/traefik/dynamic/wayland.yml` → 127.0.0.1:3403, LetsEncrypt |
| Env | `ALLOW_REMOTE=false`, `WAYLAND_TRUSTED_PROXY=1`, `WAYLAND_ALLOWED_ORIGINS=https://os.warriorhi.com`, `SERVER_BASE_URL=https://os.warriorhi.com`, `DATA_DIR=/home/forge/wayland-desktop-data` |
| Engine | `resources/bundled-wayland-core/linux-x64/wayland-core` (resolver: data override → bundled → PATH). The global npm `wayland-core` on PATH is a stale fallback; never rely on it. |
| Engine config | `~/.config/wayland-core/config.toml` (MCP profile written per session by the desktop) |
| Desktop config | `$DATA_DIR/config/wayland-config.txt` = base64(encodeURIComponent(JSON)). Only edit with the app stopped. |
| Providers | app DB `model_registry_providers` (encrypted creds) + `model.config` in the config store |

## Deploy

```bash
scripts/deploy-webui.sh          # build + verify + pin check + restart + smoke
scripts/deploy-webui.sh --pull   # rebase local patches onto origin/main first
```

Steps it runs, in order: pinned wayland-core download → constitution-fs helper → `build:webui` → `verify:webui` → `check-core-pin.sh` → pm2 restart → HTTP smoke. Renderer build needs an 8 GB heap.

## The failure that took the site down on 2026-09-04

Desktop v0.12.5 pins wayland-core desktop-contract minor 19 (Core v0.13.8) in `src/process/agent/wcore/desktopContractV1.ts`. No bundled binary existed, so the resolver fell through to the global npm 0.12.26. Every Wayland Core chat failed closed with

```
wcore Desktop contract rejected ready: Core contract minor differs from the pin
```

From the browser it looked like "the agent does nothing". Fix: `WCORE_VERSION=v0.13.8 node scripts/prepareWaylandCore.js` (now step 1 of the deploy script).

### Drift alarm

`scripts/check-core-pin.sh` performs the same handshake and compares minor/generator with the pin. Cron runs it every 6 h; log at `/home/forge/wayland/logs/core-pin.log`. Optional Slack: copy `/home/forge/wayland/alert.env.example` to `alert.env`.

## Local patches (branch `local/warriorhi-v0.12.5-patches`)

- `src/renderer/pages/guid/components/GuidActionRow.tsx`: WebUI "Chat in Folder" menu. Upstream hid the button for non-Electron, but the standalone server already routes `dialog.showOpen` to the in-browser `DirectorySelectionModal` (`/api/directory/browse`, confined to cwd, `$HOME` and `/`). Menu offers recent folders (shared localStorage key with `WorkspaceFolderSelect`), "Browse server folders…", "Type a path…".
- Earlier v0.12.5 patch set: trusted-proxy handling, Hermes connector, Flux settings (see commit "Preserve WarriorHi local patches").

## Folder access model

- Per-chat workspace = the folder picked above; the agent runs with that cwd. This is how you work inside `/home/forge/repos/...`.
- Settings → folder grants (durable read grants for the engine) are desktop-only by design and Core refuses granting `$HOME` or `/`. Not needed for the per-chat workflow.
- The renderer file panel hides credential dirs (`.ssh`, `.aws`, `.gnupg`, …) even inside an authorised root.

## MCP scoping

12 streamable-http servers are enabled globally. Per chat, use the composer "+" menu → MCP toggles (`activeMcpServers`, persisted on the conversation). Recommended: coding chats → `github` only; estimating chats → `acc`, `quickbooks`, `clickup`. Keeping all 12 on burns context every turn.

## Default model

Wayland Core default (`wcore.defaultModel`) set on 2026-09-04 to OpenRouter `anthropic/claude-fable-5.1` (was `gemini-3.8-flash`). Change in Settings → Models, or edit the config store with the app stopped. Claude Code agent chats keep using the Max subscription and are unaffected. The Core TUI's own `[default]` in `config.toml` still points at local Ollama `qwen2.5:7b-instruct`; that only affects running `wayland-core` by hand.

## Credentials vault

Headless box has no OS keychain. The desktop already provisions a per-profile vault passphrase (`config/profile-vault-passphrases.json`) and hands it to the engine over fd 3 at spawn; `WAYLAND_VAULT_PASSPHRASE*` in the launcher would be stripped by the spawn allowlist, so do not add it there. The boot line "safeStorage is not yet available … will retry" is benign.

## Optional MCP packages

`@wayland/{imap,news,cal-com,apple}-mcp` live in a non-public FerroxLabs repo; `build:webui` passes `WAYLAND_ALLOW_MISSING_MCP=1` so they are skipped. The 6 required stdio MCP scripts are verified by `verify:webui` and the boot canary (`MCP scripts present (6/6)`).
