import {
  CheckCircleIcon,
  ClockCountdownIcon,
  ProhibitIcon,
  StopCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { Spinner } from "@/components/ui/spinner";
import type { RunStatus } from "@/runtime/contracts";

export function TaskStatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case "queued":
      return <ClockCountdownIcon aria-hidden="true" />;
    case "running":
    case "finalizing":
    case "cancel_requested":
    case "awaiting_user_input":
      return <Spinner aria-hidden="true" />;
    case "completed":
      return <CheckCircleIcon aria-hidden="true" />;
    case "failed":
      return <WarningCircleIcon aria-hidden="true" />;
    case "cancelled":
      return <ProhibitIcon aria-hidden="true" />;
    case "interrupted":
      return <StopCircleIcon aria-hidden="true" />;
  }
}
