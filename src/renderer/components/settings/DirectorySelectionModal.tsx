/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 * Modified by Ferrox Labs in 2026. Changes are documented in the project history.
 */

import { ChevronUp, FileText, FolderOpen } from 'lucide-react';
import { Button, Modal, Select, Spin } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSshWorkspace } from '@/common/utils/sshWorkspace';

interface DirectoryItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile?: boolean;
}

interface DirectoryData {
  items: DirectoryItem[];
  canGoUp: boolean;
  parentPath?: string;
}

interface SshHostOption {
  alias: string;
  hostName?: string;
  user?: string;
}

/** The empty host means "this server". */
const LOCAL_HOST = '';

interface DirectorySelectionModalProps {
  visible: boolean;
  isFileMode?: boolean;
  /** Offer SSH hosts and let the caller choose a folder on one (returned as `ssh://host/path`). */
  allowRemote?: boolean;
  onConfirm: (paths: string[] | undefined) => void;
  onCancel: () => void;
}

const DirectorySelectionModal: React.FC<DirectorySelectionModalProps> = ({
  visible,
  isFileMode = false,
  allowRemote = false,
  onConfirm,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [directoryData, setDirectoryData] = useState<DirectoryData>({ items: [], canGoUp: false });
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [currentPath, setCurrentPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [sshHosts, setSshHosts] = useState<SshHostOption[]>([]);
  const [host, setHost] = useState<string>(LOCAL_HOST);
  const remote = host !== LOCAL_HOST;
  // A remote path only means something to a caller that can start an agent on that
  // host; every other picker keeps seeing this server's folders only.
  const remoteSelectable = allowRemote && !isFileMode;

  const loadDirectory = useCallback(
    async (dirPath = '', hostAlias = host) => {
      setLoading(true);
      setError(null);
      try {
        const showFiles = isFileMode ? 'true' : 'false';
        const response = await fetch(
          `/api/directory/browse?path=${encodeURIComponent(dirPath)}&showFiles=${showFiles}` +
            (hostAlias ? `&host=${encodeURIComponent(hostAlias)}` : ''),
          {
            method: 'GET',
            credentials: 'include',
          }
        );
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          setError(errorData.error || `HTTP ${response.status}`);
          return;
        }
        const data = await response.json();
        if (!data || !Array.isArray(data.items)) {
          setError('Invalid response from server');
          return;
        }
        setDirectoryData(data);
        setCurrentPath(dirPath);
      } catch (err) {
        console.error('Failed to load directory:', err);
        setError(err instanceof Error ? err.message : 'Failed to load directory');
      } finally {
        setLoading(false);
      }
    },
    [isFileMode, host]
  );

  useEffect(() => {
    if (visible) {
      setSelectedPath('');
      setHost(LOCAL_HOST);
      loadDirectory('', LOCAL_HOST).catch((error) => console.error('Failed to load initial directory:', error));
      if (!allowRemote) setSshHosts([]);
      else
        fetch('/api/directory/ssh-hosts', { credentials: 'include' })
          .then((r): Promise<{ hosts?: SshHostOption[] }> => (r.ok ? r.json() : Promise.resolve({ hosts: [] })))
          .then((data) => setSshHosts(Array.isArray(data.hosts) ? data.hosts : []))
          .catch(() => setSshHosts([]));
    }
    // loadDirectory changes with `host`; re-running here on a host switch would reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, allowRemote]);

  const handleHostChange = (next: string) => {
    setHost(next);
    setSelectedPath('');
    setDirectoryData({ items: [], canGoUp: false });
    loadDirectory('', next).catch((error) => console.error('Failed to load host directory:', error));
  };

  const handleItemClick = (item: DirectoryItem) => {
    if (item.isDirectory) {
      loadDirectory(item.path).catch((error) => console.error('Failed to load directory:', error));
    }
  };

  // Double-click behavior removed - single click now handles directory navigation
  const handleItemDoubleClick = (_item: DirectoryItem) => {
    // No-op: single click already handles navigation
  };

  const handleSelect = (path: string) => {
    setSelectedPath(path);
  };

  const handleGoUp = () => {
    if (directoryData.parentPath !== undefined) {
      // Handle '__ROOT__' as empty path to show drive list on Windows
      const targetPath = directoryData.parentPath === '__ROOT__' ? '' : directoryData.parentPath;
      loadDirectory(targetPath).catch((error) => console.error('Failed to load parent directory:', error));
    }
  };

  const handleConfirm = () => {
    if (selectedPath) {
      onConfirm([remote ? formatSshWorkspace(host, selectedPath) : selectedPath]);
    }
  };

  const canSelect = (item: DirectoryItem) => {
    if (remote && !remoteSelectable) return false;
    return isFileMode ? item.isFile : item.isDirectory;
  };

  return (
    <Modal
      visible={visible}
      title={isFileMode ? '📄 ' + t('fileSelection.selectFile') : '📁 ' + t('fileSelection.selectDirectory')}
      onCancel={onCancel}
      onOk={handleConfirm}
      okButtonProps={{ disabled: !selectedPath }}
      className='w-[90vw] md:w-[600px]'
      style={{ width: 'min(600px, 90vw)' }}
      wrapStyle={{ zIndex: 3000 }}
      maskStyle={{ zIndex: 2990 }}
      footer={
        <div className='w-full flex justify-between items-center'>
          <div
            className='text-t-secondary text-14px overflow-hidden text-ellipsis whitespace-nowrap max-w-[70vw]'
            title={selectedPath || currentPath}
          >
            {selectedPath ||
              currentPath ||
              (isFileMode ? t('fileSelection.pleaseSelectFile') : t('fileSelection.pleaseSelectDirectory'))}
          </div>
          <div className='flex gap-12px'>
            <Button onClick={onCancel} style={{ borderRadius: 8 }} className='px-16px'>
              {t('common.cancel')}
            </Button>
            <Button type='primary' onClick={handleConfirm} disabled={!selectedPath} className=''>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      {allowRemote && sshHosts.length > 0 && (
        <div className='mb-10px'>
          <Select value={host} onChange={handleHostChange} style={{ width: '100%' }}>
            <Select.Option value={LOCAL_HOST}>
              {t('fileSelection.thisServer', { defaultValue: 'This server' })}
            </Select.Option>
            {sshHosts.map((h) => (
              <Select.Option key={h.alias} value={h.alias}>
                {h.alias}
                {h.user && h.hostName ? ` (${h.user}@${h.hostName})` : ''}
              </Select.Option>
            ))}
          </Select>
          {remote && (
            <div className='mt-6px text-12px text-t-tertiary'>
              {t('fileSelection.remoteBrowseOnly', {
                defaultValue: 'The chat will run its agent on this machine over SSH, in the folder you choose.',
              })}
            </div>
          )}
        </div>
      )}
      <Spin loading={loading} className='w-full'>
        <div className='w-full border border-b-base rd-4px overflow-hidden' style={{ height: 'min(400px, 60vh)' }}>
          <div className='h-full overflow-y-auto'>
            {directoryData.canGoUp && (
              <div
                className='flex items-center p-10px border-b border-b-light cursor-pointer hover:bg-hover transition'
                onClick={handleGoUp}
              >
                <ChevronUp className='mr-10px text-t-secondary' />
                <span>..</span>
              </div>
            )}
            {error && (
              <div className='p-16px text-center text-danger text-13px'>
                <div>{error}</div>
                <Button
                  size='mini'
                  className='mt-8px'
                  // intentional fire-and-forget; loadDirectory surfaces failure via its own error state
                  onClick={() => loadDirectory(currentPath).catch(() => {})}
                >
                  {t('common.retry', { defaultValue: 'Retry' })}
                </Button>
              </div>
            )}
            {directoryData.items.map((item, index) => (
              <div
                key={index}
                className='flex items-center justify-between p-10px border-b border-b-light cursor-pointer hover:bg-hover transition'
                style={selectedPath === item.path ? { background: 'var(--brand-light)' } : {}}
                onClick={() => handleItemClick(item)}
                onDoubleClick={() => handleItemDoubleClick(item)}
              >
                <div className='flex items-center flex-1 min-w-0'>
                  {item.isDirectory ? (
                    <FolderOpen className='mr-10px text-warning shrink-0' />
                  ) : (
                    <FileText className='mr-10px text-primary shrink-0' />
                  )}
                  <span className='overflow-hidden text-ellipsis whitespace-nowrap'>{item.name}</span>
                </div>
                {canSelect(item) && (
                  <Button
                    type='primary'
                    size='mini'
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelect(item.path);
                    }}
                  >
                    {t('common.select')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </Spin>
    </Modal>
  );
};

export default DirectorySelectionModal;
