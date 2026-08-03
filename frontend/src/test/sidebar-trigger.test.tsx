import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

beforeAll(() => {
  window.matchMedia = () => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
});

describe("SidebarTrigger", () => {
  it("shows hide navigation with Ctrl+B blocks when expanded", async () => {
    render(
      <SidebarProvider defaultOpen={true}>
        <SidebarTrigger aria-label="Toggle sidebar" />
      </SidebarProvider>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Toggle sidebar" }));

    expect(await screen.findByText("隐藏导航")).toBeVisible();
    expect(screen.getByText("Ctrl")).toBeVisible();
    expect(screen.getByText("B")).toBeVisible();
  });

  it("shows expand navigation with Ctrl+B blocks when collapsed", async () => {
    render(
      <SidebarProvider defaultOpen={false}>
        <SidebarTrigger aria-label="Toggle sidebar" />
      </SidebarProvider>,
    );

    fireEvent.focus(screen.getByRole("button", { name: "Toggle sidebar" }));

    expect(await screen.findByText("展开导航")).toBeVisible();
    expect(screen.getByText("Ctrl")).toBeVisible();
    expect(screen.getByText("B")).toBeVisible();
  });
});