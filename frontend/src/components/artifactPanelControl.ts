const OPEN_EVENT = "biomed:open-artifacts";
const CLOSE_EVENT = "biomed:close-artifacts";
const TOGGLE_EVENT = "biomed:toggle-artifacts";

export function openArtifactPanel(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function closeArtifactPanel(): void {
  window.dispatchEvent(new Event(CLOSE_EVENT));
}

export function toggleArtifactPanel(): void {
  window.dispatchEvent(new Event(TOGGLE_EVENT));
}

export const artifactPanelEvents = {
  open: OPEN_EVENT,
  close: CLOSE_EVENT,
  toggle: TOGGLE_EVENT,
} as const;
