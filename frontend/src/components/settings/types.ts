import type { ModelSettings, SettingsAPIClient, SkillManifest } from "@/hooks/useAPI";

export interface ModelSettingsSectionProps {
  api: SettingsAPIClient;
  settings: ModelSettings | null;
  highlightAnchor: string | null;
  onActivated: (settings: ModelSettings) => void;
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
