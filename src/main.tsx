import React from 'react';
import ReactDOM from 'react-dom/client';
import { installBootRescueSurface } from './app/bootstrap/bootRescueSurface';
import { installClientDiagnosticsReporter } from './app/bootstrap/clientDiagnosticsReporter';
import { installGlobalClientErrorLogging } from './app/bootstrap/clientErrorLog';
import { installMcpOauthCallbackBootstrap } from './app/bootstrap/mcpOauthCallbackBootstrap';
import { installRuntimeStoreLocalDataBackend } from './app/bootstrap/storeLocalDataBackendBootstrap';
import { recordAppRuntimeLogEntry } from './infrastructure/appRuntimeLog';
import { AppErrorBoundary } from './ui/AppErrorBoundary';
import { AppShell } from './ui/AppShell';
import './app/bootstrap/appLayoutSurfaceBootstrap';
import './app/bootstrap/nativeShellBootstrap';
import './styles/tokens.css';
import './styles/base.css';

installGlobalClientErrorLogging();
installClientDiagnosticsReporter();
// Choose the store LocalData backend before any store hydrates or persists: native SQLite when
// available, otherwise the host's KV default. This is the only product runtime install point.
installRuntimeStoreLocalDataBackend();
// Finish an MCP OAuth redirect (`?code=…&state=…`) if this boot is one;
// runs async alongside React mount and no-ops for ordinary boots.
installMcpOauthCallbackBootstrap();
const rootElement = document.getElementById('root');
const bootRescueSurface = installBootRescueSurface({ root: rootElement });

recordAppRuntimeLogEntry({
  at: Date.now(),
  kind: 'startup',
  title: '应用启动',
  detail: 'app-shell · 空 root boot 面承接到 React 挂载'
});

ReactDOM.createRoot(rootElement!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AppShell />
    </AppErrorBoundary>
  </React.StrictMode>
);
bootRescueSurface.watchReactRoot();
