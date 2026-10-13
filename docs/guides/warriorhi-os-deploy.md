# os.warriorhi.com runbook (WarriorHi fork)

How the Wayland WebUI at https://os.warriorhi.com is actually run, and how to keep it alive across upstream bumps. `docker-compose.webui.yml` is historical; the service does NOT run in Docker.

Since 0.13 (branch `local/warriorhi-v0.13.2`) the bundled engine is **Fuigo**. Wayland Core is gone: no `prepareWaylandCore.js`, no contract pin, no `~/.config/wayland-core/config.toml` for the app, and no engine symlink on PATH.

## Topology

| Piece | Where |
|---|---|
| Process | pm2 `wayland-webui` (id 17), launcher `/home/forge/wayland/bin/wayland-webui.sh` → `bun dist-server/server.mjs`, port 3403 loopback |
| Proxy | Traefik file route `/home/forge/docker-config/traefik/dynamic/wayland.yml` → 127.0.0.1:3403, LetsEncrypt |
| Env | `ALLOW_REMOTE=false`, `WAYLAND_TRUSTED_PROXY=1`, `WAYLAND_ALLOWED_ORIGINS=https://os.warriorhi.com`, `SERVER_BASE_URL=https://os.warriorhi.com`, `DATA_DIR=/home/forge/wayland-desktop-data` |
| Engine | `resources/bundled-fuigo/linux-x64/fuigo` + `bundle.json` receipt, staged by `scripts/fuigo/prepare.cjs` (pin: `scripts/fuigo/authority.json`). The server resolves it from `process.cwd()/resources/bundled-fuigo/<platform>` only: no PATH fallback, a symlink is refused, and a binary whose sha256 differs from the receipt does not spawn. |
| Engine homes | `<userData>/fuigo` for ordinary chats, `<userData>/fuigo-laddered` for agents with a JARVIS autonomy rung. Desktop rewrites each `config.toml` before every spawn; edits there do not persist. |
| Desktop config | `$DATA_DIR/config/wayland-config.txt` = base64(encodeURIComponent(JSON)). Only edit with the app stopped. |
| Providers | app DB `model_registry_providers` (encrypted creds) + `model.config` in the config store. Fuigo serves each OpenAI-compatible row as `byok/<provider>/<model>`; keys ride env vars per spawn, never disk. The ChatGPT-subscription row is skipped by Fuigo. |

## Deploy

```bash
scripts/deploy-webui.sh              # build + verify + engine check + restart + smoke
scripts/deploy-webui.sh --no-restart # build + verify only (safe while live; also works from a worktree)
scripts/deploy-webui.sh --pull       # rebase local patches onto origin/main first
```

Steps it runs, in order: `node scripts/fuigo/prepare.cjs linux x64` → constitution-fs helper → `build:webui` → `verify:webui` → staged-engine check (staged sha256 == `bundle.json` `stagedSha256`, receipt matches the pin, not a symlink) + `grep -c url-env dist-server/builtin-mcp-tool-filter.js` (the JARVIS hosted-connector bridge) → pm2 restart → HTTP smoke. Renderer build needs an 8 GB heap. The script builds the checkout it lives in (override with `WAYLAND_REPO`), and only ever restarts the pm2 app `wayland-webui`.

After a deploy, confirm the engine the server actually spawned: `pgrep -a fuigo` after a chat turn shows the path under `resources/bundled-fuigo/linux-x64/`.

## Engine pin

There is no drift alarm any more. `scripts/check-core-pin.sh` (and its 6-hourly cron line) checked the Wayland Core contract pin, which no longer exists; Fuigo refuses an unverified binary on its own, so the "wrong engine silently used" failure of 2026-09-04 cannot recur. Bumping the engine = upstream bumps `scripts/fuigo/authority.json`; rerun the deploy.

## JARVIS autonomy ladder on Fuigo

Agents with a rung in `agents.autonomy` (Settings → Agents) are laddered on every ACP backend, Fuigo included: connectors through the tool-filter shim, native tools through the permission gate, modes clamped and re-confirmed before each prompt, refusals and rung ≥ 3 writes in `$DATA_DIR/jarvis/approvals.jsonl`. Fuigo-specific:

- A laddered Fuigo agent runs in `<userData>/fuigo-laddered`, never with `--trust`, and that home's `trusted_folders.toml` is deleted before each spawn. (Fuigo persists trust per home, and a trusted workspace's own `.fuigo/config.toml` MCP servers are dialled directly, past the shim.)
- The laddered home's managed config asks before `touch`/`mkdir`, which Fuigo otherwise runs unasked.
- Its skills come as the per-session Wayland-owned plugin (`<dataDir>/laddered-skill-plugins/<conversation>`) passed as the only `_meta.pluginDirs` entry; the session can read, not write, that dir.
- `/always-approve`, `/plugins` and `/reload-plugins` at the head of a prompt are refused for laddered sessions.

The 12 `pack-warrior-*` agents stay on the Claude backend for now (laddered Claude: no setting sources, skills plugin, bridge-version self-check).

## Local patches (branch `local/warriorhi-v0.13.2`)

- `src/renderer/pages/guid/components/GuidActionRow.tsx`: WebUI "Chat in Folder" menu. Upstream hid the button for non-Electron, but the standalone server already routes `dialog.showOpen` to the in-browser `DirectorySelectionModal` (`/api/directory/browse`, confined to cwd, `$HOME` and `/`). Menu offers recent folders (shared localStorage key with `WorkspaceFolderSelect`), "Browse server folders…", "Type a path…".
- JARVIS autonomy ladder, assistant packs, constitution helper resolution, `WAYLAND_EXTRA_LISTEN`, CLI-login reuse, cookie/proxy fixes, Hermes connector (see `git log origin/main..`).

## Folder access model

- Per-chat workspace = the folder picked above; the agent runs with that cwd. This is how you work inside `/home/forge/repos/...`.
- Settings → folder grants are desktop-only by design. Not needed for the per-chat workflow.
- The renderer file panel hides credential dirs (`.ssh`, `.aws`, `.gnupg`, …) even inside an authorised root.

## MCP scoping

Per chat, use the composer "+" menu → MCP toggles (`activeMcpServers`, persisted on the conversation). Recommended: coding chats → `github` only; estimating chats → `acc`, `quickbooks`, `clickup`. Keeping every connector on burns context every turn.

## Default model

Fuigo's default is `fuigo.defaultModel` in the config store, used for new Fuigo chats, scheduled runs and Fuigo teammates. On os.warriorhi.com it points at the JARVIS router (`byok/openai/jarvis-default`, the OpenAI-compatible row at `http://127.0.0.1:4000/v1`), set at cutover with

```bash
node scripts/warriorhi-fuigo-default-model.mjs --data-dir /home/forge/wayland-desktop-data --server-stopped
```

(server stopped; `--force` to replace an existing value; `--dry-run` to preview). The Flux Router provider stays connected, so `flux-*` tiers remain pickable. Claude Code agent chats keep using the Max subscription and are unaffected.

## Credentials vault

Headless box has no OS keychain. The desktop provisions a per-profile vault passphrase (`config/profile-vault-passphrases.json`); `WAYLAND_VAULT_PASSPHRASE*` in the launcher would be stripped by the spawn allowlist, so do not add it there. The boot line "safeStorage is not yet available … will retry" is benign.

## Optional MCP packages

`@wayland/{imap,news,cal-com,apple}-mcp` live in a non-public FerroxLabs repo; `build:webui` passes `WAYLAND_ALLOW_MISSING_MCP=1` so they are skipped. The 6 required stdio MCP scripts are verified by `verify:webui` and the boot canary (`MCP scripts present (6/6)`).
