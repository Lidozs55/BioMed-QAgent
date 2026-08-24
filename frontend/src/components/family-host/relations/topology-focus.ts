export function restoreTopologyFocus(trigger: HTMLElement | null): void {
  if (trigger?.isConnected) trigger.focus();
}
