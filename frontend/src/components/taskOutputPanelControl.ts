import type { TaskOutputTab } from "@/components/TaskOutputPanel";

export const TASK_OUTPUT_OPEN_EVENT = "biomed:open-task-output";
export const TASK_OUTPUT_CLOSE_EVENT = "biomed:close-task-output";
export const TASK_OUTPUT_TOGGLE_EVENT = "biomed:toggle-task-output";

function dispatch(type: string): void {
  window.dispatchEvent(new Event(type));
}

export function openTaskOutputPanel(tab?: TaskOutputTab): void {
  window.dispatchEvent(new CustomEvent(TASK_OUTPUT_OPEN_EVENT, { detail: { tab } }));
}

export function closeTaskOutputPanel(): void {
  dispatch(TASK_OUTPUT_CLOSE_EVENT);
}

export function toggleTaskOutputPanel(): void {
  dispatch(TASK_OUTPUT_TOGGLE_EVENT);
}
