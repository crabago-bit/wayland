/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 * Modified by Ferrox Labs in 2026. Changes are documented in the project history.
 */

import type { ConversationSideQuestionResult } from '@/common/adapter/ipcBridge';
import { isSideQuestionSupported } from '@/common/chat/sideQuestion';
import type { TChatConversation } from '@/common/config/storage';
import type { AcpBackend } from '@/common/types/acpTypes';
import { ACP_BACKENDS_ALL } from '@/common/types/acpTypes';
import type { AcpClient } from '@process/acp/infra/IAcpClient';
import { LegacyConnectorFactory } from '@process/acp/compat/LegacyConnectorFactory';
import type { IConversationService } from '@process/services/IConversationService';
import { ProcessConfig } from '@process/utils/initStorage';
import { resolveConfiguredSpawnAutonomy, resolveLadderedSessionMeta } from '@process/services/jarvis/sessionAutonomy';
import {
  buildLadderedSkillPlugin,
  ladderedSkillPluginOption,
  removeLadderedSkillPlugin,
} from '@process/services/jarvis/ladderedSkillPlugin';

const ACP_SIDE_QUESTION_TIMEOUT_MS = 30_000;

type ResolvedAcpContext = {
  /**
   * JARVIS autonomy: `_meta` for the fork when the conversation's agent is on
   * the ladder - no user/unsafe-project settings and no tools, so a /btw side
   * question can never run with the user's Claude Code allow list.
   */
  forkMeta?: Record<string, unknown>;
  /** The laddered fork's own skill plugin dir, removed when the fork is done. */
  skillPluginDir?: string;
  acpSessionId: string;
  backend: AcpBackend;
  cliPath?: string;
  customEnv?: Record<string, string>;
  customArgs?: string[];
  workspace: string;
};

class AcpSideQuestionUnsupportedError extends Error {}
class AcpSideQuestionFailedError extends Error {}

export class ConversationSideQuestionService {
  constructor(private readonly conversationService: IConversationService) {}

  async ask(conversationId: string, question: string): Promise<ConversationSideQuestionResult> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      return { status: 'invalid', reason: 'emptyQuestion' };
    }

    const conversation = await this.conversationService.getConversation(conversationId);
    if (!conversation) {
      return { status: 'unsupported' };
    }

    const backend = conversation.type === 'acp' ? conversation.extra.backend : undefined;
    if (!isSideQuestionSupported({ type: conversation.type, backend })) {
      return { status: 'unsupported' };
    }

    const resolvedAcpContext = await this.resolveAcpSideQuestionContext(conversation);
    if (resolvedAcpContext) {
      try {
        const result = await this.askWithAcpFork(conversationId, trimmedQuestion, resolvedAcpContext);
        if (result.toolsAttempted && !result.answer) {
          return { status: 'toolsRequired' };
        }
        if (!result.answer) {
          return { status: 'noAnswer' };
        }
        return {
          status: 'ok',
          answer: result.answer,
        };
      } catch (caughtError) {
        if (caughtError instanceof AcpSideQuestionUnsupportedError) {
          return { status: 'unsupported' };
        }
        throw caughtError;
      } finally {
        if (resolvedAcpContext.skillPluginDir) {
          await removeLadderedSkillPlugin(resolvedAcpContext.skillPluginDir).catch(() => {});
        }
      }
    }

    return { status: 'unsupported' };
  }

  private async askWithAcpFork(
    conversationId: string,
    question: string,
    context: ResolvedAcpContext
  ): Promise<{ answer: string; toolsAttempted: boolean }> {
    let answer = '';
    let toolsWereAttempted = false;
    let forkedSessionId = '';

    // Reference to client, captured by handlers below and set after creation.
    let clientRef: AcpClient | null = null;

    const factory = new LegacyConnectorFactory();
    const client = factory.create(
      {
        agentBackend: context.backend,
        agentSource: 'builtin',
        agentId: `btw-${conversationId}`,
        cwd: context.workspace,
        command: context.cliPath,
        args: context.customArgs,
        env: context.customEnv,
      },
      {
        onSessionUpdate: (notification) => {
          const update = notification.update;
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            answer += update.content.text || '';
            return;
          }
          if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            console.warn('[ConversationSideQuestionService] ACP /btw cancelled due to tool activity', {
              backend: context.backend,
              conversationId,
              update: update.sessionUpdate,
            });
            toolsWereAttempted = true;
            if (forkedSessionId && clientRef) {
              void clientRef.cancel(forkedSessionId).catch(() => {});
            }
          }
        },
        onRequestPermission: async (request) => {
          console.warn('[ConversationSideQuestionService] ACP /btw rejected permission request', {
            backend: context.backend,
            conversationId,
            tool: request.toolCall.title,
          });
          toolsWereAttempted = true;
          if (forkedSessionId && clientRef) {
            void clientRef.cancel(forkedSessionId).catch(() => {});
          }
          const rejectOption = request.options.find((o) => o.kind.startsWith('reject'));
          return {
            outcome: {
              outcome: 'selected' as const,
              optionId: rejectOption?.optionId || 'reject_once',
            },
          };
        },
        onReadTextFile: () => Promise.resolve({ content: '' }),
        onWriteTextFile: () => Promise.resolve({}),
      }
    );
    clientRef = client;

    client.onDisconnect((info) => {
      console.warn('[ConversationSideQuestionService] ACP /btw runner disconnected unexpectedly', {
        backend: context.backend,
        conversationId,
        reason: info.reason,
        exitCode: info.exitCode,
      });
    });

    try {
      await this.runWithTimeout(
        (async () => {
          await client.start();

          let forkResult;
          try {
            forkResult = await client.forkSession({
              sessionId: context.acpSessionId,
              cwd: context.workspace,
              mcpServers: [],
              ...(context.forkMeta ? { meta: context.forkMeta } : {}),
            });
          } catch {
            throw new AcpSideQuestionUnsupportedError('ACP forked side questions are not supported for this backend.');
          }
          forkedSessionId = forkResult.sessionId;

          await client.prompt(forkedSessionId, [{ type: 'text', text: this.buildAcpSideQuestionPrompt(question) }]);
        })(),
        ACP_SIDE_QUESTION_TIMEOUT_MS
      );

      return { answer: answer.trim(), toolsAttempted: toolsWereAttempted };
    } finally {
      await client.close().catch((error: unknown) => {
        console.warn('[ConversationSideQuestionService] Failed to close ACP /btw runner', {
          backend: context.backend,
          conversationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private async resolveAcpSideQuestionContext(conversation: TChatConversation): Promise<ResolvedAcpContext | null> {
    if (conversation.type !== 'acp') {
      return null;
    }

    const extra = conversation.extra;
    if (!extra?.backend || !extra.acpSessionId || !extra.workspace) {
      return null;
    }

    if (extra.backend !== 'claude') {
      return null;
    }

    const acpConfig = await ProcessConfig.get('acp.config');
    const backendConfig = ACP_BACKENDS_ALL[extra.backend];
    const cliPath = extra.cliPath || acpConfig?.[extra.backend]?.cliPath || backendConfig?.cliCommand;
    if (!cliPath?.trim()) {
      return null;
    }

    const autonomy = await resolveConfiguredSpawnAutonomy({
      backend: extra.backend,
      customAgentId: extra.customAgentId || extra.presetAssistantId,
    });
    // A laddered fork carries the same skill plugin as its session (its own
    // copy, so the live session's plugin dir is never rebuilt under it).
    const skillPlugin = autonomy
      ? await buildLadderedSkillPlugin({
          backend: extra.backend,
          sessionKey: `${conversation.id}.btw`,
          enabledSkills: extra.enabledSkills,
          excludeBuiltinSkills: extra.excludeBuiltinSkills,
        }).catch((error: unknown): undefined => {
          console.error('[ConversationSideQuestionService] laddered skill plugin not built:', error);
          return undefined;
        })
      : undefined;
    const forkMeta = autonomy
      ? await resolveLadderedSessionMeta(extra.backend, {
          tools: [],
          ...(skillPlugin ? ladderedSkillPluginOption(skillPlugin.path) : {}),
        })
      : undefined;

    return {
      ...(forkMeta ? { forkMeta } : {}),
      ...(skillPlugin ? { skillPluginDir: skillPlugin.path } : {}),
      acpSessionId: extra.acpSessionId,
      backend: extra.backend,
      cliPath: cliPath.trim(),
      customArgs: backendConfig?.acpArgs,
      workspace: extra.workspace,
    };
  }

  private buildAcpSideQuestionPrompt(question: string): string {
    return [
      'Answer this brief side question using the current session context.',
      'Do not use tools.',
      'Do not ask follow-up questions.',
      'Return one concise answer only.',
      '',
      `Side question: ${question}`,
    ].join('\n');
  }

  private async runWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new AcpSideQuestionFailedError('ACP /btw timed out.'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
