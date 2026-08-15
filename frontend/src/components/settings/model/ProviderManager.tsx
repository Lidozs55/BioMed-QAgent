import { useEffect, useState } from "react";
import { EyeClosedIcon, EyeIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { ProviderInfo, ProviderInput, SettingsAPIClient, VendorInfo } from "@/hooks/useAPI";

interface ProviderManagerProps {
  api: SettingsAPIClient;
  providers: ProviderInfo[];
  loading: boolean;
  onChanged: () => void;
}

interface ProviderDraft {
  name: string;
  baseUrl: string;
  apiKey: string;
  presetId: string | null;
}

const EMPTY_DRAFT: ProviderDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  presetId: null,
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export function ProviderManager({ api, providers, loading, onChanged }: ProviderManagerProps) {
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderInfo | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(EMPTY_DRAFT);
  const [showKey, setShowKey] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api
        .fetchVendors()
        .then(setVendors)
        .catch((error) => {
          toast.error("供应商预设加载失败", { description: errorText(error) });
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [api]);

  const afterMutation = async () => {
    try {
      await onChanged();
    } catch (error) {
      toast.error("供应商列表刷新失败", { description: errorText(error) });
    }
  };

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setShowKey(false);
    setDialogOpen(true);
  };

  const openEdit = (provider: ProviderInfo) => {
    setEditing(provider);
    setDraft({
      name: provider.name,
      baseUrl: provider.base_url,
      apiKey: "",
      presetId: provider.preset_id,
    });
    setShowKey(false);
    setDialogOpen(true);
  };

  const applyPreset = (vendor: VendorInfo) => {
    setDraft((previous) => ({
      ...previous,
      name: previous.name.trim() ? previous.name : vendor.name,
      baseUrl: vendor.base_url,
      presetId: vendor.id,
    }));
  };

  const save = async () => {
    const name = draft.name.trim();
    const baseUrl = draft.baseUrl.trim();
    if (!name) {
      toast.error("请输入供应商名称");
      return;
    }
    if (!baseUrl) {
      toast.error("请输入 Base URL");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api.updateProvider(editing.id, {
          name,
          base_url: baseUrl,
          ...(draft.presetId ? { preset_id: draft.presetId } : {}),
          ...(draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
        });
        toast.success("供应商已更新");
      } else {
        const input: ProviderInput = {
          name,
          base_url: baseUrl,
          ...(draft.presetId ? { preset_id: draft.presetId } : {}),
          ...(draft.apiKey.trim() ? { api_key: draft.apiKey.trim() } : {}),
        };
        await api.createProvider(input);
        toast.success("供应商已添加");
      }
      setDialogOpen(false);
      await afterMutation();
    } catch (error) {
      toast.error("保存失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (provider: ProviderInfo) => {
    try {
      await api.deleteProvider(provider.id);
      toast.success(`供应商 "${provider.name}" 已删除`);
      await afterMutation();
    } catch (error) {
      toast.error("删除失败", { description: errorText(error) });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          管理模型供应商：名称仅作为代号，配合 Base URL 与 API Key 使用。
        </p>
        <Button size="sm" onClick={openCreate}>
          <PlusIcon data-icon="inline-start" />
          添加供应商
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Spinner />
        </div>
      ) : providers.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有供应商，点击“添加供应商”开始配置。
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{provider.name}</span>
                  {provider.api_key_configured && (
                    <Badge variant="secondary" className="shrink-0">
                      已配置密钥
                    </Badge>
                  )}
                  {!provider.enabled && <Badge variant="outline">已停用</Badge>}
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {provider.base_url}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => openEdit(provider)}>
                  编辑
                </Button>
                {confirmDeleteId === provider.id ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void remove(provider)}
                  >
                    确认删除
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setConfirmDeleteId(provider.id)}
                  >
                    删除
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "编辑供应商" : "添加供应商"}</DialogTitle>
            <DialogDescription>
              名称只是一个代号；选择常用供应商可快速填入 Base URL。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {!editing && vendors.length > 0 && (
              <Field>
                <FieldLabel>快捷填入</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {vendors.map((vendor) => (
                    <Button
                      key={vendor.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => applyPreset(vendor)}
                    >
                      {vendor.name}
                    </Button>
                  ))}
                </div>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="provider-name">供应商名称（代号）</FieldLabel>
              <Input
                id="provider-name"
                value={draft.name}
                placeholder="例如：我的 DeepSeek"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-base-url">Base URL</FieldLabel>
              <Input
                id="provider-base-url"
                value={draft.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="provider-api-key">API Key</FieldLabel>
              <div className="relative">
                <Input
                  id="provider-api-key"
                  type={showKey ? "text" : "password"}
                  value={draft.apiKey}
                  placeholder={editing?.api_key_configured ? "留空则保持不变" : "sk-..."}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  className="pr-8"
                />
                <button
                  type="button"
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowKey((next) => !next)}
                  tabIndex={-1}
                >
                  {showKey ? <EyeClosedIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
            </Field>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <WarningIcon className="size-3.5 shrink-0" />
              密钥仅保存在本地数据库中，用于模型发现与调用。
            </p>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
