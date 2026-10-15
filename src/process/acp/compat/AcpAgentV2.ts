// src/process/acp/compat/AcpAgentV2.ts
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import { NavigationInterceptor } from '@/common/chat/navigation';
import { isFluxModelId, isFluxNativeBackend } from '@/common/config/flux';
import type { AcpLaunchSpec, AcpModelInfo, AcpResult, AcpSessionConfigOption } from '@/common/types/acpTypes';
import {
  AcpErrorType,
  getCurrentWrapperVersion,
  isAcpLaunchSpec,
  parseInitializeResult,
} from '@/common/types/acpTypes';
import { buildHistoryReplayContext } from '@process/acp/historyReplay';
import { getFullAutoMode } from '@/common/types/agentModes';
import { LegacyConnectorFactory } from '@process/acp/compat/LegacyConnectorFactory';
import {
  loadAuthCredentials,
  mapAcpErrorCodeToType,
  toAcpConfigOptions,
  toAcpModelInfo,
  toAgentConfig,
  toResponseMessage,
  type OldAcpAgentConfig,
} from '@process/acp/compat/typeBridge';
import { AcpError as AcpSessionError } from '@process/acp/errors/AcpError';
import { AcpSession, type SessionOptions } from '@process/acp/session/AcpSession';
import { grokFsRoots } from '@process/agent/grok/fsRoots';
import { CRASH_MARKER_PROCESS_EXIT, CRASH_MARKER_TRANSPORT_CLOSE } from '@process/acp/session/crashMarkers';
import { readClaudeModelInfoFromCcSwitch } from '@process/services/ccSwitchModelSource';
import { buildClaudeSlotModelInfo } from '@process/agent/acp/utils';
// TODO(ACP Discovery): Re-enable when acp_session persistence is restored.
// import type { IAcpSessionRepository } from '@process/services/database/IAcpSessionRepository';
import { getTeamGuideStdioConfig } from '@/process/team/mcp/guide/teamGuideSingleton';
import { waitForMcpReady } from '@/process/team/mcpReadiness';
import { shouldInjectTeamGuideMcp } from '@/process/team/prompts/teamGuideCapability';
import type { McpServer } from '@agentclientprotocol/sdk';
import type {
  AgentConfig,
  ConfigSnapshot,
  ContextUsage,
  ModelSnapshot,
  ModeSnapshot,
  SessionCallbacks,
  SessionStatus,
} from '@process/acp/types';
import { ProcessConfig } from '@process/utils/initStorage';
import { getEnhancedEnv } from '@process/utils/shellEnv';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadRuntimeMcpServers } from '@process/services/mcpServices/runtimeMcpServers';
import type { McpSessionBackend, McpSessionPublicationInput } from '@/common/mcp/sessionReceipt';
import { createMcpSessionDigestKey } from '@process/services/mcpServices/mcpSessionTruthGate';
import { clampSessionModeForRung } from '@/common/jarvis/nativeAutonomy';
import type { ToolFilterSpawnAutonomy } from '@process/services/mcpServices/builtinMcpRuntime';
import {
  createAutonomyPermissionGate,
  resolveLadderedSessionMeta,
  verifyLadderedBridge,
  resolveConfiguredSpawnAutonomy,
  type SpawnLadder,
} from '@process/services/jarvis/sessionAutonomy';
import {
  buildLadderedSkillPlugin,
  ladderedSkillPluginOption,
  removeLadderedSkillPlugin,
  withLadderedSkillPrompt,
} from '@process/services/jarvis/ladderedSkillPlugin';

/** Fuigo slash commands a laddered session refuses when they open a prompt. */
const LADDERED_FUIGO_REFUSED_COMMAND = /^\s*\/(?:always-approve|plugins|reload-plugins)(?![\w-])/i;

/**
 * How long a laddered session waits for the agent to accept a mode change
 * (`session/set_mode`). A live but silent agent would otherwise hang the
 * pre-prompt guard, or leave writes refused indefinitely after a mid-turn
 * drift. No answer in time counts as a refusal: the session fails closed.
 */
export const LADDERED_MODE_CONFIRM_TIMEOUT_MS = 30_000;

/** `session.confirmMode(target)`, rejected when the agent has not answered within the bound. */
async function confirmModeWithin(session: AcpSession, target: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${LADDERED_MODE_CONFIRM_TIMEOUT_MS / 1000} s`)),
      LADDERED_MODE_CONFIRM_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([session.confirmMode(target), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Temporary: backend-specific CLI login arguments.
 * Will be replaced by `authCommand + args` config in PR #2349.
 */
const BACKEND_LOGIN_ARGS: Record<string, string[] | undefined> = {
  claude: ['/login'],
  qwen: ['login'],
};

const LOGIN_TIMEOUT_MS = 70_000;

/**
 * Wall-clock budget for an ACP session to reach `active` (or `error`) before we
 * give up. A cold first run (bunx download + CLI init, e.g. Claude) genuinely
 * takes ~90-120s on a slow disk / cold cache, which exceeded the old 2-minute
 * cap and made cron-fired runs reliably time out (BUG-5). 3 minutes clears the
 * observed cold-start window while still bounding a truly hung start.
 */
export const SESSION_START_TIMEOUT_MS = 180_000;

/**
 * Refresh backend credentials by running the backend CLI login command.
 * Will be replaced by `authCommand + args` config when Agent Hub lands (PR #2349).
 */
async function runBackendLogin(backend: string, cliCommand?: string, launch?: AcpLaunchSpec): Promise<void> {
  const env = getEnhancedEnv();
  const loginArgs = BACKEND_LOGIN_ARGS[backend];
  if (!loginArgs) return;

  // An installed agent supplies { command, args }. Use it verbatim and APPEND the
  // login arg - substituting it would run the bare runtime (e.g. bun.exe /login)
  // instead of the agent. Falling back to the string form here would hand the whole
  // composite `"<bun>" "<entry>"` to CreateProcess as the executable name (spawn
  // uses shell:false), which fails with ENOENT and is then only console.warn'd.
  //
  // Shape-checked, not merely truthy: `launch` originates in untyped persisted
  // JSON, so a partial descriptor is reachable and would spawn `undefined` as the
  // executable. A malformed one is treated as absent so the cliCommand still applies.
  const spec = isAcpLaunchSpec(launch) ? launch : undefined;
  const command = spec ? spec.command : (cliCommand ?? backend);
  const args = spec ? [...spec.args, ...loginArgs] : loginArgs;
  console.log(`[AcpAgentV2] Running ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    stdio: 'pipe',
    timeout: LOGIN_TIMEOUT_MS,
    env,
  });

  return new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${backend} ${loginArgs.join(' ')} exited with code ${code}`));
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ${backend}: ${err.message}`));
    });
  });
}

type PendingOp<T> = {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Correlated publication identity plus this conversation's active-server selection. */
type McpSessionPublicationBinding = McpSessionPublicationInput & { activeServerIds?: readonly string[] };

/**
 * AcpAgentV2 - Compatibility adapter that presents the OLD AcpAgent interface
 * while internally delegating to the NEW AcpSession.
 *
 * This adapter:
 * - Converts OldAcpAgentConfig → AgentConfig + SessionCallbacks
 * - Routes new SessionCallbacks → old event format (onStreamEvent, onSignalEvent)
 * - Caches model/config state from callbacks for sync getters
 * - Bridges async old API ↔ void new API via pending promises
 */
export class AcpAgentV2 {
  private session: AcpSession | null = null;
  private readonly agentConfig: AgentConfig;
  private conversationId: string;
  private onStreamEvent: (data: IResponseMessage) => void;
  private onSignalEvent?: (data: IResponseMessage) => void;
  private onSessionIdUpdate?: (sessionId: string) => void;
  private onAvailableCommandsUpdate?: (commands: Array<{ name: string; description?: string; hint?: string }>) => void;
  private onMcpProjection?: OldAcpAgentConfig['onMcpProjection'];
  // Receipt-bound publication identity supplied by the owning runtime (manager).
  // Read directly off the raw config (like onMcpProjection) so no receipt-optional
  // legacy path exists: the live projection is always minted against a current
  // correlated launch. Falls back to a self-minted identity only when unset.
  private readonly mcpPublicationBinding?: McpSessionPublicationBinding;
  /** `custom:<id>` half of the JARVIS autonomy key (custom OR preset assistant id); see `autonomyAgentKey`. */
  private readonly customAgentId?: string;
  /** The ladder the owning manager resolved for this spawn, if any (see ensureSession). */
  private readonly spawnLadder?: SpawnLadder;
  /** The assistant's skills, for a laddered session's skill plugin. */
  private readonly enabledSkills?: string[];
  private readonly excludeBuiltinSkills?: string[];
  /** The laddered skill plugin dir this session uses; removed by kill(). */
  private skillPluginPath?: string;
  /** kill() removed the plugin dir; the next start() rebuilds it. */
  private skillPluginRemoved = false;
  /**
   * The JARVIS autonomy ladder for this agent, resolved once per session in
   * `ensureSession`. `undefined` = no configured rung = today's behaviour.
   */
  private autonomy?: ToolFilterSpawnAutonomy;
  /** The mode a laddered session must run in (already clamped to its rung). */
  private ladderedMode?: string;
  /**
   * Whether the agent has CONFIRMED the laddered mode. False until the first
   * strict apply, and again whenever the agent reports a mode outside the
   * rung (e.g. the Claude bridge rebuilt its query from the user's
   * `defaultMode`). While false the permission gate refuses every write.
   */
  private ladderedModeConfirmed = false;
  /** Set when the agent's initialize result is not a bridge verified for the ladder. */
  private ladderedBridgeProblem?: string;

  // Cached state from callbacks
  private cachedModelInfo: AcpModelInfo | null = null;
  private cachedConfigOptions: AcpSessionConfigOption[] = [];
  private cachedModes: ModeSnapshot | null = null;
  private lastSessionId: string | null = null;
  private lastStatus: SessionStatus = 'idle';
  // Most recent error signal message, captured so a failed start rejects with the
  // engine's real reason rather than a generic string (#483/#369). Set by the
  // onSignal 'error' handler (which fires just before status flips to 'error')
  // and cleared when a new start begins or the session reaches 'active'.
  private lastErrorMessage: string | null = null;

  // Stable msg_id for the CURRENT error/crash episode. The renderer upserts
  // stream messages by msg_id (Messages/hooks.ts), so a unique id per emission
  // (the old `signal_${Date.now()}`) made every retry crash a NEW transcript row
  // — a start-retry storm (maxStartRetries) flooded the chat with identical
  // "process exited unexpectedly" banners (#676). Reusing one id across a burst
  // collapses them into a single, upserted banner (mirrors the agent_status fix
  // that uses `status_${conversationId}`). It is reset on forward progress (a new
  // turn, the session reaching 'active', or a turn finishing) so a later,
  // unrelated error still gets its own banner instead of overwriting an old one.
  private errorBannerId: string | null = null;
  // Monotonic episode counter so each new episode's id is unique even when two
  // episodes open within the same millisecond (a Date.now() suffix could collide).
  private errorEpisodeSeq = 0;

  // Promise bridges for async methods (Tasks 4-6)
  private startOp: PendingOp<void> | null = null;
  private modelOp: PendingOp<AcpModelInfo | null> | null = null;
  private modeOp: PendingOp<{ success: boolean; error?: string }> | null = null;
  private configOp: PendingOp<AcpSessionConfigOption[]> | null = null;

  // Tool call merge state (compat concern - MessageTranslator is stateless)
  private activeToolCalls = new Map<string, IMessageAcpToolCall>();
  // Auth retry guard - prevent infinite auth loops
  private authRetryAttempted = false;
  // Serialize concurrent capability cache writes across backends
  private static cacheQueue: Promise<void> = Promise.resolve();
  // Claude: inject model identity notice into next prompt after setModel
  private pendingModelSwitchNotice: string | null = null;
  // Persistent user model override - never cleared once set (mirrors V1).
  // Used to re-assert model before every prompt in case CLI loses state
  // (e.g. Claude internal compaction resets model to default).
  private userModelOverride: string | null = null;
  // Self-healing replay: set when ensureSession detects a wrapper-version
  // mismatch and forces a fresh session. Drained on the next sendMessage
  // so the agent recovers prior conversation context transparently.
  private pendingReplayContext: string | null = null;

  constructor(config: OldAcpAgentConfig) {
    this.conversationId = config.id;
    this.onStreamEvent = config.onStreamEvent as (data: IResponseMessage) => void;
    this.onSignalEvent = config.onSignalEvent as ((data: IResponseMessage) => void) | undefined;
    this.onSessionIdUpdate = config.onSessionIdUpdate;
    this.onAvailableCommandsUpdate = config.onAvailableCommandsUpdate;
    this.onMcpProjection = config.onMcpProjection;
    this.mcpPublicationBinding = (config as { mcpPublication?: McpSessionPublicationBinding }).mcpPublication;
    this.customAgentId = config.extra?.autonomyAgentId ?? config.extra?.customAgentId;
    this.spawnLadder = config.extra?.spawnAutonomy;
    this.enabledSkills = config.extra?.enabledSkills;
    this.excludeBuiltinSkills = config.extra?.excludeBuiltinSkills;
    this.agentConfig = toAgentConfig(config);
  }

  /**
   * Resolve the receipt-bound publication identity for the live ACP projection.
   * Prefers the runtime-supplied correlated binding; when absent (e.g. a direct
   * construction with no owning manager) a fresh single-launch identity is minted
   * so publication is still bound to this exact launch rather than stored state.
   */
  private resolveMcpPublication(): McpSessionPublicationBinding {
    if (this.mcpPublicationBinding) return this.mcpPublicationBinding;
    const backend: McpSessionBackend = this.agentConfig.agentBackend === 'codex' ? 'codex-native' : 'acp';
    return {
      generation: randomUUID(),
      conversationId: this.conversationId,
      backend,
      sessionKey: createMcpSessionDigestKey(),
      activeServerIds: this.agentConfig.activeMcpServers,
    };
  }

  /**
   * Create AcpSession (deferred from constructor so authCredentials
   * can be loaded asynchronously from the full shell environment).
   */
  private async ensureSession(): Promise<AcpSession> {
    if (this.session) return this.session;

    // Load credentials from full shell env (survives Gemini's delete process.env.*)
    const creds = await loadAuthCredentials(this.agentConfig.agentBackend, this.agentConfig.env);
    if (creds) {
      (this.agentConfig as { authCredentials?: Record<string, string> }).authCredentials = creds;
    }

    // Wayland's own coordination servers (team / team guide): exempt from the
    // autonomy gate, see `createAutonomyPermissionGate`.
    const internalMcpServers: string[] = this.agentConfig.teamMcpConfig ? [this.agentConfig.teamMcpConfig.name] : [];

    // Inject team-guide MCP server for solo agents (not in team mode) so the
    // agent has the aion_create_team tool available - mirrors AcpAgent.loadBuiltinSessionMcpServers().
    if (!this.agentConfig.teamMcpConfig) {
      if (await shouldInjectTeamGuideMcp(this.agentConfig.agentBackend)) {
        const aionStdioConfig = getTeamGuideStdioConfig();
        if (aionStdioConfig) {
          const guideServer: McpServer = {
            name: aionStdioConfig.name,
            command: aionStdioConfig.command,
            args: aionStdioConfig.args,
            env: [
              ...aionStdioConfig.env,
              { name: 'AION_MCP_BACKEND', value: this.agentConfig.agentBackend },
              { name: 'AION_MCP_CONVERSATION_ID', value: this.conversationId },
            ],
          };
          (this.agentConfig as { presetMcpServers?: McpServer[] }).presetMcpServers = [
            ...(this.agentConfig.presetMcpServers || []),
            guideServer,
          ];
          internalMcpServers.push(guideServer.name);
        }
      }
    }

    // JARVIS autonomy ladder. Resolved BEFORE the MCP projection and the
    // session so the same snapshot drives all three enforcement points: the
    // connector shim, the native-tool permission gate, and the mode clamp.
    // Every path that runs this agent (chat, channel, cron, team) comes through
    // here, so an unattended run is enforced exactly like an attended one.
    // The owning manager already resolved the ladder for this spawn (its Fuigo
    // home and trust follow it); enforce that snapshot rather than a second
    // read that could disagree with it.
    this.autonomy = this.spawnLadder
      ? this.spawnLadder.autonomy
      : await resolveConfiguredSpawnAutonomy({
          backend: this.agentConfig.agentBackend,
          customAgentId: this.customAgentId,
        });
    if (this.autonomy) {
      this.applyAutonomyModeClamp(this.autonomy);
      // Unverified until the agent's initialize result says otherwise.
      const unverified = verifyLadderedBridge(this.agentConfig.agentBackend, undefined);
      this.ladderedBridgeProblem = 'reason' in unverified ? unverified.reason : undefined;
      // Claude Code's own allow rules / defaultMode / hooks would approve calls
      // without ever asking us; start without any setting source. See
      // resolveLadderedSessionMeta.
      // With no setting source the workspace `.claude/skills` is not read, so
      // the assistant's bounded skill set comes as a Wayland-owned plugin.
      await this.applyLadderedSessionMeta();
    }

    // Grok Build keeps its cross-session memory under its own home and reads
    // and edits it through the client fs (see grokFsRoots). Its credentials
    // are never served, laddered or not; a laddered agent gets no extra root.
    if (this.agentConfig.agentBackend === 'grok') {
      const grok = grokFsRoots(this.agentConfig.env);
      const config = this.agentConfig as { readOnlyRoots?: string[]; writableRoots?: string[]; deniedPaths?: string[] };
      config.deniedPaths = grok.deniedPaths;
      config.readOnlyRoots = this.autonomy ? [] : grok.readOnlyRoots;
      config.writableRoots = this.autonomy ? [] : grok.writableRoots;
    }

    // Load and refresh storage-backed connectors now, but defer their transport
    // projection until SessionLifecycle has the live initialize response.
    const shimmedMcpServers: string[] = [];
    const rawMcpServers = await loadRuntimeMcpServers();
    if (rawMcpServers.length > 0) {
      // Attach the CURRENT (refreshed) OAuth bearer so the session connects with
      // a live token rather than the stale one baked into the CLI/engine config
      // at sync time (the "401 invalid token" / silently-dropped-connector cause).
      // Dynamic import: pulling McpService at module-init would create an OAuth
      // init cycle (HybridTokenStorage TDZ); deferring it to call-time avoids that.
      // On failure fall back to the stored headers (no worse than before).
      let freshened = rawMcpServers;
      try {
        const { mcpService } = await import('@process/services/mcpServices/McpService');
        freshened = await mcpService.attachOAuthTokens(freshened);
      } catch (err) {
        console.warn('[AcpAgentV2] attachOAuthTokens failed; using stored MCP headers:', err);
      }
      const binding = this.resolveMcpPublication();
      this.agentConfig.mcpStorageSource = {
        servers: freshened,
        request: {
          publication: {
            generation: binding.generation,
            conversationId: binding.conversationId,
            backend: binding.backend,
            sessionKey: binding.sessionKey,
          },
          activeServerIds: binding.activeServerIds,
          autonomy: this.autonomy,
        },
      };
      // With a ladder every connector the deferred projection publishes goes
      // through the shim. The projection runs later (on the live initialize
      // result), so record every candidate name now: a superset only turns a
      // would-be hold on a same-named backend-loaded server into a denial.
      if (this.autonomy) shimmedMcpServers.push(...freshened.map((server) => server.name));
    }

    // Self-healing replay: if a stored resumeSessionId was created by a different
    // wrapper version than the one we'd run now, the wrapper's loadSession may
    // accept the id but the restored session state is corrupt (verified against
    // @agentclientprotocol/claude-agent-acp 0.29.x → 0.33.x). Bypass the resume
    // path and prepend a textual conversation summary to the next user message
    // so the agent recovers context without any user intervention.
    const currentWrapperVersion = getCurrentWrapperVersion(this.agentConfig.agentBackend);
    const storedWrapperVersion = this.agentConfig.acpWrapperVersion;
    if (
      this.agentConfig.resumeSessionId &&
      currentWrapperVersion &&
      storedWrapperVersion &&
      currentWrapperVersion !== storedWrapperVersion
    ) {
      console.log(
        `[AcpAgentV2] Wrapper version mismatch for conversation ${this.conversationId} ` +
          `(stored=${storedWrapperVersion}, current=${currentWrapperVersion}); ` +
          'creating fresh session with history replay.'
      );
      try {
        this.pendingReplayContext = await buildHistoryReplayContext(this.conversationId);
      } catch (err) {
        console.warn('[AcpAgentV2] Failed to build replay context, proceeding without it:', err);
        this.pendingReplayContext = null;
      }
      // Drop the stale session id so SessionLifecycle takes the createSession path.
      (this.agentConfig as { resumeSessionId?: string }).resumeSessionId = undefined;
    } else if (this.agentConfig.resumeSessionId) {
      // Normal resume attempt (wrapper version unchanged). claude-agent-acp
      // sessions are in-memory and don't survive a process restart, so the
      // stored sessionId may be unloadable. Arm history replay SPECULATIVELY
      // before we try to resume: if loadSession succeeds, SessionLifecycle
      // signals 'session_loaded' and the onSignal handler clears this; if it
      // fails, it signals 'session_recovered' and we keep the replay so the
      // first prompt against the fresh session restores context. Awaited here
      // (before session.start) so it is ready before any prompt is consumed.
      try {
        this.pendingReplayContext = await buildHistoryReplayContext(this.conversationId);
      } catch (err) {
        console.warn('[AcpAgentV2] Failed to build speculative replay context, proceeding without it:', err);
        this.pendingReplayContext = null;
      }
    }

    const callbacks: SessionCallbacks = this.buildCallbacks();
    const clientFactory = new LegacyConnectorFactory();

    // Resolve prompt timeout: per-backend → global → default (300s)
    const acpConfig = (await ProcessConfig.get('acp.config')) as Record<string, { promptTimeout?: number }> | undefined;
    const backendTimeout = acpConfig?.[this.agentConfig.agentBackend]?.promptTimeout;
    const globalTimeout = await ProcessConfig.get('acp.promptTimeout');
    const timeoutSec = backendTimeout || globalTimeout || 300;
    const promptTimeoutMs = Math.max(30, timeoutSec) * 1000;
    // Ceiling for one tool call; unset keeps the session default (30 min).
    const toolCallTimeoutSec = await ProcessConfig.get('acp.toolCallTimeout');
    const toolCallTimeoutMs = toolCallTimeoutSec ? Math.max(30, toolCallTimeoutSec) * 1000 : undefined;

    const sessionOptions: SessionOptions = {
      promptTimeoutMs,
      toolCallTimeoutMs,
      maxStartRetries: 3,
      maxResumeRetries: 2,
      initialDesired: this.agentConfig.initialDesired,
      onPermissionHoldExpired: (info) => this.reportHoldExpired(info),
      beforePrompt: this.autonomy ? () => this.enforceLadderedMode() : undefined,
      permissionGate: this.autonomy
        ? createAutonomyPermissionGate(this.autonomy, this.agentConfig.agentBackend, {
            internalMcpServers,
            shimmedMcpServers,
            isModeConfirmed: () => this.ladderedModeConfirmed,
          })
        : undefined,
    };

    this.session = new AcpSession(this.agentConfig, clientFactory, callbacks, sessionOptions);

    // Wait for team MCP tools to complete handshake before allowing messages.
    // The stdio script sends mcp_ready with TEAM_AGENT_SLOT_ID after server.connect().
    const teamMcp = this.agentConfig.teamMcpConfig;
    const teamSlotId =
      teamMcp && 'env' in teamMcp
        ? teamMcp.env.find((e: { name: string }) => e.name === 'TEAM_AGENT_SLOT_ID')?.value
        : undefined;
    if (teamSlotId) {
      await waitForMcpReady(teamSlotId, 30_000).catch(() => {
        console.warn('[AcpAgentV2] Team MCP readiness timeout, proceeding anyway');
      });
    }

    return this.session;
  }

  /**
   * Keep a laddered agent out of any mode its rung does not allow (see
   * `clampSessionModeForRung`). Applied to the initial mode and to the blanket
   * client-side auto-approve flag; `setMode` applies it to every later switch.
   *
   * `yoloMode` is cleared outright: it short-circuits inside the resolver AFTER
   * the gate, but SessionLifecycle also uses it to push the backend into its
   * full-auto mode directly, bypassing `setMode` and therefore this clamp.
   */
  private applyAutonomyModeClamp(autonomy: ToolFilterSpawnAutonomy): void {
    const config = this.agentConfig as { yoloMode?: boolean; initialDesired?: AgentConfig['initialDesired'] };
    const requested =
      config.initialDesired?.mode ?? (config.yoloMode ? getFullAutoMode(this.agentConfig.agentBackend) : undefined);
    const clamped = clampSessionModeForRung(requested, autonomy.rung, this.agentConfig.agentBackend);
    if (clamped !== requested) {
      console.warn(
        `[AcpAgentV2] Autonomy rung ${autonomy.rung} (${autonomy.agent}): session mode ${requested ?? '(unset)'} clamped to ${clamped}`
      );
    }
    config.initialDesired = { ...config.initialDesired, mode: clamped };
    config.yoloMode = false;
    this.ladderedMode = clamped;
  }

  /** True when the agent-reported `modeId` is one this session's rung allows. */
  private isLadderedModeAllowed(modeId: string): boolean {
    if (!this.autonomy) return true;
    return clampSessionModeForRung(modeId, this.autonomy.rung, this.agentConfig.agentBackend) === modeId;
  }

  /**
   * Strictly apply the laddered mode before a prompt (the session's
   * `beforePrompt` guard), or FAIL CLOSED: throwing makes the session abort
   * that prompt and enter error with the reason.
   *
   * Fails only on a DEFINITE problem: an unverified bridge, or the agent
   * refusing the mode change - or not answering it within
   * LADDERED_MODE_CONFIRM_TIMEOUT_MS, which counts as a refusal. A session that cannot take a mode change right
   * now is not a refusal (and cannot happen inside the guard, which runs with
   * the session mid-turn).
   */
  private async enforceLadderedMode(): Promise<void> {
    if (!this.autonomy || !this.session) return;
    if (this.ladderedBridgeProblem) {
      this.ladderedModeConfirmed = false;
      throw new AcpSessionError(
        'INVALID_STATE',
        `Autonomy rung ${this.autonomy.rung} (${this.autonomy.agent}): ${this.ladderedBridgeProblem}, so the ladder's settings override cannot be confirmed. The session was stopped instead of running unladdered.`
      );
    }
    const target = this.ladderedMode ?? 'default';
    let applied: string | null;
    try {
      applied = await confirmModeWithin(this.session, target);
    } catch (err) {
      this.ladderedModeConfirmed = false;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AcpSessionError(
        'INVALID_STATE',
        `Autonomy rung ${this.autonomy.rung} (${this.autonomy.agent}): the agent did not accept session mode "${target}" (${reason}). The session was stopped instead of running outside its rung.`
      );
    }
    if (applied === null) {
      this.ladderedModeConfirmed = false;
      throw new AcpSessionError(
        'INVALID_STATE',
        `Autonomy rung ${this.autonomy.rung} (${this.autonomy.agent}): the session could not take a mode change before this prompt; refusing to run it outside its rung.`
      );
    }
    this.ladderedModeConfirmed = true;
  }

  /**
   * The agent reported a mode change. If it left the rung's allowed set, the
   * gate refuses writes from now on. When the session can take a mode change
   * (active, or mid-turn) the laddered mode is re-applied right away;
   * otherwise (starting, resuming, suspended) nothing is killed - the
   * `beforePrompt` guard confirms it before the next prompt is sent. Only a
   * definite refusal by the agent (or no answer within
   * LADDERED_MODE_CONFIRM_TIMEOUT_MS) stops the session.
   */
  private watchLadderedMode(currentModeId: string | null | undefined): void {
    if (!this.autonomy || !currentModeId) return;
    if (this.isLadderedModeAllowed(currentModeId)) return;
    this.ladderedModeConfirmed = false;
    const session = this.session;
    if (!session) return;
    console.warn(
      `[AcpAgentV2] Autonomy rung ${this.autonomy.rung} (${this.autonomy.agent}): agent reported mode ${currentModeId}; re-applying ${this.ladderedMode ?? 'default'}`
    );
    const target = this.ladderedMode ?? 'default';
    void confirmModeWithin(session, target)
      .then((applied) => {
        if (applied !== null && this.session === session) this.ladderedModeConfirmed = true;
      })
      .catch(async (err) => {
        const reason = err instanceof Error ? err.message : String(err);
        await this.kill().catch(() => {});
        this.onSignalEvent?.({
          type: 'error',
          conversation_id: this.conversationId,
          msg_id: `autonomy_mode_${this.conversationId}`,
          data: `Autonomy rung ${this.autonomy?.rung} (${this.autonomy?.agent}): the agent did not accept session mode "${target}" (${reason}). The session was stopped instead of running outside its rung.`,
        });
      });
  }

  /**
   * Put an expired unattended hold in the transcript (#1045).
   *
   * A denial the user cannot distinguish from an ordinary failure leaves most of
   * the problem in place: their automation stopped because it was waiting on
   * them, and nothing says so. Emitted as a `tips` frame - the same out-of-band
   * in-thread notice a missed scheduled run uses - so it is persisted and
   * rendered rather than being a log line nobody reads.
   *
   * The tool's TITLE is included because "which call was held" is the question
   * the user will actually have. Titles are already rendered verbatim in the
   * permission dialog this replaces, so nothing new crosses the boundary.
   */
  private reportHoldExpired(info: { callId: string; title: string; deadlineMs: number; scheduled?: boolean }): void {
    const minutes = Math.max(1, Math.round(info.deadlineMs / 60_000));
    // The confirmation card for this call is now dead: take it down so it
    // cannot be clicked uselessly.
    this.onSignalEvent?.({
      type: 'acp_permission_expired',
      conversation_id: this.conversationId,
      msg_id: info.callId,
      data: { callId: info.callId },
    });
    if (info.scheduled === false) {
      this.onStreamEvent({
        type: 'tips',
        conversation_id: this.conversationId,
        msg_id: `hold_expired_${info.callId}`,
        data: {
          type: 'warning',
          content:
            `"${info.title || 'A tool call'}" was held for your approval by the autonomy ladder` +
            `${this.autonomy ? ` (rung ${this.autonomy.rung})` : ''}. ` +
            `Nobody answered within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was DENIED. ` +
            `Ask the agent to try again if you want to approve it.`,
        },
      } as unknown as IResponseMessage);
      return;
    }
    this.onStreamEvent({
      type: 'tips',
      conversation_id: this.conversationId,
      msg_id: `hold_expired_${info.callId}`,
      data: {
        type: 'warning',
        content:
          `This scheduled run was held waiting for you to approve "${info.title || 'a tool call'}". ` +
          `Nobody answered within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was DENIED and the run continued. ` +
          `Run this conversation yourself to approve it.`,
      },
    } as unknown as IResponseMessage);
  }

  /**
   * Adopt an unattended hold deadline on an already-running session (#1045).
   * No-op before the session exists: `ensureSession` reads the value off
   * `agentConfig` when it builds one.
   */
  setUnattendedHoldDeadlineMs(ms: number | undefined): void {
    (this.agentConfig as { unattendedHoldDeadlineMs?: number }).unattendedHoldDeadlineMs = ms;
    this.session?.setUnattendedHoldDeadlineMs(ms);
  }

  /**
   * Build SessionCallbacks that route new events → old event format
   */
  private buildCallbacks(): SessionCallbacks {
    return {
      onInitialize: (result: unknown) => {
        if (this.autonomy) {
          const verdict = verifyLadderedBridge(this.agentConfig.agentBackend, result);
          this.ladderedBridgeProblem = 'reason' in verdict ? verdict.reason : undefined;
          if (this.ladderedBridgeProblem) this.ladderedModeConfirmed = false;
        }
        this.cacheInitializeResult(result).catch((err) => {
          console.warn('[AcpAgentV2] Failed to cache initialize result:', err);
        });
      },

      onMcpProjection: (projection) => {
        this.onMcpProjection?.(projection);
      },

      onMessage: (message: TMessage) => {
        // Merge tool call updates with their original tool_call before emitting
        const resolved =
          message.type === 'acp_tool_call' ? this.mergeToolCall(message as IMessageAcpToolCall) : message;

        const oldMsg = toResponseMessage(resolved, this.conversationId);
        // Skip empty messages (e.g., filtered available_commands)
        if (oldMsg.type) {
          this.onStreamEvent(oldMsg);
        }

        // Intercept navigation tools → emit preview_open for chrome-devtools preview
        if (message.type === 'acp_tool_call') {
          this.emitPreviewIfNavigation(message as IMessageAcpToolCall);
        }
      },

      onSessionId: (sessionId: string) => {
        this.lastSessionId = sessionId;
        if (this.onSessionIdUpdate) {
          this.onSessionIdUpdate(sessionId);
        }
      },

      onStatusChange: (status: SessionStatus) => {
        this.lastStatus = status;
        this.persistStatus(status);

        // Session made forward progress — end the current error/crash episode so a
        // later, unrelated error surfaces as its own banner (#676).
        if (status === 'active') {
          this.errorBannerId = null;
        }

        // Resolve startOp when reaching active/error
        if (status === 'active' && this.startOp) {
          this.lastErrorMessage = null;
          this.resolveOp(this.startOp, undefined);
          this.startOp = null;
        } else if (status === 'error' && this.startOp) {
          // Surface the engine's real failure reason (captured from the error
          // signal enterError emits just before this status change) instead of a
          // generic "Session failed to start" (#483/#369).
          this.rejectOp(this.startOp, new Error(this.lastErrorMessage ?? 'Session failed to start'));
          this.startOp = null;
        }

        // Emit old-style agent_status event
        if (['active', 'suspended', 'error'].includes(status)) {
          const oldStatusName = this.mapStatusToOldName(status);
          this.onStreamEvent({
            type: 'agent_status',
            conversation_id: this.conversationId,
            // Stable per-conversation id so the renderer upserts (collapses) the
            // status banner instead of appending a new one per spawn. A Date.now()
            // id made every respawn a distinct row, stacking "Active session"
            // banners. The legacy agent used a fixed id; V2 had dropped it.
            msg_id: `status_${this.conversationId}`,
            data: { status: oldStatusName, backend: this.agentConfig.agentBackend },
          });
        }
      },

      onModelUpdate: (model: ModelSnapshot) => {
        const next = toAcpModelInfo(model);

        // The claude-agent-acp bridge periodically emits a model snapshot with an
        // EMPTY model list (notably under subscription/OAuth auth). Adopting it
        // would wipe cachedModelInfo and push an empty acp_model_info to the
        // renderer, reverting the in-chat picker to "Select Model" a moment after
        // a selection (#184). Keep the last good info when the update is empty.
        if (next.availableModels.length === 0 && this.cachedModelInfo?.availableModels.length) {
          if (this.modelOp) {
            this.resolveOp(this.modelOp, this.cachedModelInfo);
            this.modelOp = null;
          }
          return;
        }

        this.cachedModelInfo = next;

        // Resolve modelOp if pending
        if (this.modelOp) {
          this.resolveOp(this.modelOp, this.cachedModelInfo);
          this.modelOp = null;
        }

        // Emit to old stream event
        this.onStreamEvent({
          type: 'acp_model_info',
          conversation_id: this.conversationId,
          msg_id: `model_${Date.now()}`,
          data: this.cachedModelInfo,
        });

        this.persistSessionCapabilities();
      },

      onModeUpdate: (mode: ModeSnapshot) => {
        this.cachedModes = mode;
        this.watchLadderedMode(mode.currentModeId);

        // Resolve modeOp if pending
        if (this.modeOp) {
          this.resolveOp(this.modeOp, { success: true });
          this.modeOp = null;
        }

        this.persistSessionCapabilities();
      },

      onConfigUpdate: (config: ConfigSnapshot) => {
        this.cachedConfigOptions = toAcpConfigOptions(config.configOptions);

        // Resolve configOp if pending
        if (this.configOp) {
          this.resolveOp(this.configOp, this.cachedConfigOptions);
          this.configOp = null;
        }

        // Forward availableCommands to old callback
        if (this.onAvailableCommandsUpdate && config.availableCommands.length > 0) {
          this.onAvailableCommandsUpdate(config.availableCommands);
        }

        this.persistSessionCapabilities();
      },

      onContextUsage: (usage: ContextUsage) => {
        this.onStreamEvent({
          type: 'acp_context_usage',
          conversation_id: this.conversationId,
          msg_id: `usage_${Date.now()}`,
          data: { used: usage.used, size: usage.total, cost: usage.cost, meterId: usage.meterId },
        });
      },

      onPermissionRequest: (data) => {
        if (this.onSignalEvent) {
          this.onSignalEvent({
            type: 'acp_permission',
            conversation_id: this.conversationId,
            msg_id: data.callId,
            data: {
              sessionId: this.lastSessionId ?? '',
              toolCall: {
                toolCallId: data.callId,
                title: data.title,
                kind: data.kind,
                rawInput: data.rawInput,
                status: 'pending',
                content: [],
                locations: data.locations ?? [],
              },
              options: data.options.map((opt) => ({
                optionId: opt.optionId,
                name: opt.label,
                kind: opt.kind,
              })),
              // JARVIS autonomy: held for a person; the manager must not
              // auto-approve it in any mode.
              ...(data.autonomyHold ? { autonomyHold: true } : {}),
            },
          });
        }
      },

      // One question of a Fuigo AskUserQuestion request. Surfaced through the
      // manager's confirmation card (the #504 question card); the answer comes
      // back via answerUserQuestion.
      onUserQuestion: (data) => {
        if (this.onSignalEvent) {
          this.onSignalEvent({
            type: 'acp_user_question',
            conversation_id: this.conversationId,
            msg_id: data.callId,
            data,
          });
        }
      },

      onSignal: (event) => {
        // Retain the real reason so a pending start op can reject with it
        // (#483/#369). enterError emits this signal immediately before the status
        // flips to 'error', so it is set in time for the reject in onStatusChange.
        // Captured before the onSignalEvent guard so it works even when no signal
        // sink is wired (the reject path does not depend on onSignalEvent).
        if (event.type === 'error') {
          this.lastErrorMessage = event.message;
        }

        // A timeout stopped the turn. Sent as a `tips` stream frame so the manager
        // PERSISTS it (a bare `error` signal frame is emitted, never stored, and the
        // reopened chat showed nothing), and as a warning: the turn was stopped,
        // not failed. Its own row, never collapsed into an error episode.
        if (event.type === 'turn_stopped') {
          this.onStreamEvent({
            type: 'tips',
            conversation_id: this.conversationId,
            msg_id: `turn_stopped_${randomUUID()}`,
            data: { content: event.message, type: 'warning' },
          });
          return;
        }

        if (!this.onSignalEvent) return;

        switch (event.type) {
          case 'turn_finished':
            // Forward progress — end the current error/crash episode (#676).
            this.errorBannerId = null;
            this.onSignalEvent({
              type: 'finish',
              conversation_id: this.conversationId,
              msg_id: `finish_${Date.now()}`,
              data: null,
            });
            break;

          case 'session_loaded':
            // Resume succeeded; drop the speculative replay so we don't re-send
            // history the resumed session already has.
            this.pendingReplayContext = null;
            break;

          case 'session_recovered':
            // loadSession failed and SessionLifecycle created a fresh session.
            // The speculative replay armed in ensureSession stays set and is
            // consumed by the in-flight prompt (sendMessage), restoring context.
            // Deliberately emit NO error/finish: the turn continues normally.
            console.log(
              `[AcpAgentV2] Session resume failed for conversation ${this.conversationId}; ` +
                'recovered with a fresh session + history replay.'
            );
            break;

          case 'session_expired':
            this.onSignalEvent({
              type: 'error',
              conversation_id: this.conversationId,
              msg_id: `signal_${Date.now()}`,
              data: 'Session expired',
            });
            // Emit finish signal after session_expired
            this.onSignalEvent({
              type: 'finish',
              conversation_id: this.conversationId,
              msg_id: `finish_${Date.now()}`,
              data: null,
            });
            break;

          case 'auth_required':
            // Temporary: run backend-specific login command, then retry.
            // Will be replaced by authCommand + args when Agent Hub lands (PR #2349).
            void this.handleAuthRequired();
            break;

          case 'error': {
            // Detect process crash from error message keywords to emit agentCrash
            // flag that TeammateManager.handleResponseStream relies on (V1 parity).
            // CRASH_MARKER_TRANSPORT_CLOSE is the #1020 wording for a disconnect
            // with no observed process exit. Without it here a transport drop
            // stopped matching, and the renderer's loading state never cleared.
            const isCrash =
              event.message.includes(CRASH_MARKER_PROCESS_EXIT) ||
              event.message.includes(CRASH_MARKER_TRANSPORT_CLOSE) ||
              event.message.includes('PROCESS_CRASHED') ||
              event.message.includes('Process disconnected');

            // Collapse a burst of error/crash banners (start-retry storm, #676)
            // into ONE upserted transcript row by reusing a stable per-episode
            // msg_id. The id is reset on forward progress (new turn / active /
            // turn_finished), so an unrelated later error still gets its own row.
            this.errorBannerId ??= `error_${this.conversationId}_${++this.errorEpisodeSeq}`;
            this.onSignalEvent({
              type: 'error',
              conversation_id: this.conversationId,
              msg_id: this.errorBannerId,
              data: event.message,
            });

            if (isCrash) {
              this.onSignalEvent({
                type: 'finish',
                conversation_id: this.conversationId,
                msg_id: `finish_crash_${Date.now()}`,
                data: {
                  error: event.message,
                  agentCrash: true,
                },
              });
            }
            break;
          }
        }
      },
    };
  }

  /**
   * Merge tool_call_update into existing tool_call to produce a complete message.
   * The renderer does full replacement by toolCallId, so we must preserve fields
   * (title, kind, etc.) that partial updates don't include.
   */
  private mergeToolCall(message: IMessageAcpToolCall): IMessageAcpToolCall {
    const toolCallId = message.content?.update?.toolCallId;
    if (!toolCallId) return message;

    const existing = this.activeToolCalls.get(toolCallId);
    if (!existing) {
      // First time seeing this toolCallId - store and pass through
      this.activeToolCalls.set(toolCallId, message);
      return message;
    }

    // Merge: new fields override, missing fields preserved from existing
    const merged: IMessageAcpToolCall = {
      ...existing,
      msg_id: toolCallId,
      status: message.status,
      content: {
        ...existing.content,
        update: {
          ...existing.content.update,
          ...message.content.update,
          // Only override non-fallback values
          title:
            message.content.update.title !== 'unknown' ? message.content.update.title : existing.content.update.title,
          kind: message.content.update.kind !== 'execute' ? message.content.update.kind : existing.content.update.kind,
          content: message.content.update.content ?? existing.content.update.content,
          rawInput: message.content.update.rawInput ?? existing.content.update.rawInput,
        },
      },
    };

    this.activeToolCalls.set(toolCallId, merged);

    // Clean up completed/failed tool calls after a delay
    if (message.content.update.status === 'completed' || message.content.update.status === 'failed') {
      setTimeout(() => this.activeToolCalls.delete(toolCallId), 60_000);
    }

    return merged;
  }

  /**
   * Map new 7-state FSM to old status names
   */
  /** Persist status: 7 in-memory states → 4 stable DB states. */
  private persistStatus(_status: SessionStatus): void {
    // TODO(ACP Discovery): Re-enable after fixing agent_id.
    // const stable = this.toStableStatus(status);
    // const suspendedAt = status === 'suspended' ? Date.now() : null;
    // this.acpSessionRepo?.updateStatus(this.conversationId, stable, suspendedAt);
  }

  private toStableStatus(status: SessionStatus): 'idle' | 'active' | 'suspended' | 'error' {
    switch (status) {
      case 'idle':
        return 'idle';
      case 'starting':
      case 'active':
      case 'prompting':
      case 'resuming':
        return 'active';
      case 'suspended':
        return 'suspended';
      case 'error':
        return 'error';
    }
  }

  private mapStatusToOldName(status: SessionStatus): string {
    switch (status) {
      case 'idle':
        return 'disconnected';
      case 'starting':
        return 'connecting';
      case 'active':
        return 'session_active';
      case 'prompting':
        return 'session_active';
      case 'suspended':
        return 'disconnected';
      case 'resuming':
        return 'connecting';
      case 'error':
        return 'error';
      default:
        console.warn(`[AcpAgentV2] Unrecognized status: ${status}`);
        return 'disconnected';
    }
  }

  // ─── Public Getters ─────────────────────────────────────────────

  get isConnected(): boolean {
    return this.lastStatus !== 'idle' && this.lastStatus !== 'error';
  }

  get hasActiveSession(): boolean {
    return this.lastStatus === 'active' || this.lastStatus === 'prompting';
  }

  get currentSessionId(): string | null {
    return this.lastSessionId;
  }

  // ─── Lifecycle Methods (Task 4) ────────────────────────────────

  async start(): Promise<void> {
    // Clear any stale error from a prior attempt so this start rejects only with
    // its own failure reason (#483/#369).
    this.lastErrorMessage = null;
    const session = await this.ensureSession();
    // A reconnect after kill(): the skill plugin dir was removed with the old
    // process, so rebuild it before the session starts again.
    if (this.skillPluginRemoved && this.autonomy) await this.applyLadderedSessionMeta();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.startOp = null;
        reject(new Error('Session start timed out'));
      }, SESSION_START_TIMEOUT_MS);
      this.startOp = { resolve, reject, timer };
      session.start();
    });
  }

  /**
   * The laddered skill plugin for this conversation (see buildLadderedSkillPlugin).
   * A failure only costs the skills: the session still starts, still laddered.
   */
  private async buildLadderedSkillPlugin(): Promise<Awaited<ReturnType<typeof buildLadderedSkillPlugin>>> {
    try {
      return await buildLadderedSkillPlugin({
        backend: this.agentConfig.agentBackend,
        sessionKey: this.conversationId,
        enabledSkills: this.enabledSkills,
        excludeBuiltinSkills: this.excludeBuiltinSkills,
      });
    } catch (error) {
      console.error('[AcpAgentV2] laddered skill plugin not built; the session starts without its skills:', error);
      return undefined;
    }
  }

  /**
   * (Re)build the skill plugin and set the laddered session `_meta`: no setting
   * sources, the plugin, and the skill-name mapping in the system prompt. The
   * session reads `agentConfig.sessionMeta` on every session/new and load.
   */
  private async applyLadderedSessionMeta(): Promise<void> {
    const skillPlugin = await this.buildLadderedSkillPlugin();
    // Every build is a new dir; one this session built earlier and still holds
    // is its own to drop (never another session's).
    const previous = this.skillPluginPath;
    this.skillPluginPath = skillPlugin?.path;
    this.skillPluginRemoved = false;
    if (previous && previous !== skillPlugin?.path) {
      await removeLadderedSkillPlugin(previous).catch((error: unknown) =>
        console.warn('[AcpAgentV2] could not remove the previous laddered skill plugin:', error)
      );
    }
    if (this.agentConfig.agentBackend === 'fuigo') {
      // Fuigo: the plugin REPLACES the `<workspace>/.wayland` staging as the
      // only `_meta.pluginDirs` entry (an empty list when it could not be
      // built - never the staged copies, which keep frontmatter such as
      // `allowed-tools`). Fuigo reads skill files through fs/read_text_file,
      // so the plugin dir is readable (only) for this session.
      const dirs = skillPlugin ? [skillPlugin.path] : [];
      const config = this.agentConfig as { sessionMeta?: Record<string, unknown>; readOnlyRoots?: string[] };
      config.sessionMeta = { pluginDirs: dirs };
      config.readOnlyRoots = dirs;
      return;
    }
    const meta = await resolveLadderedSessionMeta(
      this.agentConfig.agentBackend,
      skillPlugin ? ladderedSkillPluginOption(skillPlugin.path) : {},
      this.agentConfig.env?.CLAUDE_CONFIG_DIR
    );
    if (meta) {
      (this.agentConfig as { sessionMeta?: Record<string, unknown> }).sessionMeta = withLadderedSkillPrompt(
        meta,
        skillPlugin?.skills ?? []
      );
    }
  }

  async kill(): Promise<void> {
    await this.session?.stop();
    this.activeToolCalls.clear();
    // The session's process is gone: drop its skill plugin dir (rebuilt by the
    // next start() if this agent reconnects).
    if (this.skillPluginPath) {
      const dir = this.skillPluginPath;
      this.skillPluginPath = undefined;
      this.skillPluginRemoved = true;
      await removeLadderedSkillPlugin(dir).catch((error: unknown) =>
        console.warn('[AcpAgentV2] could not remove the laddered skill plugin:', error)
      );
    }
  }

  cancelPrompt(): void {
    this.session?.cancelPrompt();
  }

  pausePrompt(): void {
    this.session?.pausePrompt();
  }

  // ─── Messaging + Permission Methods (Task 5) ───────────

  async sendMessage(data: { content: string; files?: string[]; msg_id?: string }): Promise<AcpResult> {
    try {
      // A new user turn starts a fresh error/crash episode (#676) so a failure
      // here surfaces as its own banner rather than overwriting a prior one.
      this.errorBannerId = null;
      // Auto-reconnect if session is in error/idle state (mirrors V1 behavior).
      // V1 checks isConnected/hasActiveSession before every prompt and calls start().
      if (this.lastStatus === 'error' || this.lastStatus === 'idle') {
        try {
          await this.kill();
          await this.start();
        } catch (reconnectError) {
          const errorMsg = reconnectError instanceof Error ? reconnectError.message : String(reconnectError);
          return {
            success: false,
            error: {
              type: AcpErrorType.CONNECTION_NOT_READY,
              code: 'CONNECTION_FAILED',
              message: `Failed to reconnect: ${errorMsg}`,
              retryable: true,
            },
          };
        }
      }

      // Reject while session is still booting - caller should retry after
      // the status transitions to active (onStatusChange fires agent_status).
      if (this.lastStatus === 'starting' || this.lastStatus === 'resuming') {
        return {
          success: false,
          error: {
            type: AcpErrorType.CONNECTION_NOT_READY,
            code: 'SESSION_NOT_READY',
            message: `Session is ${this.lastStatus}, please retry shortly`,
            retryable: true,
          },
        };
      }

      // Emit start event via stream channel so AcpAgentManager.handleStreamEvent
      // can emit request_trace (which checks message.type === 'start')
      if (this.onStreamEvent) {
        this.onStreamEvent({
          type: 'start',
          data: null,
          msg_id: data.msg_id ?? `start_${Date.now()}`,
          conversation_id: this.conversationId,
        });
      }

      // Claude: inject model switch notice so the AI knows its identity changed.
      // In terminal "/model X" outputs into conversation; ACP set_model is silent.
      let content = data.content;

      // Self-healing replay: if ensureSession dropped a stale-wrapper resume id,
      // prepend the locally-rebuilt conversation history so the agent recovers
      // context on its first turn against the fresh session.
      if (this.pendingReplayContext) {
        content = this.pendingReplayContext + '\n[CURRENT MESSAGE]\n' + content;
        this.pendingReplayContext = null;
      }

      if (this.pendingModelSwitchNotice) {
        content =
          `<system-reminder>\n` +
          `Model switch: The active model has been changed to ${this.pendingModelSwitchNotice} via the /model command. ` +
          `You are now running as ${this.pendingModelSwitchNotice}. ` +
          `The ANTHROPIC_MODEL environment variable and the earlier "You are powered by" text in the system prompt are stale (cached from session start) and no longer reflect the actual model. ` +
          `When asked which model you are, answer ${this.pendingModelSwitchNotice}.\n` +
          `</system-reminder>\n\n` +
          content;
        this.pendingModelSwitchNotice = null;
      }

      // Re-assert model override before every prompt (mirrors V1 behavior).
      // V1's userModelOverride is never cleared - it re-checks on every prompt
      // to recover from CLI-internal state loss (e.g. Claude compaction).
      // EXCEPT a Flux id: it is carried by the spawn env (ANTHROPIC_MODEL=
      // flux-auto) and pushing it through set_model makes the claude binary
      // reject it (JSON-RPC -32601). Skip the re-assert for Flux ids (mirrors V1)
      // - unless the engine is Flux-native (fuigo), where the tier IS a catalog
      // model and the re-assert is what keeps it pinned across the engine's own
      // compaction/rebuild.
      if (
        this.userModelOverride &&
        (!isFluxModelId(this.userModelOverride) || isFluxNativeBackend(this.agentConfig.agentBackend)) &&
        this.session
      ) {
        const currentModel = this.cachedModelInfo?.currentModelId;
        if (currentModel !== this.userModelOverride) {
          try {
            this.session.setModel(this.userModelOverride);
          } catch {
            // best effort - continue even if re-assert fails
          }
        }
      }

      if (!this.session) {
        throw new AcpSessionError('INVALID_STATE', 'Session not available after reconnect');
      }
      // JARVIS autonomy: a Fuigo slash command at the head of a prompt is run
      // by the engine, not the model. `/always-approve on` silences every
      // permission request (measured on 1.0.19) and `/plugins add|trust` loads
      // code and MCP servers - neither may reach a laddered session, whoever
      // typed or relayed it.
      if (this.autonomy && this.agentConfig.agentBackend === 'fuigo' && LADDERED_FUIGO_REFUSED_COMMAND.test(content)) {
        throw new AcpSessionError(
          'INVALID_STATE',
          `Autonomy rung ${this.autonomy.rung} (${this.autonomy.agent}): engine commands that change approvals or plugins are not available to a laddered agent.`
        );
      }
      // JARVIS autonomy: the laddered mode is confirmed by the session's
      // `beforePrompt` guard right before EVERY prompt it sends - this one, or
      // one it queued while starting/resuming/suspended or mid-turn.
      await this.session.sendMessage(content, data.files);
      return { success: true, data: null };
    } catch (err) {
      let errorType = err instanceof AcpSessionError ? mapAcpErrorCodeToType(err.code) : AcpErrorType.UNKNOWN;
      let errorMessage = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof AcpSessionError ? err.retryable : false;

      // Qwen backend: enhance "Internal error" with actionable troubleshooting steps
      if (this.agentConfig.agentBackend === 'qwen' && errorMessage.includes('Internal error')) {
        errorType = AcpErrorType.AUTHENTICATION_FAILED;
        errorMessage =
          'Qwen ACP Internal Error: This usually means authentication failed or ' +
          'the Qwen CLI has compatibility issues. Please try: 1) Restart the application ' +
          '2) Use the packaged bun launcher instead of a global qwen install ' +
          '3) Check if you have valid Qwen credentials.';
      }

      // Emit finish signal to reset frontend loading state and Manager turn tracking.
      // Without this the UI stays in loading state until the 15s
      // missingFinishFallbackTimer fires. PromptExecutor.handlePromptError
      // re-throws without emitting turn_finished, so no duplicate.
      this.onSignalEvent?.({
        type: 'finish',
        conversation_id: this.conversationId,
        msg_id: `finish_${Date.now()}`,
        data: null,
      });

      return {
        success: false,
        error: {
          type: errorType,
          code: err instanceof AcpSessionError ? err.code : 'UNKNOWN',
          message: errorMessage,
          retryable,
        },
      };
    }
  }

  /** Answer (or cancel, with `null`) one question of a Fuigo AskUserQuestion request. */
  answerUserQuestion(callId: string, answer: string | null): boolean {
    return this.session?.answerUserQuestion(callId, answer) ?? false;
  }

  async confirmMessage(data: { confirmKey: string; callId: string }): Promise<AcpResult> {
    try {
      this.session!.confirmPermission(data.callId, data.confirmKey);
      return { success: true, data: null };
    } catch (err) {
      return {
        success: false,
        error: {
          type: AcpErrorType.UNKNOWN,
          code: 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      };
    }
  }

  // ─── Config/Model/Mode Methods (Task 6 - partial) ──────────────

  getModelInfo(): AcpModelInfo | null {
    // Claude: prefer cc-switch model source for accurate model names and slot mapping
    if (this.agentConfig.agentBackend === 'claude') {
      const ccSwitchInfo = readClaudeModelInfoFromCcSwitch();
      if (ccSwitchInfo) {
        // If user has overridden the model via setModel, apply it to cc-switch data
        const currentId = this.cachedModelInfo?.currentModelId;
        if (currentId && ccSwitchInfo.availableModels?.some((m) => m.id === currentId)) {
          const selected = ccSwitchInfo.availableModels.find((m) => m.id === currentId);
          return {
            ...ccSwitchInfo,
            currentModelId: currentId,
            currentModelLabel: selected?.label ?? currentId,
          };
        }
        return ccSwitchInfo;
      }
      // Claude Code's ACP wrapper never advertises a switchable model list, so
      // cachedModelInfo stays null and the picker is stuck on "Select Model"
      // (#184). Fall back to the static Sonnet/Opus/Haiku slots (applied via
      // --model / ANTHROPIC_MODEL on (re)spawn) so the user can pick a model.
      if (!this.cachedModelInfo || this.cachedModelInfo.availableModels.length === 0) {
        return buildClaudeSlotModelInfo(this.userModelOverride ?? this.cachedModelInfo?.currentModelId);
      }
      return this.cachedModelInfo;
    }

    // Non-claude ACP backends (codex, qwen, …): a background model event / poll
    // overwrites cachedModelInfo with the agent's DEFAULT after a turn, which
    // drops the user's in-chat pick (userModelOverride) — the same revert #136/
    // #146/#149 fixed for claude, but claude was the only backend the override
    // was honored for. When we hold an override the cached list still offers (or
    // the list is empty), report the override instead of the reverted default so
    // a codex pick sticks. Flux ids ride the spawn env and are surfaced by the
    // renderer's flux pin, so they are intentionally not overlaid here - except
    // on a Flux-native engine (fuigo), whose catalog lists the tiers and whose
    // pick is therefore an ordinary override like any other.
    const override = this.userModelOverride;
    const cached = this.cachedModelInfo;
    const overlayable = !isFluxModelId(override) || isFluxNativeBackend(this.agentConfig.agentBackend);
    if (override && overlayable && cached && cached.currentModelId !== override) {
      const models = cached.availableModels ?? [];
      if (models.length === 0 || models.some((m) => m.id === override)) {
        const selected = models.find((m) => m.id === override);
        return {
          ...cached,
          currentModelId: override,
          currentModelLabel: selected?.label ?? override,
        };
      }
    }
    return this.cachedModelInfo;
  }

  getConfigOptions(): AcpSessionConfigOption[] {
    return this.cachedConfigOptions.filter((opt) => opt.category !== 'model' && opt.category !== 'mode');
  }

  async setModelByConfigOption(modelId: string): Promise<AcpModelInfo | null> {
    this.userModelOverride = modelId;
    // A Flux id is carried by the spawn env (ANTHROPIC_MODEL/OPENAI_MODEL=
    // flux-auto), not by an in-place set_model. Pushing it through the bridge
    // makes the claude binary validate it against its catalog and reject it
    // (JSON-RPC -32601). Record the override and skip the call (mirrors V1).
    // A Flux-native engine (fuigo) advertises the tiers in its catalog, so for
    // it the call below is the only thing that changes the tier that runs.
    if (isFluxModelId(modelId) && !isFluxNativeBackend(this.agentConfig.agentBackend)) {
      return this.cachedModelInfo;
    }
    // Queue model switch notice for Claude (ACP set_model is silent, AI doesn't know)
    if (this.agentConfig.agentBackend === 'claude') {
      this.pendingModelSwitchNotice = modelId;
    }
    return new Promise<AcpModelInfo | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modelOp = null;
        // Timeout fallback: return current cached info
        resolve(this.cachedModelInfo);
      }, 10_000);
      this.modelOp = { resolve, reject, timer };
      this.session!.setModel(modelId);
    });
  }

  /**
   * `effectiveMode` is set when the autonomy ladder clamped the request: it is
   * the mode the session is actually in, so the caller can show that rather
   * than the one it asked for.
   */
  async setMode(requestedMode: string): Promise<{ success: boolean; error?: string; effectiveMode?: string }> {
    let mode = requestedMode;
    if (this.autonomy) {
      mode = clampSessionModeForRung(requestedMode, this.autonomy.rung, this.agentConfig.agentBackend);
      // Whatever the outcome, this is the mode every later turn is held to.
      this.ladderedMode = mode;
      if (mode !== requestedMode && this.autonomy.rung <= 2) {
        // Below rung 3 the requested mode is refused outright, and the session
        // is (re)asserted into the clamped one so it can never drift there.
        this.session?.setMode(mode);
        return {
          success: false,
          error: `Autonomy rung ${this.autonomy.rung} does not allow session mode "${requestedMode}" for ${this.autonomy.agent}.`,
          effectiveMode: mode,
        };
      }
    }
    const result = await new Promise<{ success: boolean; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.modeOp = null;
        resolve({ success: true }); // Optimistic timeout
      }, 10_000);
      this.modeOp = { resolve, reject, timer };
      this.session!.setMode(mode);
    });
    return mode === requestedMode ? result : { ...result, effectiveMode: mode };
  }

  async setConfigOption(configId: string, value: string): Promise<AcpSessionConfigOption[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configOp = null;
        resolve(this.cachedConfigOptions); // Fallback to cached
      }, 10_000);
      this.configOp = { resolve, reject, timer };
      this.session!.setConfigOption(configId, value);
    });
  }

  async enableYoloMode(): Promise<void> {
    await this.setMode(getFullAutoMode(this.agentConfig.agentBackend));
  }

  // ─── Helper Methods ─────────────────────────────────────────────

  /**
   * Check if an acp_tool_call is a navigation tool (chrome-devtools) and emit
   * a preview_open event so the URL shows in the preview panel.
   */
  private emitPreviewIfNavigation(message: IMessageAcpToolCall): void {
    const title = message.content?.update?.title;
    const rawInput = message.content?.update?.rawInput as Record<string, unknown> | undefined;
    if (!title) return;

    if (!NavigationInterceptor.isNavigationTool(title)) return;

    const url = NavigationInterceptor.extractUrl({ arguments: rawInput });
    if (!url) return;

    const previewMsg = NavigationInterceptor.createPreviewMessage(url, this.conversationId);
    this.onStreamEvent(previewMsg);
  }

  /**
   * Temporary auth recovery: run backend CLI login command, then retry session.
   *
   * Claude Code doesn't support ACP's authenticate() method - it requires
   * `claude /login` to refresh OAuth tokens. The non-official ACP bridge
   * (claude-agent-acp) can't do this itself.
   *
   * Will be replaced by `authCommand + args` config when Agent Hub lands (PR #2349).
   */
  private async handleAuthRequired(): Promise<void> {
    // Guard: only attempt login once to prevent infinite loops
    // (e.g., expired AWS SSO that can't be refreshed non-interactively)
    if (this.authRetryAttempted) {
      console.warn('[AcpAgentV2] Auth already retried once, giving up');
      this.onSignalEvent?.({
        type: 'error',
        conversation_id: this.conversationId,
        msg_id: `signal_${Date.now()}`,
        data: 'Authentication failed after retry. Please authenticate manually and restart.',
      });
      return;
    }
    this.authRetryAttempted = true;

    const backend = this.agentConfig.agentBackend;
    try {
      await runBackendLogin(backend, this.agentConfig.command, this.agentConfig.launch);
      // Reload credentials from env after login refreshes tokens
      const creds = await loadAuthCredentials(backend, this.agentConfig.env);
      this.session?.retryAuth(creds ?? undefined);
    } catch (err) {
      console.warn(`[AcpAgentV2] ${backend} auth refresh failed:`, err);
      this.onSignalEvent?.({
        type: 'error',
        conversation_id: this.conversationId,
        msg_id: `signal_${Date.now()}`,
        data: `Authentication failed for ${backend}. Please authenticate manually and restart.`,
      });
    }
  }

  private resolveOp<T>(op: PendingOp<T>, value: T): void {
    clearTimeout(op.timer);
    op.resolve(value);
  }

  private rejectOp<T>(op: PendingOp<T>, err: Error): void {
    clearTimeout(op.timer);
    op.reject(err);
  }

  /**
   * Persist initialize result to disk so team MCP, MCP filtering, and other
   * consumers can read agent capabilities before an active session exists.
   */
  private async cacheInitializeResult(initResult: unknown): Promise<void> {
    const backend = this.agentConfig.agentBackend;
    const cached = (await ProcessConfig.get('acp.cachedInitializeResult')) || {};
    await ProcessConfig.set('acp.cachedInitializeResult', {
      ...cached,
      [backend]: parseInitializeResult(initResult),
    });
  }

  /**
   * Persist session capabilities to disk so Guid page / selectors can render
   * from cache before an active session exists. Uses a static queue to
   * serialize writes when multiple backends start concurrently.
   */
  private persistSessionCapabilities(): void {
    const backend = this.agentConfig.agentBackend;
    const modelInfo = this.cachedModelInfo;
    const configOptions = this.cachedConfigOptions;
    const modes = this.cachedModes;

    const job = AcpAgentV2.cacheQueue.then(async () => {
      if (modelInfo && modelInfo.availableModels && modelInfo.availableModels.length > 0) {
        const cached = (await ProcessConfig.get('acp.cachedModels')) || {};
        const existing = cached[backend];
        await ProcessConfig.set('acp.cachedModels', {
          ...cached,
          [backend]: {
            ...modelInfo,
            // Preserve the original default model from the first session
            currentModelId: existing?.currentModelId ?? modelInfo.currentModelId,
            currentModelLabel: existing?.currentModelLabel ?? modelInfo.currentModelLabel,
          },
        });
      }

      if (configOptions.length > 0) {
        const cached = (await ProcessConfig.get('acp.cachedConfigOptions')) || {};
        await ProcessConfig.set('acp.cachedConfigOptions', {
          ...cached,
          [backend]: configOptions,
        });
      }

      if (modes && modes.availableModes.length > 0) {
        const cached = (await ProcessConfig.get('acp.cachedModes')) || {};
        await ProcessConfig.set('acp.cachedModes', {
          ...cached,
          [backend]: {
            currentModeId: modes.currentModeId ?? undefined,
            availableModes: modes.availableModes.map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description,
            })),
          },
        });
      }
    });
    AcpAgentV2.cacheQueue = job.catch(() => {});
  }
}
