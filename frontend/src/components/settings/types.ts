import type { DatabaseItem, ManagedModelInfo, ModelSettings, ProviderInfo, SettingsAPIClient } from "@/hooks/useAPI";

export interface ModelSettingsSectionProps {
  api: SettingsAPIClient;
  settings: ModelSettings | null;
  highlightAnchor: string | null;
  onActivated: (settings: ModelSettings) => void;
}

/** Props for the explicit visual-extraction model role selector. */
export interface VisionModelSelectorProps {
  api: SettingsAPIClient;
  settings: ModelSettings;
  managedModels: ManagedModelInfo[];
  providers: ProviderInfo[];
  onSaved: (settings: ModelSettings) => void;
}

export interface DatabaseSettingsSectionProps {
  databases: DatabaseItem[];
  highlightAnchor: string | null;
  highlightNonce: number;
  onNewDatabase: () => void;
  onEditDatabase: (database: DatabaseItem) => void;
  onToggleEnabled: (database: DatabaseItem, enabled: boolean) => void;
  onDeleteDatabase: (database: DatabaseItem) => void;
}
