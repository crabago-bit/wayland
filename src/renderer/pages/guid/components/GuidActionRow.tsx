/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 * Modified by Ferrox Labs in 2026. Changes are documented in the project history.
 */

import { ALLOW_REMOTE_PROPERTY } from '@/common/utils/sshWorkspace';
import { ArrowUp, Brain, Folder, FolderOpen, FolderPlus, PenLine, Shield } from 'lucide-react';
import { ipcBridge } from '@/common';
import ComposerAddMenu, {
  type ComposerUploadItem,
} from '@/renderer/pages/conversation/components/composerMenu/ComposerAddMenu';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import AcpConfigSelector from '@/renderer/components/agent/AcpConfigSelector';
import { supportsModeSwitch, type AgentModeOption } from '@/renderer/utils/model/agentModes';
import type { AcpSessionConfigOption } from '@/common/types/acpTypes';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { getCleanFileNames, FileService } from '@/renderer/services/FileService';
import { iconColors } from '@/renderer/styles/colors';
import { isElectronDesktop } from '@/renderer/utils/platform';
import type { AcpBackend, AcpBackendConfig, AvailableAgent } from '../types';
import PresetAgentTag, { type AgentSwitcherItem } from './PresetAgentTag';
import { Button, Dropdown, Input, Menu, Message, Modal, Tooltip } from '@arco-design/web-react';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../index.module.css';

type GuidActionRowProps = {
  // File handling
  files: string[];
  onFilesUploaded: (paths: string[]) => void;
  onSelectWorkspace: (dir: string) => void;

  // Model selector node (rendered by parent)
  modelSelectorNode: React.ReactNode;

  // Agent mode
  selectedAgent: AcpBackend | 'custom';
  effectiveModeAgent?: string;
  selectedMode: string;
  onModeSelect: (mode: string) => void;

  // Preset agent tag
  isPresetAgent: boolean;
  selectedAgentInfo: AvailableAgent | undefined;
  customAgents: AcpBackendConfig[];
  localeKey: string;
  onClosePresetTag: () => void;
  agentLogo?: string | null;
  agentSwitcherItems?: AgentSwitcherItem[];
  onAgentSwitch?: (key: string) => void;
  hidePresetTag?: boolean;

  // Config options (ACP)
  configOptionsBackend?: AcpBackend;
  cachedConfigOptions?: AcpSessionConfigOption[];
  onConfigOptionSelect?: (configId: string, value: string) => void;

  // Skills management
  builtinAutoSkills: Array<{ name: string; description: string }>;
  disabledBuiltinSkills: string[];
  onToggleBuiltinSkill: (name: string) => void;
  /** Current composer draft, feeds the "+" menu's skill suggestions. */
  draftText?: string;
  /** Staged skill picks from the "+" menu, applied to the new conversation on send. */
  onStagedSkillsChange?: (names: string[]) => void;

  // Send button
  loading: boolean;
  isButtonDisabled: boolean;
  /**
   * No usable model is configured. When true the Send button is disabled and a
   * tooltip explains why; the user can still type and explore.
   */
  noModelConfigured: boolean;
  speechInputNode?: React.ReactNode;
  /** Voice-mode entry, rendered beside the mic on the Launch Pad. */
  voiceModeNode?: React.ReactNode;
  onSend: () => void;
};

const GuidActionRow: React.FC<GuidActionRowProps> = ({
  files,
  onFilesUploaded,
  onSelectWorkspace,
  modelSelectorNode,
  selectedAgent,
  effectiveModeAgent,
  selectedMode,
  onModeSelect,
  isPresetAgent,
  selectedAgentInfo,
  customAgents,
  localeKey,
  onClosePresetTag,
  agentLogo,
  agentSwitcherItems,
  onAgentSwitch,
  configOptionsBackend,
  cachedConfigOptions,
  onConfigOptionSelect,
  builtinAutoSkills,
  disabledBuiltinSkills,
  onToggleBuiltinSkill,
  draftText,
  onStagedSkillsChange,
  hidePresetTag = false,
  loading,
  isButtonDisabled,
  noModelConfigured,
  speechInputNode,
  voiceModeNode,
  onSend,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const modeBackend = effectiveModeAgent || selectedAgent;
  const showModeSwitch = supportsModeSwitch(modeBackend);
  const configOptionCount = (modelSelectorNode ? 1 : 0) + (showModeSwitch ? 1 : 0);

  // Browser file picker ref (WebUI only)
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleLocalFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;
      setUploading(true);
      try {
        const processed = await FileService.processDroppedFiles(fileList);
        if (processed.length > 0) {
          onFilesUploaded(processed.map((f) => f.path));
        }
      } catch (err) {
        Message.error(t('common.fileAttach.failed'));
      } finally {
        setUploading(false);
      }
      // Reset so the same file can be re-selected
      e.target.value = '';
    },
    [onFilesUploaded, t]
  );

  const getModeDisplayLabel = (mode: AgentModeOption): string =>
    t(`agentMode.${mode.value}`, { defaultValue: mode.label });

  const isWebUI = !isElectronDesktop();

  // WarriorHi local patch: recent folders share the localStorage key used by
  // WorkspaceFolderSelect so cron/team dialogs and the composer agree.
  const RECENT_WS_KEY = 'wayland:recent-workspaces';
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_WS_KEY) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const selectWorkspaceAndRemember = useCallback(
    (dir: string) => {
      onSelectWorkspace(dir);
      try {
        const next = [dir, ...recentWorkspaces.filter((d) => d !== dir)].slice(0, 5);
        localStorage.setItem(RECENT_WS_KEY, JSON.stringify(next));
        setRecentWorkspaces(next);
      } catch {
        // localStorage unavailable: selection still applies, just not remembered
      }
    },
    [onSelectWorkspace, recentWorkspaces]
  );
  const browseServerFolder = useCallback(() => {
    ipcBridge.dialog.showOpen
      // 'allowRemote' is Wayland's own marker (not an Electron property): this caller can
      // start the agent on an SSH host, so the picker may offer one.
      .invoke({ properties: ['openDirectory', 'createDirectory', ALLOW_REMOTE_PROPERTY] as never })
      .then((dirs) => {
        if (dirs && dirs[0]) {
          selectWorkspaceAndRemember(dirs[0]);
        }
      })
      .catch((error) => {
        console.error('Failed to open directory dialog:', error);
      });
  }, [selectWorkspaceAndRemember]);
  const promptForFolderPath = useCallback(() => {
    let typedPath = '';
    Modal.confirm({
      title: t('conversation.welcome.specifyWorkspace'),
      content: (
        <Input
          autoFocus
          placeholder='/home/forge/repos/my-project'
          onChange={(value) => {
            typedPath = value;
          }}
        />
      ),
      onOk: () => {
        const dir = typedPath.trim();
        if (!dir.startsWith('/')) {
          Message.error('Enter an absolute path on the server (starting with /).');
          return Promise.reject(new Error('invalid workspace path'));
        }
        selectWorkspaceAndRemember(dir);
        return Promise.resolve();
      },
    });
  }, [selectWorkspaceAndRemember, t]);

  const openHostFilePicker = useCallback(() => {
    ipcBridge.dialog.showOpen
      .invoke({ properties: ['openFile', 'multiSelections'] })
      .then((uploadedFiles) => {
        if (uploadedFiles && uploadedFiles.length > 0) {
          onFilesUploaded(uploadedFiles);
        }
      })
      .catch((error) => {
        console.error('Failed to open file dialog:', error);
      });
  }, [onFilesUploaded]);

  const uploadItems = useMemo<ComposerUploadItem[]>(() => {
    if (isWebUI) {
      return [
        { key: 'file', label: t('common.fileAttach.hostFiles'), onClick: openHostFilePicker },
        { key: 'device', label: t('common.fileAttach.myDevice'), onClick: () => fileInputRef.current?.click() },
      ];
    }
    return [{ key: 'file', label: t('conversation.welcome.uploadFile'), onClick: openHostFilePicker }];
  }, [isWebUI, openHostFilePicker, t]);

  return (
    <div className={styles.actionRow}>
      <div className={styles.actionTools}>
        <div className={styles.actionEntry}>
          <span className='flex items-center gap-4px lh-[1]'>
            <ComposerAddMenu
              mode='staged'
              draftText={draftText}
              uploadItems={uploadItems}
              uploading={uploading}
              builtinAutoSkills={builtinAutoSkills}
              disabledBuiltinSkills={disabledBuiltinSkills}
              onToggleBuiltinSkill={onToggleBuiltinSkill}
              onStagedSkillsChange={onStagedSkillsChange}
            />
            {files.length > 0 && (
              <Tooltip
                className={'!max-w-max'}
                content={<span className='whitespace-break-spaces'>{getCleanFileNames(files).join('\n')}</span>}
              >
                <span className='text-t-primary'>File({files.length})</span>
              </Tooltip>
            )}
          </span>
          {isWebUI && (
            <input
              ref={fileInputRef}
              type='file'
              multiple
              style={{ display: 'none' }}
              onChange={handleLocalFileChange}
            />
          )}
        </div>

        {/*
          WarriorHi local patch (os.warriorhi.com): upstream hides "Chat in Folder" in the
          WebUI because it assumes a native OS picker. The standalone server already routes
          `dialog.showOpen` to the in-browser DirectorySelectionModal (/api/directory/browse,
          mounted in Layout.tsx), so the picker works remotely. Expose it, plus the recent
          folders shared with WorkspaceFolderSelect and a plain "type a path" fallback.
        */}
        {isWebUI ? (
          <Dropdown
            trigger='click'
            position='tl'
            droplist={
              <Menu
                onClickMenuItem={(key) => {
                  if (key === '__browse') {
                    browseServerFolder();
                  } else if (key === '__type') {
                    promptForFolderPath();
                  } else if (key.startsWith('recent:')) {
                    selectWorkspaceAndRemember(key.slice('recent:'.length));
                  }
                }}
              >
                {recentWorkspaces.map((dir) => (
                  <Menu.Item key={`recent:${dir}`}>
                    <span className='flex items-center gap-8px'>
                      <Folder size={14} style={{ flexShrink: 0 }} />
                      <span className='truncate' style={{ maxWidth: 320 }} title={dir}>
                        {dir}
                      </span>
                    </span>
                  </Menu.Item>
                ))}
                {recentWorkspaces.length > 0 && (
                  <Menu.Item
                    key='__divider'
                    disabled
                    style={{ height: 1, padding: 0, margin: '4px 0', background: 'var(--color-border-2)' }}
                  />
                )}
                <Menu.Item key='__browse'>
                  <span className='flex items-center gap-8px'>
                    <FolderPlus size={14} style={{ flexShrink: 0 }} />
                    <span>Browse server folders…</span>
                  </span>
                </Menu.Item>
                <Menu.Item key='__type'>
                  <span className='flex items-center gap-8px'>
                    <PenLine size={14} style={{ flexShrink: 0 }} />
                    <span>Type a path…</span>
                  </span>
                </Menu.Item>
              </Menu>
            }
          >
            <Button className='sendbox-model-btn' shape='round' size='small'>
              <span className='flex items-center gap-6px leading-none'>
                <FolderOpen size={14} style={{ lineHeight: 0, flexShrink: 0 }} />
                <span>{t('conversation.welcome.specifyWorkspace')}</span>
              </span>
            </Button>
          </Dropdown>
        ) : (
          <Button className='sendbox-model-btn' shape='round' size='small' onClick={browseServerFolder}>
            <span className='flex items-center gap-6px leading-none'>
              <FolderOpen size={14} style={{ lineHeight: 0, flexShrink: 0 }} />
              <span>{t('conversation.welcome.specifyWorkspace')}</span>
            </span>
          </Button>
        )}

        <div
          className={`${styles.actionConfigGroup} ${configOptionCount > 1 ? styles.actionConfigGroupWithDivider : ''}`}
        >
          {modelSelectorNode}

          {showModeSwitch && (
            <AgentModeSelector
              backend={modeBackend}
              compact
              initialMode={selectedMode}
              onModeSelect={onModeSelect}
              compactLeadingIcon={<Shield size={14} color={iconColors.secondary} />}
              modeLabelFormatter={getModeDisplayLabel}
              compactLabelPrefix={t('agentMode.permission')}
              hideCompactLabelPrefixOnMobile
            />
          )}
          <AcpConfigSelector
            backend={configOptionsBackend}
            buttonClassName='guid-config-btn'
            initialConfigOptions={cachedConfigOptions}
            leadingIcon={<Brain size={14} color={iconColors.secondary} />}
            onOptionSelect={onConfigOptionSelect}
          />
        </div>

        {!hidePresetTag && isPresetAgent && selectedAgentInfo && (
          <div className={styles.actionPresetAgent}>
            <PresetAgentTag
              agentInfo={selectedAgentInfo}
              customAgents={customAgents}
              localeKey={localeKey}
              onClose={onClosePresetTag}
              agentLogo={agentLogo}
              agentSwitcherItems={agentSwitcherItems}
              onAgentSwitch={onAgentSwitch}
            />
          </div>
        )}
      </div>
      <div className={styles.actionSubmit}>
        {speechInputNode}
        {voiceModeNode}
        <Tooltip
          content={noModelConfigured ? t('conversation.noModelCta.sendTooltip') : undefined}
          disabled={!noModelConfigured}
        >
          {/* The span receives hover even while the Button is disabled
              (Arco sets pointer-events:none on a disabled button), so the
              no-model tooltip still surfaces. */}
          <span className='inline-flex'>
            <Button
              shape='circle'
              type='primary'
              loading={loading}
              disabled={isButtonDisabled}
              className='send-button-custom'
              aria-label={t('conversation.chat.sendMessage')}
              style={{
                backgroundColor: isButtonDisabled ? undefined : '#000000',
                borderColor: isButtonDisabled ? undefined : '#000000',
              }}
              icon={<ArrowUp size={14} color='white' strokeWidth={5} />}
              onClick={onSend}
            />
          </span>
        </Tooltip>
      </div>
    </div>
  );
};

export default GuidActionRow;
