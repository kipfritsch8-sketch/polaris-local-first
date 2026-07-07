// Completes an MCP OAuth redirect when the app boots back up.
//
// The authorize flow leaves the page entirely (full redirect to the
// authorization server), so the return trip lands on a fresh boot with
// `?code=…&state=…` in the URL. This bootstrap recognizes a state we
// started, exchanges the code for tokens, scrubs the query string, and —
// once the runtime store has hydrated — saves or updates the MCP server the
// flow was started for. Non-OAuth boots return immediately.

import {
  completeMcpOauthCallback,
  detectMcpOauthCallback
} from '../../engines/mcpOauthFlow';
import { takeMcpOauthPendingFlow } from '../../engines/mcpOauthStore';
import { recordAppRuntimeLogEntry } from '../../infrastructure/appRuntimeLog';
import { useRuntimeStore } from '../../stores/runtimeStore';
import type { McpServerConfig } from '../../types/domain';

function scrubOauthParamsFromUrl() {
  try {
    const url = new URL(window.location.href);
    for (const key of ['code', 'state', 'error', 'error_description', 'iss']) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(null, '', url.toString());
  } catch {
    // leaving the params visible is cosmetic only
  }
}

async function waitForRuntimeHydration(timeoutMs: number) {
  if (useRuntimeStore.getState().hydrated) return true;
  return await new Promise<boolean>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      unsubscribe();
      resolve(useRuntimeStore.getState().hydrated);
    }, timeoutMs);
    const unsubscribe = useRuntimeStore.subscribe((state) => {
      if (!state.hydrated) return;
      globalThis.clearTimeout(timeoutId);
      unsubscribe();
      resolve(true);
    });
  });
}

function upsertAuthorizedServer(result: {
  serverUrl: string;
  serverId?: string;
  serverDraft?: Partial<McpServerConfig>;
}) {
  const store = useRuntimeStore.getState();
  const draft: Partial<McpServerConfig> = { ...(result.serverDraft ?? {}), authMode: 'oauth' };
  const existingById = result.serverId
    ? store.mcpServers.find((server) => server.id === result.serverId)
    : undefined;
  if (existingById) {
    store.updateMcpServer(existingById.id, draft);
    return existingById.name;
  }
  const existingByUrl = store.mcpServers.find(
    (server) => server.url.trim().replace(/\/+$/, '') === result.serverUrl
  );
  if (existingByUrl) {
    store.updateMcpServer(existingByUrl.id, draft);
    return existingByUrl.name;
  }
  store.createMcpServer(draft);
  return typeof draft.name === 'string' && draft.name ? draft.name : result.serverUrl;
}

export function installMcpOauthCallbackBootstrap() {
  if (typeof window === 'undefined') return;
  const callback = detectMcpOauthCallback(window.location.href);
  if (!callback) return;

  void (async () => {
    try {
      if (callback.error || !callback.code) {
        // Only consume flows we started; a foreign `state` is left alone.
        const pending = takeMcpOauthPendingFlow(callback.state);
        if (!pending) return;
        scrubOauthParamsFromUrl();
        window.alert(`MCP OAuth 授权被拒绝或失败：${callback.errorDescription || callback.error || '缺少授权码'}`);
        return;
      }

      const result = await completeMcpOauthCallback({
        state: callback.state,
        code: callback.code
      });
      if (!result) return;
      scrubOauthParamsFromUrl();

      await waitForRuntimeHydration(15_000);
      const serverName = upsertAuthorizedServer(result);
      // This boot is a full-page reload landing straight from the redirect;
      // the store's normal debounced persist has no lifecycle event to rely
      // on if the page is closed or reloaded again in the next moment. Force
      // an immediate write so the newly authorized server survives that.
      await useRuntimeStore.getState().persistToDb().catch((error) => {
        recordAppRuntimeLogEntry({
          at: Date.now(),
          kind: 'startup',
          title: 'MCP OAuth 授权后写入本地数据库失败',
          detail: error instanceof Error ? error.message : String(error)
        });
      });
      recordAppRuntimeLogEntry({
        at: Date.now(),
        kind: 'startup',
        title: 'MCP OAuth 授权完成',
        detail: `server=${result.serverUrl}`
      });
      window.alert(`MCP 服务「${serverName}」OAuth 授权成功，已保存配置。可以去 MCP 设置里测试连接了。`);
    } catch (error) {
      scrubOauthParamsFromUrl();
      window.alert(`MCP OAuth 授权失败：${error instanceof Error ? error.message : String(error)}`);
    }
  })();
}
