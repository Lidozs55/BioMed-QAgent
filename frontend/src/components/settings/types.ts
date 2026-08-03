import type { RichModelInfo } from "@/components/model-info-card";
import type {
  ModelSettings,
  SkillManifest,
  VendorInfo,
} from "@/hooks/useAPI";

export interface ModelDraftState {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  enableSearch: boolean;
  thinkingMode: boolean;
  modelSearch: string;
  showModelDropdown: boolean;
  showApiKey: boolean;
}

export interface ModelSettingsSectionProps {
  settings: ModelSettings | null;
  vendors: VendorInfo[];
  models: RichModelInfo[];
  modelsLoading: boolean;
  modelsLoaded: boolean;
  draft: ModelDraftState;
  dirty: boolean;
  saving: boolean;
  modelError: string | null;
  highlightAnchor: string | null;
  highlightNonce: number;
  onDraftChange: (patch: Partial<ModelDraftState>) => void;
  onUiChange: (patch: Partial<ModelDraftState>) => void;
  onPreviewModels: () => void;
  onContextWindowChange: (tokens: number) => void;
  onSave: () => void;
}

export interface DatabaseSettingsSectionProps {
  databases: SkillManifest[];
  highlightAnchor: string | null;
  highlightNonce: number;
  onUploadFile: (file: File | undefined) => void;
  onNewDatabase: () => void;
  onEditDatabase: (database: SkillManifest) => void;
  onToggleEnabled: (database: SkillManifest, enabled: boolean) => void;
  onDeleteDatabase: (database: SkillManifest) => void;
}

export interface SkillsSettingsSectionProps {
  skills: SkillManifest[];
  filter: string;
  highlightAnchor: string | null;
  highlightNonce: number;
  onFilterChange: (value: string) => void;
  onInstallFile: (file: File | undefined) => void;
  onToggleEnabled: (skill: SkillManifest, enabled: boolean) => void;
  onShowDetail: (name: string) => void;
  onRollback: (skill: SkillManifest) => void;
  onDeleteSkill: (skill: SkillManifest) => void;
}
