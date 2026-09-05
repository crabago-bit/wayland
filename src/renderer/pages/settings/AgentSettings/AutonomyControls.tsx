/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Select, Tag, Tooltip, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  AUTONOMY_RUNG_DESCRIPTIONS,
  AUTONOMY_RUNG_LABELS,
  AUTONOMY_RUNGS,
  toAutonomyRung,
  type AutonomyRung,
} from '@/common/jarvis/autonomy';
import { useAgentAutonomy, useHardFloor } from '@renderer/hooks/assistant/useAgentAutonomy';
import styles from './AgentsSettings.module.css';

/**
 * The per-agent autonomy rung selector (JARVIS ladder).
 *
 * Four rungs, always all four: hiding the higher ones would make promotion feel
 * like a hidden setting rather than a decision. The tooltip states what the rung
 * actually does at the tool boundary, because "AUTONOMOUS" on its own tells a
 * user nothing about which calls will be refused.
 */
export const AutonomyRungSelect: React.FC<{
  agentKey: string;
  rung: AutonomyRung;
  onChange: (rung: AutonomyRung) => void;
  compact?: boolean;
}> = ({ agentKey, rung, onChange, compact }) => {
  const { t } = useTranslation();
  return (
    <Tooltip content={AUTONOMY_RUNG_DESCRIPTIONS[rung]}>
      <Select
        size={compact ? 'mini' : 'small'}
        value={rung}
        onChange={(value) => onChange(toAutonomyRung(value))}
        style={{ width: compact ? 132 : 168 }}
        data-testid={`agent-autonomy-rung-${agentKey}`}
        aria-label={t('settings.agentsPage.autonomy.label')}
      >
        {AUTONOMY_RUNGS.map((value) => (
          <Select.Option key={value} value={value}>
            {`${value} · ${AUTONOMY_RUNG_LABELS[value]}`}
          </Select.Option>
        ))}
      </Select>
    </Tooltip>
  );
};

/**
 * Self-contained rung selector for the surfaces that render ONE agent and do not
 * already hold the rung map: the custom-agent rows (`custom:<id>`) and the
 * remote-agent cards (`remote:<id>`).
 *
 * It owns the hook rather than taking a rung prop because both of those cards
 * sit inside components with an early return above them, and a hook cannot live
 * after a conditional return. SWR dedupes on the shared key, so every selector
 * on the page still reads and writes the same map the Agents page does - and the
 * same map `resolveSpawnAutonomy` reads when it spawns the shim.
 */
export const AgentRungSelect: React.FC<{ agentKey: string; compact?: boolean }> = ({ agentKey, compact }) => {
  const { rungOf, setRung } = useAgentAutonomy();
  return (
    <AutonomyRungSelect
      agentKey={agentKey}
      rung={rungOf(agentKey)}
      onChange={(rung) => void setRung(agentKey, rung)}
      compact={compact}
    />
  );
};

/**
 * Read-only display of the hard floor.
 *
 * Tokens, not substrings: each tag is a WHOLE token a tool name must contain
 * (split on `_`, `-`, `/`, `.` and camelCase) for the call to be refused, which
 * is why `sign` does not floor `generate_design`.
 *
 * Deliberately not editable here. The built-in pattern ships in code and the
 * extra keywords come from the operator's `autonomy.md`; a settings control that
 * could shrink it would let the app talk itself out of its own floor. What the
 * user gets instead is the path to the file that widens it.
 */
export const HardFloorCard: React.FC = () => {
  const { t } = useTranslation();
  const floor = useHardFloor();

  return (
    <div className={styles.card} data-testid='hard-floor-card'>
      <div className={styles.cardHead}>
        <div className={styles.cardMain}>
          <div className={styles.name}>{t('settings.agentsPage.autonomy.hardFloorTitle')}</div>
          <div className={styles.desc}>{t('settings.agentsPage.autonomy.hardFloorDesc')}</div>
          <div className='flex flex-wrap gap-4px mt-8px'>
            {floor.builtinTokens.map((word) => (
              <Tag key={`builtin-${word}`} size='small'>
                {word}
              </Tag>
            ))}
            {floor.keywords.map((word) => (
              <Tag key={`operator-${word}`} size='small' color='orange'>
                {word}
              </Tag>
            ))}
          </div>
          {/* The FORMAT is stated here because it is the only place the operator
              sees it: prose in autonomy.md is deliberately ignored, and a floor
              nobody can see they failed to declare is worse than no floor. */}
          <Typography.Text className='text-12px mt-8px block' type='secondary'>
            {floor.notesFileFound
              ? t('settings.agentsPage.autonomy.hardFloorSource')
              : t('settings.agentsPage.autonomy.hardFloorNoNotes')}
          </Typography.Text>
        </div>
      </div>
    </div>
  );
};
