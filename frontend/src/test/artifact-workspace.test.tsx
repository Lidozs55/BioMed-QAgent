import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactWorkspace,
} from "@/components/ArtifactWorkspace";
import {
  closeArtifactPanel,
  openArtifactPanel,
  toggleArtifactPanel,
} from "@/components/artifactPanelControl";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

describe("ArtifactWorkspace", () => {
  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("exposes programmatic open, close, and toggle controls", () => {
    const { container } = render(
      <ArtifactWorkspace>
        <div>Conversation</div>
      </ArtifactWorkspace>,
    );

    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();

    act(() => openArtifactPanel());
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "产物" })).toBeVisible();
    expect(screen.getByText("产物生成后会显示在这里")).toBeVisible();

    act(() => closeArtifactPanel());
    expect(container.querySelector('[data-slot="resizable-panel-group"]')).not.toBeInTheDocument();

    act(() => toggleArtifactPanel());
    expect(container.querySelectorAll('[data-slot="resizable-panel"]')).toHaveLength(2);
  });
});
