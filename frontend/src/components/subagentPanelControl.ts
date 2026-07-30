const OPEN_EVENT = "biomed:open-subagents";
const CLOSE_EVENT = "biomed:close-subagents";
const TOGGLE_EVENT = "biomed:toggle-subagents";

function dispatch(type: string): void {
  window.dispatchEvent(new Event(type));
}

export function openSubagentPanel(): void {
  dispatch(OPEN_EVENT);
}

export function closeSubagentPanel(): void {
  dispatch(CLOSE_EVENT);
}

export function toggleSubagentPanel(): void {
  dispatch(TOGGLE_EVENT);
}

export const subagentPanelEvents = {
  open: OPEN_EVENT,
  close: CLOSE_EVENT,
  toggle: TOGGLE_EVENT,
} as const;
