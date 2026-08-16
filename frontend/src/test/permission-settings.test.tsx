import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentPermissionSettingsSection } from "@/components/settings/sections/AgentPermissionSettingsSection";
import type { SettingsAPIClient } from "@/api/types";

function mockApi(overrides: Partial<SettingsAPIClient> = {}): SettingsAPIClient {
  const base: SettingsAPIClient = {
    fetchSettings: vi.fn(),
    saveSettings: vi.fn(),
    fetchPersonalization: vi.fn(),
    savePersonalization: vi.fn(),
    fetchVendors: vi.fn(),
    fetchModels: vi.fn(),
    fetchProviders: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    discoverProviderModels: vi.fn(),
    fetchProviderParamSpecs: vi.fn(),
    fetchManagedModels: vi.fn(),
    createManagedModel: vi.fn(),
    updateManagedModel: vi.fn(),
    deleteManagedModel: vi.fn(),
    activateManagedModel: vi.fn(),
    fetchDatabases: vi.fn(),
    fetchDatabase: vi.fn(),
    setDatabaseEnabled: vi.fn(),
    createDatabase: vi.fn(),
    updateDatabase: vi.fn(),
    deleteDatabase: vi.fn(),
    fetchAgentPermissions: vi.fn().mockResolvedValue({
      schema_version: 1,
      preset: "ask_when_needed",
      rules: [],
      persistent_exec_allow: false,
    }),
    setAgentPermissionsPreset: vi.fn(),
    setAgentPermissionsPersistentExec: vi.fn(),
    addAgentPermissionRule: vi.fn(),
    removeAgentPermissionRule: vi.fn(),
    fetchAgentTempGrants: vi.fn().mockResolvedValue([]),
    revokeAgentTempGrant: vi.fn(),
    ...overrides,
  };
  return base;
}

describe("AgentPermissionSettingsSection (P6)", () => {
  it("renders the preset selector and empty rule list", async () => {
    render(<AgentPermissionSettingsSection api={mockApi()} />);
    await waitFor(() => {
      expect(screen.getAllByText("权限模式").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/访问项目或外部文件、执行命令时询问你/)).toBeTruthy();
    expect(screen.getByText(/暂无持久规则/)).toBeTruthy();
  });

  it("switches the preset through the API", async () => {
    const setPreset = vi.fn().mockResolvedValue({
      schema_version: 1,
      preset: "full_access",
      rules: [],
      persistent_exec_allow: false,
    });
    render(<AgentPermissionSettingsSection api={mockApi({ setAgentPermissionsPreset: setPreset })} />);
    await waitFor(() => {
      expect(screen.getAllByText("权限模式").length).toBeGreaterThan(0);
    });
    const select = screen.getAllByRole("combobox")[0];
    fireEvent.click(select);
    const option = await screen.findByRole("option", { name: "完全访问" });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => {
      expect(setPreset).toHaveBeenCalledWith("full_access");
    });
  });

  it("lists persistent rules and removes them", async () => {
    const removeRule = vi.fn().mockResolvedValue({
      schema_version: 1,
      preset: "ask_when_needed",
      rules: [],
      persistent_exec_allow: false,
    });
    render(<AgentPermissionSettingsSection api={mockApi({
      removeAgentPermissionRule: removeRule,
      fetchAgentPermissions: vi.fn().mockResolvedValue({
        schema_version: 1,
        preset: "ask_when_needed",
        rules: [{
          id: "rule_1",
          capability: "fs.read",
          path: "D:\\datasets\\TCGA",
          recursive: true,
          policy: "allow",
        }],
        persistent_exec_allow: false,
      }),
    })} />);
    await waitFor(() => {
      expect(screen.getByText("D:\\datasets\\TCGA")).toBeTruthy();
    });
    expect(screen.getByText("读取")).toBeTruthy();
    expect(screen.getByText("递归")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /删除规则/ }));
    await waitFor(() => {
      expect(removeRule).toHaveBeenCalledWith("rule_1");
    });
  });

  it("shows the persistent exec warning when commands are always allowed", async () => {
    render(<AgentPermissionSettingsSection api={mockApi({
      fetchAgentPermissions: vi.fn().mockResolvedValue({
        schema_version: 1,
        preset: "ask_when_needed",
        rules: [],
        persistent_exec_allow: true,
      }),
    })} />);
    await waitFor(() => {
      expect(screen.getAllByText(/始终允许命令执行/).length).toBeGreaterThan(0);
    });
  });

  it("toggles the persistent exec switch through the API", async () => {
    const setPersistentExec = vi.fn().mockResolvedValue({
      schema_version: 1,
      preset: "ask_when_needed",
      rules: [],
      persistent_exec_allow: false,
    });
    render(<AgentPermissionSettingsSection api={mockApi({
      setAgentPermissionsPersistentExec: setPersistentExec,
    })} />);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "始终允许命令执行" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("switch", { name: "始终允许命令执行" }));
    await waitFor(() => {
      expect(setPersistentExec).toHaveBeenCalledWith(true);
    });
  });

  it("disables the persistent exec switch under the Restricted preset", async () => {
    render(<AgentPermissionSettingsSection api={mockApi({
      fetchAgentPermissions: vi.fn().mockResolvedValue({
        schema_version: 1,
        preset: "restricted",
        rules: [],
        persistent_exec_allow: true,
      }),
    })} />);
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "始终允许命令执行" })).toHaveAttribute("aria-disabled", "true");
    });
    expect(screen.getByText(/受限模式下命令执行始终拒绝/)).toBeTruthy();
  });
});

describe("AgentPermissionSettingsSection temp grants + rule creation (round-3 audit)", () => {
  it("lists active temp grants and revokes them through the API", async () => {
    const revokeGrant = vi.fn().mockResolvedValue(undefined);
    const fetchGrants = vi.fn().mockResolvedValue([
      {
        id: "grant_1",
        capability: "fs.read",
        scope: "external",
        root: "D:\\datasets\\TCGA",
        boundTo: "run",
        taskId: "task_ts_1",
        runId: "run_ts_1",
        grantedAt: "2026-08-17T00:00:00Z",
      },
      {
        id: "grant_2",
        capability: "process.exec",
        scope: "workspace",
        root: null,
        boundTo: "task",
        taskId: "task_ts_1",
        runId: "run_ts_1",
        grantedAt: "2026-08-17T00:00:00Z",
      },
    ]);
    render(<AgentPermissionSettingsSection api={mockApi({
      fetchAgentTempGrants: fetchGrants,
      revokeAgentTempGrant: revokeGrant,
    })} />);
    await waitFor(() => {
      expect(screen.getByText("D:\\datasets\\TCGA")).toBeTruthy();
    });
    // A whole-scope (root null) grant is labeled explicitly.
    expect(screen.getByText(/整个工作区范围/)).toBeTruthy();
    expect(screen.getByText("本 Run")).toBeTruthy();
    expect(screen.getByText("本 Task")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "撤销此授权" })[0] as HTMLElement);
    await waitFor(() => {
      expect(revokeGrant).toHaveBeenCalledWith("grant_1");
    });
  });

  it("creates a persistent rule from the form", async () => {
    const addRule = vi.fn().mockResolvedValue({
      schema_version: 1,
      preset: "ask_when_needed",
      rules: [],
      persistent_exec_allow: false,
    });
    render(<AgentPermissionSettingsSection api={mockApi({ addAgentPermissionRule: addRule })} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /添加规则/ })).toBeTruthy();
    });
    fireEvent.change(screen.getByLabelText(/路径（绝对路径，自动规范化）/), {
      target: { value: "D:\\datasets\\TCGA" },
    });
    fireEvent.click(screen.getByRole("button", { name: /添加规则/ }));
    await waitFor(() => {
      expect(addRule).toHaveBeenCalledWith({
        capability: "fs.read",
        resource_scope: "project",
        path: "D:\\datasets\\TCGA",
        recursive: true,
        policy: "allow",
      });
    });
  });
});
