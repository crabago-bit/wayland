/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CostAggregate } from '@process/services/cost/types';

/**
 * A JARVIS model id names its TIER, not a vendor model: `jarvis-fast`,
 * `jarvis-deep`, and so on route to whatever the Flux router picks that week.
 * Rolling spend up by raw model id therefore fragments the one number an
 * operator actually wants ("what did the deep tier cost me?") across whatever
 * the router happened to choose.
 */
const JARVIS_PREFIX = 'jarvis-';

export type TierUsageRow = {
  /** Tier name (`deep`) or, for a non-JARVIS model, the model id itself. */
  key: string;
  /** `tier` rows aggregate several model ids; `model` rows are one model. */
  kind: 'tier' | 'model';
  costUsd: number;
  tokensTotal: number;
  events: number;
  /** How many distinct model ids rolled into this row. */
  models: number;
};

/** `jarvis-deep-v2` -> `deep`. Anything else -> null (not a tier). */
export function tierOfModelId(modelId: string): string | null {
  if (!modelId.startsWith(JARVIS_PREFIX)) return null;
  const rest = modelId.slice(JARVIS_PREFIX.length);
  const tier = rest.split(/[-/:]/)[0];
  return tier.length > 0 ? tier : null;
}

/**
 * Roll `cost.byModel` up into tier rows, costliest first.
 *
 * Non-JARVIS models are kept as their own rows rather than lumped into an
 * "other" bucket: a direct call to a named model is a different decision from a
 * tier request, and collapsing the two would hide exactly the spend an operator
 * is looking for when a tier bill jumps.
 */
export function aggregateTierUsage(byModel: readonly CostAggregate[]): TierUsageRow[] {
  const rows = new Map<string, TierUsageRow>();
  for (const row of byModel) {
    // An unattributed key ('') stays its own row rather than being dropped, so
    // the tier totals still add up to the summary total.
    const tier = tierOfModelId(row.key);
    const key = tier ?? row.key;
    const kind: TierUsageRow['kind'] = tier ? 'tier' : 'model';
    const existing = rows.get(key);
    if (existing) {
      existing.costUsd += row.costUsd;
      existing.tokensTotal += row.tokensTotal;
      existing.events += row.events;
      existing.models += 1;
    } else {
      rows.set(key, {
        key,
        kind,
        costUsd: row.costUsd,
        tokensTotal: row.tokensTotal,
        events: row.events,
        models: 1,
      });
    }
  }
  return [...rows.values()].toSorted((a, b) => b.costUsd - a.costUsd || b.events - a.events);
}
