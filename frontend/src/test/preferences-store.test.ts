import { afterEach, describe, expect, it } from "vitest";

import {
  applyPreferencesToDocument,
  isSubmitKey,
  usePreferencesStore,
} from "@/stores/preferencesStore";

function resetPreferences(): void {
  usePreferencesStore.setState({
    showContextUsage: true,
    sendShortcut: "enter",
    followUpMode: "queue",
    translucentSidebar: false,
    contrast: 50,
    pointerCursor: true,
    reducedMotion: "system",
    uiFontSize: 16,
    lightColors: { background: "", foreground: "" },
    darkColors: { background: "", foreground: "" },
  });
  window.localStorage.removeItem("biomed.preferences");
  const root = document.documentElement;
  root.style.fontSize = "";
  root.removeAttribute("data-pointer-cursor");
  root.removeAttribute("data-reduced-motion");
  root.removeAttribute("data-translucent-sidebar");
  root.style.removeProperty("--ui-contrast");
  root.style.removeProperty("--background");
  root.style.removeProperty("--foreground");
  root.style.removeProperty("--muted-foreground");
  root.style.removeProperty("--border");
  root.style.removeProperty("--input");
  root.style.removeProperty("--sidebar");
  applyPreferencesToDocument(usePreferencesStore.getState());
}

afterEach(resetPreferences);

describe("preferences store", () => {
  it("starts with empty-neutral defaults", () => {
    const state = usePreferencesStore.getState();
    expect(state.showContextUsage).toBe(true);
    expect(state.sendShortcut).toBe("enter");
    expect(state.followUpMode).toBe("queue");
    expect(state.translucentSidebar).toBe(false);
    expect(state.contrast).toBe(50);
    expect(state.reducedMotion).toBe("system");
    expect(state.uiFontSize).toBe(16);
    expect(state.lightColors).toEqual({ background: "", foreground: "" });
    expect(state.darkColors).toEqual({ background: "", foreground: "" });
  });

  it("detects submit keys per send shortcut", () => {
    const plainEnter = {
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      nativeEvent: { isComposing: false },
    };
    const shiftEnter = { ...plainEnter, shiftKey: true };
    const ctrlEnter = { ...plainEnter, ctrlKey: true };

    expect(isSubmitKey(plainEnter, "enter")).toBe(true);
    expect(isSubmitKey(shiftEnter, "enter")).toBe(false);
    expect(isSubmitKey(plainEnter, "ctrl-enter")).toBe(false);
    expect(isSubmitKey(ctrlEnter, "ctrl-enter")).toBe(true);
    expect(isSubmitKey({ ...plainEnter, nativeEvent: { isComposing: true } }, "enter")).toBe(
      false,
    );
  });

  it("applies data attributes and font size to the document", () => {
    usePreferencesStore.getState().setSendShortcut("ctrl-enter");
    usePreferencesStore.getState().setPointerCursor(false);
    usePreferencesStore.getState().setReducedMotion("on");
    usePreferencesStore.getState().setUiFontSize(16);

    const root = document.documentElement;
    expect(root.style.fontSize).toBe("16px");
    expect(root.dataset.pointerCursor).toBe("off");
    expect(root.dataset.reducedMotion).toBe("on");
    expect(root.style.getPropertyValue("--ui-contrast")).toBe("50");

    const persisted = JSON.parse(window.localStorage.getItem("biomed.preferences") ?? "{}");
    expect(persisted.sendShortcut).toBe("ctrl-enter");
    expect(persisted.uiFontSize).toBe(16);
  });

  it("applies custom theme colors as CSS variables", () => {
    usePreferencesStore.getState().setLightColors({
      background: "#f8fafc",
      foreground: "#0f172a",
    });

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--background")).toBe("#f8fafc");
    expect(root.style.getPropertyValue("--foreground")).toBe("#0f172a");
    expect(root.style.getPropertyValue("--muted-foreground")).toContain("color-mix");
  });

  it("applies the translucent sidebar override", () => {
    usePreferencesStore.getState().setTranslucentSidebar(true);

    const root = document.documentElement;
    expect(root.dataset.translucentSidebar).toBe("on");
    expect(root.style.getPropertyValue("--sidebar")).toContain("color-mix");
  });

  it("persists the follow-up mode", () => {
    usePreferencesStore.getState().setFollowUpMode("steer");

    expect(usePreferencesStore.getState().followUpMode).toBe("steer");
    const persisted = JSON.parse(window.localStorage.getItem("biomed.preferences") ?? "{}");
    expect(persisted.followUpMode).toBe("steer");
  });

  it("keeps the theme default when contrast stays at 50 without custom colors", () => {
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--muted-foreground")).toBe("");
    expect(root.style.getPropertyValue("--background")).toBe("");
  });
});
