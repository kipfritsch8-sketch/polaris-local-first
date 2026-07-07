import type { PolarisToolPromptGroup } from '../engines/tool-protocol/assistantToolProtocolTypes';
import { create } from 'zustand';
import { createUid } from '../engines/id';
import {
  isPolarisBuiltInProvider
} from '../engines/freeProvider';
import type {
  McpServerConfig,
  PolarisCompanionConnection,
  PolarisCompanionHostState,
  PolarisCompanionSnapshot,
  PolarisTriggerAction,
  PolarisTriggerRule,
  PolarisTriggerSchedule,
  PolarisTriggerTarget,
  ConversationSummaryModelSettings,
  ImageGenerationSettings,
  ImageUnderstandingSettings,
  MemoryVectorRetrievalSettings,
  ProviderProfile,
  VoiceGenerationSettings,
  WebDavConfig,
  WebSearchConfig
} from '../types/domain';
import {
  countUserEditableCustomProviders,
  createCustomProviderProfile,
  DEFAULT_PROVIDER,
  filterVisibleProviders,
  mergeProviderPatch,
  normalizeProviders,
  selectActiveProvider,
  selectVisibleActiveProvider
} from './runtimeStoreProviders';
import { hydrateFromDb, persistToDb } from './runtimeStorePersistence';
import { DEFAULT_RUNTIME_TOOLBOX_STATE } from './runtimeStoreToolbox';
import { DEFAULT_WEBDAV_CONFIG, mergeWebDavPatch } from './runtimeStoreWebDav';
import {
  DEFAULT_RUNTIME_MCP_STATE,
  mergeMcpServerPatch,
  normalizeMcpServer,
  normalizeRuntimeMcpState
} from './runtimeStoreMcp';
import {
  cloneCompanionSnapshot,
  DEFAULT_COMPANION_HOST_STATE,
  normalizeCompanionConnection,
  normalizeCompanionHostState
} from './runtimeStoreCompanion';
import {
  createRuntimeTriggerEvent,
  createRuntimeTriggerRule,
  markRuntimeTriggerFailed,
  markRuntimeTriggerFired,
  updateRuntimeTriggerRule,
  type RuntimeTriggerEvent
} from './runtimeStoreTriggers';
import {
  DEFAULT_WEB_SEARCH_CONFIG,
  mergeWebSearchConfig
} from './runtimeStoreSearch';
import {
  DEFAULT_CONVERSATION_SUMMARY_MODEL_SETTINGS,
  mergeConversationSummaryModelSettings
} from './runtimeStoreConversationSummary';
import {
  DEFAULT_MEMORY_VECTOR_RETRIEVAL_SETTINGS,
  mergeMemoryVectorRetrievalSettings
} from './runtimeStoreMemoryRetrieval';
import {
  DEFAULT_IMAGE_GENERATION_SETTINGS,
  mergeImageGenerationSettings
} from './runtimeStoreImageGeneration';
import {
  DEFAULT_IMAGE_UNDERSTANDING_SETTINGS,
  mergeImageUnderstandingSettings
} from './runtimeStoreImageUnderstanding';
import {
  DEFAULT_VOICE_GENERATION_SETTINGS,
  mergeVoiceGenerationSettings
} from './runtimeStoreVoiceGeneration';

export type RuntimeState = {
  providers: ProviderProfile[];
  activeProviderId: string | null;
  webdav: WebDavConfig;
  search: WebSearchConfig;
  conversationSummaryModel: ConversationSummaryModelSettings;
  memoryVectorRetrieval: MemoryVectorRetrievalSettings;
  imageGeneration: ImageGenerationSettings;
  imageUnderstanding: ImageUnderstandingSettings;
  voiceGeneration: VoiceGenerationSettings;
  toolPromptPreferences: Record<PolarisToolPromptGroup, boolean>;
  taskModeEnabled: boolean;
  mcpServers: McpServerConfig[];
  mcpToolTimeoutSeconds: number;
  companionHost: PolarisCompanionHostState;
  companionConnections: PolarisCompanionConnection[];
  companionSnapshots: Record<string, PolarisCompanionSnapshot | null>;
  triggerRules: PolarisTriggerRule[];
  pendingTriggerEvents: RuntimeTriggerEvent[];
  hydrated: boolean;
  setApiConfig: (patch: Partial<ProviderProfile>) => void;
  setWebDavConfig: (patch: Partial<WebDavConfig>) => void;
  setSearchConfig: (patch: Partial<WebSearchConfig>) => void;
  setConversationSummaryModel: (patch: Partial<ConversationSummaryModelSettings>) => void;
  setMemoryVectorRetrieval: (patch: Partial<MemoryVectorRetrievalSettings>) => void;
  setImageGeneration: (patch: Partial<ImageGenerationSettings>) => void;
  setImageUnderstanding: (patch: Partial<ImageUnderstandingSettings>) => void;
  setVoiceGeneration: (patch: Partial<VoiceGenerationSettings>) => void;
  setToolPromptGroupEnabled: (group: PolarisToolPromptGroup, enabled: boolean) => void;
  setTaskModeEnabled: (enabled: boolean) => void;
  setCompanionHost: (patch: Partial<PolarisCompanionHostState>) => void;
  resetCompanionHostRegistration: () => void;
  addCompanionConnection: (connection: Partial<PolarisCompanionConnection>) => string;
  updateCompanionConnection: (connectionId: string, patch: Partial<PolarisCompanionConnection>) => void;
  deleteCompanionConnection: (connectionId: string) => void;
  setCompanionSnapshot: (connectionId: string, snapshot: PolarisCompanionSnapshot | null) => void;
  createTriggerRule: (seed: {
    name?: string;
    schedule: PolarisTriggerSchedule;
    target: PolarisTriggerTarget;
    action: PolarisTriggerAction;
  }) => string;
  updateTriggerRule: (ruleId: string, patch: Partial<PolarisTriggerRule>) => void;
  deleteTriggerRule: (ruleId: string) => void;
  enqueueTriggerEvent: (seed: { ruleId: string; prompt?: string | null; source: RuntimeTriggerEvent['source'] }) => string;
  consumeTriggerEvent: (ruleId: string) => RuntimeTriggerEvent | null;
  markTriggerFired: (ruleId: string, runAt?: number) => void;
  markTriggerFailed: (ruleId: string, error: string, runAt?: number) => void;
  setMcpServers: (servers: McpServerConfig[]) => void;
  createMcpServer: (seed?: Partial<McpServerConfig>) => string;
  updateMcpServer: (serverId: string, patch: Partial<McpServerConfig>) => void;
  deleteMcpServer: (serverId: string) => void;
  setMcpToolTimeoutSeconds: (seconds: number) => void;
  setActiveProvider: (providerId: string) => void;
  createProvider: (namePrefix?: string) => string;
  importProvider: (provider: Partial<ProviderProfile>) => string;
  duplicateProvider: (providerId: string, duplicateName?: string) => string | null;
  updateProvider: (providerId: string, patch: Partial<ProviderProfile>) => void;
  deleteProvider: (providerId: string) => void;
  hydrateFromDb: () => Promise<boolean>;
  persistToDb: () => Promise<void>;
};

export function selectRuntimeApi(state: Pick<RuntimeState, 'providers' | 'activeProviderId'>): ProviderProfile {
  return selectVisibleActiveProvider(state.providers, state.activeProviderId);
}

export function selectVisibleProviders(state: Pick<RuntimeState, 'providers'>) {
  return filterVisibleProviders(state.providers);
}

function splitBuiltInProviders(providers: ProviderProfile[]) {
  const builtInProviders = providers.filter((provider) => isPolarisBuiltInProvider(provider));
  const customProviders = providers.filter((provider) => !isPolarisBuiltInProvider(provider));
  return { builtInProviders, customProviders };
}

const DEFAULT_RUNTIME_PROVIDERS = normalizeProviders();
const DEFAULT_ACTIVE_PROVIDER_ID = selectActiveProvider(
  DEFAULT_RUNTIME_PROVIDERS,
  DEFAULT_PROVIDER.id
).id;

function areCompanionConnectionsEqual(
  left: PolarisCompanionConnection,
  right: PolarisCompanionConnection
) {
  return Object.keys(left).every((key) => {
    const typedKey = key as keyof PolarisCompanionConnection;
    return left[typedKey] === right[typedKey];
  }) && Object.keys(right).every((key) => {
    const typedKey = key as keyof PolarisCompanionConnection;
    return left[typedKey] === right[typedKey];
  });
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  providers: DEFAULT_RUNTIME_PROVIDERS,
  activeProviderId: DEFAULT_ACTIVE_PROVIDER_ID,
  webdav: {
    ...DEFAULT_WEBDAV_CONFIG
  },
  search: {
    ...DEFAULT_WEB_SEARCH_CONFIG
  },
  conversationSummaryModel: {
    ...DEFAULT_CONVERSATION_SUMMARY_MODEL_SETTINGS
  },
  memoryVectorRetrieval: {
    ...DEFAULT_MEMORY_VECTOR_RETRIEVAL_SETTINGS
  },
  imageGeneration: {
    ...DEFAULT_IMAGE_GENERATION_SETTINGS
  },
  imageUnderstanding: {
    ...DEFAULT_IMAGE_UNDERSTANDING_SETTINGS
  },
  voiceGeneration: {
    ...DEFAULT_VOICE_GENERATION_SETTINGS
  },
  toolPromptPreferences: {
    ...DEFAULT_RUNTIME_TOOLBOX_STATE.toolPromptPreferences
  },
  taskModeEnabled: DEFAULT_RUNTIME_TOOLBOX_STATE.taskModeEnabled,
  mcpServers: DEFAULT_RUNTIME_MCP_STATE.mcpServers,
  mcpToolTimeoutSeconds: DEFAULT_RUNTIME_MCP_STATE.mcpToolTimeoutSeconds,
  companionHost: {
    ...DEFAULT_COMPANION_HOST_STATE
  },
  companionConnections: [],
  companionSnapshots: {},
  triggerRules: [],
  pendingTriggerEvents: [],
  hydrated: false,
  setApiConfig: (patch) =>
    set((state) => {
      const targetId = state.activeProviderId ?? selectRuntimeApi(state).id;
      const providers = state.providers.map((provider) =>
        provider.id === targetId ? mergeProviderPatch(provider, patch) : provider
      );

      return {
        providers,
        activeProviderId: targetId
      };
    }),
  setWebDavConfig: (patch) =>
    set((state) => ({
      webdav: mergeWebDavPatch(state.webdav, patch)
    })),
  setSearchConfig: (patch) =>
    set((state) => ({
      search: mergeWebSearchConfig(state.search, patch)
    })),
  setConversationSummaryModel: (patch) =>
    set((state) => ({
      conversationSummaryModel: mergeConversationSummaryModelSettings(state.conversationSummaryModel, patch)
    })),
  setMemoryVectorRetrieval: (patch) =>
    set((state) => ({
      memoryVectorRetrieval: mergeMemoryVectorRetrievalSettings(state.memoryVectorRetrieval, patch)
    })),
  setImageGeneration: (patch) =>
    set((state) => ({
      imageGeneration: mergeImageGenerationSettings(state.imageGeneration, patch)
    })),
  setImageUnderstanding: (patch) =>
    set((state) => ({
      imageUnderstanding: mergeImageUnderstandingSettings(state.imageUnderstanding, patch)
    })),
  setVoiceGeneration: (patch) =>
    set((state) => ({
      voiceGeneration: mergeVoiceGenerationSettings(state.voiceGeneration, patch)
    })),
  setToolPromptGroupEnabled: (group, enabled) =>
    set((state) => ({
      toolPromptPreferences: {
        ...state.toolPromptPreferences,
        [group]: enabled
      }
    })),
  setTaskModeEnabled: (enabled) =>
    set({
      taskModeEnabled: enabled
    }),
  setCompanionHost: (patch) =>
    set((state) => ({
      companionHost: normalizeCompanionHostState({
        ...state.companionHost,
        ...patch
      })
    })),
  resetCompanionHostRegistration: () =>
    set((state) => ({
      companionHost: normalizeCompanionHostState({
        ...state.companionHost,
        hostId: null,
        hostSecret: null,
        pairCode: null,
        lastRegisteredAt: null,
        error: null
      })
    })),
  addCompanionConnection: (connection) => {
    const nextConnection = normalizeCompanionConnection(connection);
    set((state) => ({
      companionConnections: [...state.companionConnections, nextConnection]
    }));
    return nextConnection.id;
  },
  updateCompanionConnection: (connectionId, patch) =>
    set((state) => {
      let changed = false;
      const companionConnections = state.companionConnections.map((connection) => {
        if (connection.id !== connectionId) return connection;
        const nextConnection = normalizeCompanionConnection({
          ...connection,
          ...patch,
          id: connection.id,
          collaboratorId: connection.collaboratorId
        });
        if (areCompanionConnectionsEqual(connection, nextConnection)) return connection;
        changed = true;
        return nextConnection;
      });
      return changed ? { companionConnections } : state;
    }),
  deleteCompanionConnection: (connectionId) =>
    set((state) => {
      const companionSnapshots = { ...state.companionSnapshots };
      delete companionSnapshots[connectionId];
      return {
        companionConnections: state.companionConnections.filter((connection) => connection.id !== connectionId),
        companionSnapshots
      };
    }),
  setCompanionSnapshot: (connectionId, snapshot) =>
    set((state) => ({
      companionSnapshots: {
        ...state.companionSnapshots,
        [connectionId]: cloneCompanionSnapshot(snapshot)
      }
    })),
  createTriggerRule: (seed) => {
    const rule = createRuntimeTriggerRule(seed);
    set((state) => ({
      triggerRules: [...state.triggerRules, rule]
    }));
    return rule.id;
  },
  updateTriggerRule: (ruleId, patch) =>
    set((state) => ({
      triggerRules: state.triggerRules
        .map((rule) => {
          if (rule.id !== ruleId) return rule;
          return updateRuntimeTriggerRule(rule, patch);
        })
        .filter((rule): rule is PolarisTriggerRule => Boolean(rule))
    })),
  deleteTriggerRule: (ruleId) =>
    set((state) => ({
      triggerRules: state.triggerRules.filter((rule) => rule.id !== ruleId),
      pendingTriggerEvents: state.pendingTriggerEvents.filter((event) => event.ruleId !== ruleId)
    })),
  enqueueTriggerEvent: (seed) => {
    const event = createRuntimeTriggerEvent(seed);
    set((state) => ({
      pendingTriggerEvents: [
        ...state.pendingTriggerEvents.filter((entry) => entry.ruleId !== event.ruleId),
        event
      ]
    }));
    return event.id;
  },
  consumeTriggerEvent: (ruleId) => {
    const event = get().pendingTriggerEvents.find((entry) => entry.ruleId === ruleId) ?? null;
    if (!event) return null;
    set((state) => ({
      pendingTriggerEvents: state.pendingTriggerEvents.filter((entry) => entry.id !== event.id)
    }));
    return event;
  },
  markTriggerFired: (ruleId, runAt) =>
    set((state) => ({
      triggerRules: state.triggerRules.map((rule) =>
        rule.id === ruleId ? markRuntimeTriggerFired(rule, runAt) : rule
      )
    })),
  markTriggerFailed: (ruleId, error, runAt) =>
    set((state) => ({
      triggerRules: state.triggerRules.map((rule) =>
        rule.id === ruleId ? markRuntimeTriggerFailed(rule, error, runAt) : rule
      )
    })),
  // MCP server edits force an immediate persist rather than waiting on the
  // debounced subscription in persistentStoreFlush.ts: these edits are often
  // followed closely by a page reload (an OAuth redirect round-trip is a
  // full reload; testing a fresh connection and then leaving the settings
  // page is a common flow too), and the 180ms debounce plus
  // pagehide/visibilitychange listener is not guaranteed to run to
  // completion before that reload tears the page down.
  setMcpServers: (servers) => {
    set(() => ({
      ...normalizeRuntimeMcpState({
        mcpServers: servers,
        mcpToolTimeoutSeconds: get().mcpToolTimeoutSeconds
      })
    }));
    void get().persistToDb();
  },
  createMcpServer: (seed) => {
    const normalized = normalizeRuntimeMcpState({
      mcpServers: [
        ...get().mcpServers,
        normalizeMcpServer(seed)
      ],
      mcpToolTimeoutSeconds: get().mcpToolTimeoutSeconds
    });
    const nextServer = normalized.mcpServers[normalized.mcpServers.length - 1];
    set({
      mcpServers: normalized.mcpServers
    });
    void get().persistToDb();
    return nextServer?.id ?? '';
  },
  updateMcpServer: (serverId, patch) => {
    set((state) => ({
      mcpServers: normalizeRuntimeMcpState({
        mcpServers: state.mcpServers.map((server) =>
          server.id === serverId ? mergeMcpServerPatch(server, patch) : server
        ),
        mcpToolTimeoutSeconds: state.mcpToolTimeoutSeconds
      }).mcpServers
    }));
    void get().persistToDb();
  },
  deleteMcpServer: (serverId) => {
    set((state) => ({
      mcpServers: state.mcpServers.filter((server) => server.id !== serverId)
    }));
    void get().persistToDb();
  },
  setMcpToolTimeoutSeconds: (seconds) =>
    set((state) => ({
      mcpToolTimeoutSeconds: normalizeRuntimeMcpState({
        mcpServers: state.mcpServers,
        mcpToolTimeoutSeconds: seconds
      }).mcpToolTimeoutSeconds
    })),
  setActiveProvider: (providerId) =>
    set((state) => {
      const nextApi = selectActiveProvider(state.providers, providerId);
      return {
        activeProviderId: nextApi.id
      };
    }),
  createProvider: (namePrefix = '新线路') => {
    const providerId = createUid('provider');
    set((state) => {
      const customProviderCount = countUserEditableCustomProviders(state.providers);
      const nextProvider = createCustomProviderProfile({
        id: providerId,
        name: `${namePrefix} ${customProviderCount + 1}`
      }, customProviderCount);
      const { builtInProviders, customProviders } = splitBuiltInProviders(state.providers);
      const providers = [
        ...builtInProviders,
        nextProvider,
        ...customProviders.filter((provider) => (
          provider.id !== DEFAULT_PROVIDER.id
          || provider.baseUrl.trim()
          || provider.apiKey.trim()
          || provider.model.trim()
          || provider.name.trim() !== DEFAULT_PROVIDER.name
        ))
      ];
      return {
        providers,
        activeProviderId: nextProvider.id
      };
    });
    return providerId;
  },
  importProvider: (provider) => {
    const providerId = createUid('provider');
    set((state) => {
      const customProviderCount = countUserEditableCustomProviders(state.providers);
      const nextProvider = createCustomProviderProfile({
        ...provider,
        id: providerId
      }, customProviderCount);
      const { builtInProviders, customProviders } = splitBuiltInProviders(state.providers);
      const providers = [
        ...builtInProviders,
        nextProvider,
        ...customProviders.filter((entry) => (
          entry.id !== DEFAULT_PROVIDER.id
          || entry.baseUrl.trim()
          || entry.apiKey.trim()
          || entry.model.trim()
          || entry.name.trim() !== DEFAULT_PROVIDER.name
        ))
      ];

      return {
        providers,
        activeProviderId: nextProvider.id
      };
    });
    return providerId;
  },
  duplicateProvider: (providerId, duplicateName) => {
    const source = get().providers.find((provider) => provider.id === providerId);
    if (!source) return null;
    if (isPolarisBuiltInProvider(source)) return null;

    const nextId = createUid('provider');
    const nextProvider: ProviderProfile = {
      ...source,
      capabilities: {
        ...source.capabilities
      },
      id: nextId,
      name: duplicateName ?? `${source.name} 副本`
    };

    set((state) => {
      const { builtInProviders, customProviders } = splitBuiltInProviders(state.providers);
      return {
        providers: [...builtInProviders, nextProvider, ...customProviders],
        activeProviderId: nextId
      };
    });

    return nextId;
  },
  updateProvider: (providerId, patch) =>
    set((state) => {
      const providers = state.providers.map((provider) =>
        provider.id === providerId ? mergeProviderPatch(provider, patch) : provider
      );

      return {
        providers
      };
    }),
  deleteProvider: (providerId) =>
    set((state) => {
      if (state.providers.some((provider) => provider.id === providerId && isPolarisBuiltInProvider(provider))) {
        return state;
      }
      const providers = state.providers.filter((provider) => provider.id !== providerId);
      const normalized = providers.length
        ? providers
        : normalizeProviders();
      const activeProviderId =
        state.activeProviderId === providerId ? normalized[0]?.id ?? DEFAULT_PROVIDER.id : state.activeProviderId;

      return {
        providers: normalized,
        activeProviderId
      };
  }),
  hydrateFromDb: async () => {
    let result: Awaited<ReturnType<typeof hydrateFromDb>>;
    try {
      result = await hydrateFromDb({ throwOnReadFailure: true });
    } catch {
      return false;
    }
    if (result) {
      const { payload } = result;
      set({
        providers: payload.providers,
        activeProviderId: payload.activeProviderId,
        webdav: payload.webdav,
        search: payload.search,
        conversationSummaryModel: payload.conversationSummaryModel,
        memoryVectorRetrieval: payload.memoryVectorRetrieval,
        imageGeneration: payload.imageGeneration,
        imageUnderstanding: payload.imageUnderstanding,
        voiceGeneration: payload.voiceGeneration,
        toolPromptPreferences: payload.toolPromptPreferences,
        taskModeEnabled: payload.taskModeEnabled,
        mcpServers: payload.mcpServers,
        mcpToolTimeoutSeconds: payload.mcpToolTimeoutSeconds,
        companionHost: payload.companionHost,
        companionConnections: payload.companionConnections,
        triggerRules: payload.triggerRules,
        pendingTriggerEvents: [],
        hydrated: true
      });
      return result.shouldPersist;
    }

    set({ hydrated: true });
    return false;
  },
  persistToDb: async () => {
    const {
      providers,
      activeProviderId,
      webdav,
      search,
      conversationSummaryModel,
      memoryVectorRetrieval,
      imageGeneration,
      imageUnderstanding,
      voiceGeneration,
      toolPromptPreferences,
      taskModeEnabled,
      mcpServers,
      mcpToolTimeoutSeconds,
      companionHost,
      companionConnections,
      triggerRules
    } = get();
    await persistToDb({
      providers,
      activeProviderId,
      webdav,
      search,
      conversationSummaryModel,
      memoryVectorRetrieval,
      imageGeneration,
      imageUnderstanding,
      voiceGeneration,
      toolPromptPreferences,
      taskModeEnabled,
      mcpServers,
      mcpToolTimeoutSeconds,
      companionHost,
      companionConnections,
      triggerRules
    });
  }
}));
