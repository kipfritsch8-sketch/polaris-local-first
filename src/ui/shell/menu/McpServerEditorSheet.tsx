import { useEffect, useState } from 'react';
import { buildMcpHandle } from '../../../engines/mcpHandle';
import {
  clearMcpAuthorization,
  getMcpAuthorizationStatus,
  startMcpOauthAuthorization
} from '../../../engines/mcpOauthFlow';
import { resolveMcpToolCatalog, type McpResolvedToolDefinition } from '../../../engines/mcpRuntime';
import { useI18n } from '../../../i18n/useI18n';
import type { McpServerAuthMode, McpServerConfig, McpServerHeader, McpServerToolConfig, McpServerTransport } from '../../../types/domain';
import { Icon } from '../../Icon';

type McpServerEditorSheetProps = {
  open: boolean;
  server: McpServerConfig | null;
  timeoutSeconds: number;
  onClose: () => void;
  onSave: (patch: Omit<McpServerConfig, 'id' | 'handle'>) => void;
  onDelete?: () => void;
};

type McpConnectionTestState =
  | { status: 'idle' }
  | { status: 'testing' }
  | { status: 'success'; message: string }
  | { status: 'warning'; message: string }
  | { status: 'error'; message: string };

function createEmptyHeader(): McpServerHeader {
  return {
    id: `header-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    key: '',
    value: ''
  };
}

function mergeDiscoveredTools(
  currentTools: McpServerToolConfig[],
  discoveredTools: McpResolvedToolDefinition[]
): McpServerToolConfig[] {
  const currentByName = new Map(currentTools.map((tool) => [tool.name, tool] as const));
  return discoveredTools.map((tool) => {
    const current = currentByName.get(tool.toolName);
    return {
      name: tool.toolName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      enabled: current?.enabled ?? tool.enabled ?? true
    };
  });
}

export function McpServerEditorSheet({
  open,
  server,
  timeoutSeconds,
  onClose,
  onSave,
  onDelete
}: McpServerEditorSheetProps) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<McpServerTransport>('streamable-http');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<McpServerHeader[]>([]);
  const [authMode, setAuthMode] = useState<McpServerAuthMode>('headers');
  const [authBusy, setAuthBusy] = useState(false);
  const [tools, setTools] = useState<McpServerToolConfig[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [testState, setTestState] = useState<McpConnectionTestState>({ status: 'idle' });

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? '');
    setDescription(server?.description ?? '');
    setTransport(server?.transport ?? 'streamable-http');
    setUrl(server?.url ?? '');
    setHeaders(server?.headers.length ? server.headers : []);
    setAuthMode(server?.authMode === 'oauth' ? 'oauth' : 'headers');
    setAuthBusy(false);
    setTools(server?.tools ?? []);
    setIsActive(server?.isActive ?? true);
    setTestState({ status: 'idle' });
  }, [open, server]);

  if (!open) return null;

  const normalizedHeaders = () =>
    headers
      .map((header) => ({
        ...header,
        key: header.key.trim(),
        value: header.value
      }))
      .filter((header) => header.key);

  const testConnection = async () => {
    const trimmedName = name.trim() || t('settings.mcp.testNameFallback');
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setTestState({ status: 'error', message: t('settings.mcp.testMissingUrl') });
      return;
    }

    const serverId = server?.id ?? 'mcp-test-preview';
    const draftServer: McpServerConfig = {
      id: serverId,
      handle: buildMcpHandle({
        handle: server?.handle,
        name: trimmedName,
        url: trimmedUrl,
        id: serverId
      }),
      name: trimmedName,
      description: description.trim(),
      transport,
      url: trimmedUrl,
      headers: normalizedHeaders(),
      authMode,
      tools,
      isActive: true
    };

    setTestState({ status: 'testing' });
    try {
      const result = await resolveMcpToolCatalog({
        servers: [draftServer],
        timeoutSeconds,
        retryDelaysMs: [],
        includeDisabledTools: true
      });
      if (result.errors.length) {
        setTestState({ status: 'error', message: result.errors.join('\n') });
        return;
      }
      if (!result.tools.length) {
        setTestState({ status: 'warning', message: t('settings.mcp.testNoTools') });
        return;
      }

      setTools((current) => mergeDiscoveredTools(current, result.tools));
      const toolNames = result.tools.map((tool) => tool.toolName).slice(0, 4).join(t('settings.mcp.testToolSeparator'));
      const summary = result.tools.length > 4
        ? t('settings.mcp.testToolSummaryMore', { count: result.tools.length })
        : t('settings.mcp.testToolSummary', { count: result.tools.length });
      setTestState({ status: 'success', message: t('settings.mcp.testSuccess', { summary, tools: toolNames }) });
    } catch (error) {
      setTestState({
        status: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.testFailed')
      });
    }
  };

  const submit = () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) {
      window.alert(t('settings.mcp.nameRequired'));
      return;
    }
    if (!trimmedUrl) {
      window.alert(t('settings.mcp.urlRequired'));
      return;
    }

    onSave({
      name: trimmedName,
      description: description.trim(),
      transport,
      url: trimmedUrl,
      headers: normalizedHeaders(),
      authMode,
      tools,
      isActive
    });
    onClose();
  };

  const authStatus = url.trim() ? getMcpAuthorizationStatus(url.trim()) : 'none';

  const startAuthorization = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setTestState({ status: 'error', message: t('settings.mcp.testMissingUrl') });
      return;
    }

    setAuthBusy(true);
    try {
      const { authorizeUrl } = await startMcpOauthAuthorization({
        server: {
          ...(server?.id ? { id: server.id } : {}),
          name: name.trim() || t('settings.mcp.testNameFallback'),
          description: description.trim(),
          transport,
          url: trimmedUrl,
          headers: normalizedHeaders(),
          tools,
          isActive
        }
      });
      window.location.assign(authorizeUrl);
    } catch (error) {
      setAuthBusy(false);
      setTestState({
        status: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.oauthStartFailed')
      });
    }
  };

  const revokeAuthorization = () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    clearMcpAuthorization(trimmedUrl);
    setTestState({ status: 'idle' });
  };

  return (
    <div className="mcp-inline-sheet-overlay" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="mcp-inline-sheet mcp-inline-sheet--editor" role="dialog" aria-modal="true" aria-label={server ? t('settings.mcp.editorTitleEdit') : t('settings.mcp.editorTitleCreate')}>
        <div className="sheet-handle" />
        <div className="mcp-inline-sheet-header">
          <button type="button" className="mcp-icon-button" onClick={onClose} aria-label={t('settings.mcp.close')}>
            <Icon name="x" size={16} />
          </button>
          <strong>{server ? t('settings.mcp.editorTitleEdit') : t('settings.mcp.editorTitleCreate')}</strong>
          <button type="button" className="mcp-inline-sheet-confirm" onClick={submit}>
            {t('settings.mcp.save')}
          </button>
        </div>

        <div className="settings-form mcp-settings-form">
          <div className="memory-toggle memory-toggle--switch">
            <div className="memory-toggle-copy">
              <strong>{t('settings.mcp.enabledTitle')}</strong>
              <span>{t('settings.mcp.enabledDetail')}</span>
            </div>
            <button
              type="button"
              className={`ps-toggle-sw memory-toggle-switch ${isActive ? 'ps-toggle-sw--on' : ''}`}
              aria-pressed={isActive}
              onClick={() => setIsActive((value) => !value)}
            >
              <span className="ps-toggle-knob" />
            </button>
          </div>

          <label>
            {t('settings.mcp.nameLabel')}
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="My MCP" />
          </label>

          <label>
            {t('settings.mcp.descriptionLabel')}
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('settings.mcp.descriptionPlaceholder')}
            />
          </label>

          <div className="mcp-transport-field">
            <span>{t('settings.mcp.transportLabel')}</span>
            <div className="mcp-transport-switch">
              <button
                type="button"
                className={transport === 'streamable-http' ? 'active' : ''}
                onClick={() => setTransport('streamable-http')}
              >
                Streamable HTTP
              </button>
              <button
                type="button"
                className={transport === 'sse' ? 'active' : ''}
                onClick={() => setTransport('sse')}
              >
                SSE
              </button>
            </div>
          </div>

          <label>
            {t('settings.mcp.urlLabel')}
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://localhost:3000"
            />
          </label>

          <div className="mcp-transport-field">
            <span>{t('settings.mcp.authModeLabel')}</span>
            <div className="mcp-transport-switch">
              <button
                type="button"
                className={authMode === 'headers' ? 'active' : ''}
                onClick={() => setAuthMode('headers')}
              >
                {t('settings.mcp.authModeHeaders')}
              </button>
              <button
                type="button"
                className={authMode === 'oauth' ? 'active' : ''}
                onClick={() => setAuthMode('oauth')}
              >
                OAuth
              </button>
            </div>
          </div>

          {authMode === 'oauth' ? (
            <div className="mcp-test-panel">
              <button
                type="button"
                className="mcp-btn secondary mcp-test-button"
                onClick={startAuthorization}
                disabled={authBusy}
              >
                {authBusy
                  ? t('settings.mcp.oauthAuthorizing')
                  : authStatus === 'authorized'
                    ? t('settings.mcp.oauthReauthorize')
                    : t('settings.mcp.oauthAuthorize')}
              </button>
              <p aria-live="polite">
                {authStatus === 'authorized'
                  ? t('settings.mcp.oauthStatusAuthorized')
                  : authStatus === 'expired'
                    ? t('settings.mcp.oauthStatusExpired')
                    : t('settings.mcp.oauthStatusNone')}
              </p>
              {authStatus !== 'none' ? (
                <button
                  type="button"
                  className="theme-inline-action"
                  onClick={revokeAuthorization}
                >
                  {t('settings.mcp.oauthRevoke')}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className={`mcp-test-panel ${testState.status !== 'idle' ? `mcp-test-panel--${testState.status}` : ''}`}>
            <button
              type="button"
              className="mcp-btn secondary mcp-test-button"
              onClick={testConnection}
              disabled={testState.status === 'testing'}
            >
              {testState.status === 'testing' ? t('settings.mcp.testing') : t('settings.mcp.testConnection')}
            </button>
            <p aria-live="polite">
              {testState.status === 'idle'
                ? t('settings.mcp.testIdle')
                : testState.status === 'testing'
                  ? t('settings.mcp.testReading')
                  : testState.message}
            </p>
          </div>

          <div className="mcp-tool-editor">
            <div className="mcp-tool-editor-head">
              <div>
                <span>{t('settings.mcp.toolsSection')}</span>
                <strong>{t('settings.mcp.toolsCount', {
                  enabled: tools.filter((tool) => tool.enabled).length,
                  total: tools.length
                })}</strong>
              </div>
              <button
                type="button"
                className="theme-inline-action"
                onClick={testConnection}
                disabled={testState.status === 'testing'}
              >
                {t('settings.mcp.refreshTools')}
              </button>
            </div>
            {tools.length > 0 ? (
              <div className="mcp-tool-list">
                {tools.map((tool) => (
                  <div key={tool.name} className={`mcp-tool-row ${tool.enabled ? '' : 'is-disabled'}`}>
                    <div className="mcp-tool-copy">
                      <strong>{tool.name}</strong>
                      <span>{tool.description || t('settings.mcp.toolNoDescription')}</span>
                    </div>
                    <button
                      type="button"
                      className={`ps-toggle-sw ${tool.enabled ? 'ps-toggle-sw--on' : ''}`}
                      aria-label={t('settings.mcp.toolToggleAria', {
                        name: tool.name,
                        status: tool.enabled ? t('settings.mcp.statusEnabled') : t('settings.mcp.statusDisabled')
                      })}
                      aria-pressed={tool.enabled}
                      onClick={() =>
                        setTools((current) =>
                          current.map((entry) =>
                            entry.name === tool.name ? { ...entry, enabled: !entry.enabled } : entry
                          )
                        )
                      }
                    >
                      <span className="ps-toggle-knob" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mcp-tool-empty">{t('settings.mcp.toolsEmpty')}</p>
            )}
          </div>

          <div className="mcp-header-editor">
            <div className="mcp-header-editor-head">
              <span>{t('settings.mcp.headersSection')}</span>
              <button
                type="button"
                className="theme-inline-action"
                onClick={() => setHeaders((current) => [...current, createEmptyHeader()])}
              >
                {t('settings.mcp.addHeader')}
              </button>
            </div>
            <div className="mcp-header-editor-list">
              {headers.map((header) => (
                <div key={header.id} className="mcp-header-row">
                  <input
                    value={header.key}
                    onChange={(event) =>
                      setHeaders((current) =>
                        current.map((entry) =>
                          entry.id === header.id ? { ...entry, key: event.target.value } : entry
                        )
                      )
                    }
                    placeholder="Header-Key"
                  />
                  <input
                    value={header.value}
                    onChange={(event) =>
                      setHeaders((current) =>
                        current.map((entry) =>
                          entry.id === header.id ? { ...entry, value: event.target.value } : entry
                        )
                      )
                    }
                    placeholder="Header Value"
                  />
                  <button
                    type="button"
                    className="mcp-icon-button subtle"
                    onClick={() => setHeaders((current) => current.filter((entry) => entry.id !== header.id))}
                    aria-label={t('settings.mcp.deleteHeader')}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mcp-inline-sheet-actions">
          {server && onDelete ? (
            <button type="button" className="mcp-btn danger" onClick={onDelete}>
              {t('settings.mcp.delete')}
            </button>
          ) : null}
          <button type="button" className="mcp-btn secondary" onClick={onClose}>
            {t('settings.mcp.cancel')}
          </button>
          <button type="button" className="mcp-btn primary" onClick={submit}>
            {t('settings.mcp.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
