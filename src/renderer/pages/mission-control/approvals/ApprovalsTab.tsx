/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mission Control "Approvals" tab - the JARVIS autonomy ledger.
 *
 * Two panels:
 *  1. Approvals: the last 200 recorded decisions, newest first, filterable by
 *     decision and by agent, each row carrying the rung the agent was on when
 *     the call was made. The rung is read off the ROW, not off current settings:
 *     a ledger that re-labelled history whenever someone changed a setting would
 *     be worthless for answering "why did that go out?".
 *  2. Tier usage: spend rolled up by model tier, so `jarvis-*` model ids collapse
 *     into the tier they name instead of fragmenting across whatever the router
 *     picked. Desktop-only, because the whole `cost.*` namespace is remote-denied.
 */

import React from 'react';
import { Button, Select, Tag } from '@arco-design/web-react';
import { RefreshCw } from 'lucide-react';
import { AUTONOMY_RUNG_LABELS, toAutonomyRung } from '@/common/jarvis/autonomy';
import { formatTokenCount, formatUsd } from '@renderer/utils/format/tokens';
import { isElectronDesktop } from '@renderer/utils/platform';
import { useCostAnalytics } from '../cost/useCostAnalytics';
import { aggregateTierUsage } from './tierUsage';
import { useApprovals } from './useApprovals';
import styles from './Approvals.module.css';

function formatTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

/** Rung badge for one ledger row. Colour tracks "was effect permitted here?". */
const RungBadge: React.FC<{ rung: number }> = ({ rung }) => {
  const value = toAutonomyRung(rung);
  return (
    <Tag size='small' color={value >= 3 ? 'arcoblue' : 'gray'}>
      {`${value} · ${AUTONOMY_RUNG_LABELS[value]}`}
    </Tag>
  );
};

const TierUsageCard: React.FC = () => {
  const { byModel } = useCostAnalytics();
  const rows = aggregateTierUsage(byModel);

  return (
    <div className={styles.panel} data-testid='tier-usage-card'>
      <div className={styles.panelTitle}>Tier usage</div>
      {rows.length === 0 ? (
        <div className={styles.empty}>No recorded usage in this period yet.</div>
      ) : (
        rows.map((row) => (
          <div key={`${row.kind}:${row.key}`} className={styles.tierRow}>
            <span className={styles.tierName}>
              {row.key || 'unattributed'}
              {row.kind === 'tier' && (
                <Tag size='small' color='orange' className='ml-6px'>
                  tier
                </Tag>
              )}
            </span>
            <span>{formatUsd(row.costUsd)}</span>
            <span>{formatTokenCount(row.tokensTotal)}</span>
            <span>{row.events.toLocaleString()}</span>
          </div>
        ))
      )}
    </div>
  );
};

export const ApprovalsTab: React.FC = () => {
  const { rows, agents, filter, setFilter, total, loading, refresh } = useApprovals();

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <div className='flex items-center gap-8px'>
          <Select
            size='small'
            style={{ width: 140 }}
            value={filter.decision}
            onChange={(decision) => setFilter({ ...filter, decision })}
            aria-label='Filter by decision'
          >
            <Select.Option value='all'>All decisions</Select.Option>
            <Select.Option value='refused'>Refused</Select.Option>
            <Select.Option value='allowed'>Allowed</Select.Option>
          </Select>
          <Select
            size='small'
            style={{ width: 160 }}
            value={filter.agent}
            onChange={(agent) => setFilter({ ...filter, agent })}
            aria-label='Filter by agent'
          >
            <Select.Option value='all'>All agents</Select.Option>
            {agents.map((agent) => (
              <Select.Option key={agent} value={agent}>
                {agent}
              </Select.Option>
            ))}
          </Select>
        </div>
        <Button size='small' icon={<RefreshCw size={14} />} loading={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelTitle}>{`Approvals — showing ${rows.length} of ${total}`}</div>
        {rows.length === 0 ? (
          <div className={styles.empty}>
            Nothing recorded yet. Refusals and write-tool calls at rung 3 or above appear here.
          </div>
        ) : (
          rows.map((row, index) => (
            <div key={`${row.ts}-${row.tool}-${index}`} className={styles.row}>
              <span className={styles.ts}>{formatTs(row.ts)}</span>
              <span>
                <Tag size='small' color={row.decision === 'refused' ? 'red' : 'green'}>
                  {row.decision}
                </Tag>
              </span>
              <span>
                <span className={styles.tool}>{row.tool}</span>
                <div className={styles.reason}>{row.reason}</div>
              </span>
              <span>
                <RungBadge rung={row.rung} />
              </span>
            </div>
          ))
        )}
      </div>

      {/* The cost.* namespace is remote-denied, so this card can only ever be
          empty in a browser WebUI - omit it there rather than show a dead panel. */}
      {isElectronDesktop() && <TierUsageCard />}
    </div>
  );
};

export default ApprovalsTab;
