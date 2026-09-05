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
import { useHardFloor } from '@renderer/hooks/assistant/useAgentAutonomy';
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
        aria-label={t('settings.agentsPage.autonomy.label', { defaultValue: 'Autonomy rung' })}
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
 * Read-only display of the hard floor.
 *
 * Deliberately not editable here. The built-in pattern ships in code and the
 * extra keywords come from the operator's `autonomy.md`; a settings control that
 * could shrink it would let the app talk itself out of its own floor. What the
 * user gets instead is the path to the file that widens it.
 */
export const HardFloorCard: React.FC = () => {
  const { t } = useTranslation();
  const floor = useHardFloor();
  // The built-in list is an alternation source (`pay|payout|...`) - split it
  // back into words so it reads as a list rather than as a regex.
  const builtIn = floor.pattern ? floor.pattern.split('|').filter(Boolean) : [];

  return (
    <div className={styles.card} data-testid='hard-floor-card'>
      <div className={styles.cardHead}>
        <div className={styles.cardMain}>
          <div className={styles.name}>
            {t('settings.agentsPage.autonomy.hardFloorTitle', { defaultValue: 'Hard floor' })}
          </div>
          <div className={styles.desc}>
            {t('settings.agentsPage.autonomy.hardFloorDesc', {
              defaultValue:
                'Tool names matching any of these are refused at every rung, including AUTONOMOUS. Enforced in the MCP tool filter, not in the model prompt.',
            })}
          </div>
          <div className='flex flex-wrap gap-4px mt-8px'>
            {builtIn.map((word) => (
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
          {floor.notesPath && (
            <Typography.Text className='text-12px mt-8px block' type='secondary'>
              {t('settings.agentsPage.autonomy.hardFloorSource', {
                defaultValue: 'Extra keywords (orange) come from {{path}}',
                path: floor.notesPath,
              })}
            </Typography.Text>
          )}
        </div>
      </div>
    </div>
  );
};
