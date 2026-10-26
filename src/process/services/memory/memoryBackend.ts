/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ProcessConfig } from '@process/utils/initStorage';
import { BrainMcpClient, readBrainEndpoint } from './brainMcpClient';
import { BrainMemoryService, type HiddenRecord, type HiddenStore } from './brainMemoryService';

/** The few memory ids Wayland hides, kept in the app config (the brain itself is never edited). */
const configHiddenStore: HiddenStore = {
  async load() {
    const stored = await ProcessConfig.get('memory.brainHidden');
    return Array.isArray(stored) ? (stored as HiddenRecord[]) : [];
  },
  async save(records) {
    await ProcessConfig.set('memory.brainHidden', records);
  },
};

let service: Promise<BrainMemoryService | null> | null = null;

/**
 * The one Memory backend: the user's brain MCP server. Resolves to null when no enabled
 * `brain` server is configured (Memory then reports `none` instead of guessing a store).
 * Shared by the Memory bridge and by whatever reads memories into chats, so both see the
 * same index.
 */
export function getBrainMemory(): Promise<BrainMemoryService | null> {
  service ??= (async () => {
    const endpoint = await readBrainEndpoint();
    return endpoint ? new BrainMemoryService(new BrainMcpClient(endpoint), configHiddenStore) : null;
  })();
  return service;
}

/** Forget the cached service (tests, or after the user edits the brain server entry). */
export function resetBrainMemory(): void {
  service = null;
}
