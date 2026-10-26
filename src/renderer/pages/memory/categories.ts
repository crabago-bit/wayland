/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The six Memory categories, in display order, with the label, glyph, colour and
 * plain-language meaning every Memory component shows for them. The backend
 * classifies brain memories into these from title prefixes and source.
 */

import type { MemoryType } from '@/common/types/memory';

export type MemoryCategory = {
  type: MemoryType;
  /** Plural label, e.g. "Decisions". */
  label: string;
  labelKey: string;
  /** What lands in this category, in plain language. */
  description: string;
  descriptionKey: string;
  glyph: string;
  color: string;
};

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  {
    type: 'decision',
    label: 'Decisions',
    labelKey: 'archive.type.decision',
    description: 'Deploy choices, governance, hires, routines and plans.',
    descriptionKey: 'archive.typeDescription.decision',
    glyph: '◆',
    color: '#FF7A45',
  },
  {
    type: 'preference',
    label: 'Preferences',
    labelKey: 'archive.type.preference',
    description: 'Hard rules and standing preferences.',
    descriptionKey: 'archive.typeDescription.preference',
    glyph: '⚙',
    color: '#FCD34D',
  },
  {
    type: 'pattern',
    label: 'Patterns',
    labelKey: 'archive.type.pattern',
    description: 'Patterns, bug fixes, incidents, lessons and topology.',
    descriptionKey: 'archive.typeDescription.pattern',
    glyph: '▲',
    color: '#5EEAD4',
  },
  {
    type: 'session',
    label: 'Sessions',
    labelKey: 'archive.type.session',
    description: 'Session logs and heartbeats.',
    descriptionKey: 'archive.typeDescription.session',
    glyph: '⏱',
    color: '#7DD3FC',
  },
  {
    type: 'wiki',
    label: 'Wiki',
    labelKey: 'archive.type.wiki',
    description: 'Notes from Obsidian, files, URLs and docs.',
    descriptionKey: 'archive.typeDescription.wiki',
    glyph: '📚',
    color: '#C084FC',
  },
  {
    type: 'observation',
    label: 'Observations',
    labelKey: 'archive.type.observation',
    description: 'Everything else.',
    descriptionKey: 'archive.typeDescription.observation',
    glyph: '◯',
    color: '#94A3B8',
  },
];

const BY_TYPE = new Map(MEMORY_CATEGORIES.map((c) => [c.type, c]));

/** Category metadata for a type; unknown types fall back to Observations. */
export const categoryOf = (type: MemoryType): MemoryCategory =>
  BY_TYPE.get(type) ?? (BY_TYPE.get('observation') as MemoryCategory);

/** Brain memories shorter than this are refused by the brain. */
export const MIN_MEMORY_CHARS = 40;

/** The brain workspace that every agent shares. */
export const GLOBAL_WORKSPACE = 'general';
