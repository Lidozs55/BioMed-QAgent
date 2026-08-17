import type { PendingPermission } from "@/runtime/types";

export type PermissionPrimaryAnswer = "allow_once" | "deny" | "other";
export type PermissionGrantAnswer = "run" | "task" | "persistent" | "scope_wide";
export type PermissionScopeDurationAnswer = "run" | "task";

export interface PermissionResolution {
  decision: "allow" | "deny";
  grantScope?: "once" | "run" | "task" | "persistent";
  scopeWide?: boolean;
}

export function canGrantWholeScope(permission: PendingPermission): boolean {
  return permission.capability !== "process.exec" &&
    (permission.scope === "project" ||
      permission.scope === "external" ||
      permission.scope === "sensitive");
}

export function permissionQuestionnaireItems(
  permission: PendingPermission,
  primary: PermissionPrimaryAnswer | null,
  grant: PermissionGrantAnswer | null,
) {
  const grantChoices: Array<{ value: PermissionGrantAnswer }> = [
    { value: "run" },
    { value: "task" },
    { value: "persistent" },
  ];
  if (canGrantWholeScope(permission)) {
    grantChoices.push({ value: "scope_wide" });
  }

  return [
    {
      name: "decision",
      required: true,
      choices: [
        { value: "allow_once" },
        { value: "deny" },
        { value: "other" },
      ],
    },
    {
      name: "grant",
      required: true,
      disabled: primary !== "other",
      choices: grantChoices,
    },
    {
      name: "scope_duration",
      required: true,
      disabled: primary !== "other" || grant !== "scope_wide",
      choices: [{ value: "run" }, { value: "task" }],
    },
  ] as const;
}

export function permissionResolutionFromForm(form: FormData): PermissionResolution | null {
  const decision = form.get("decision");
  if (decision === "deny") return { decision: "deny" };
  if (decision === "allow_once") {
    return { decision: "allow", grantScope: "once" };
  }
  if (decision !== "other") return null;

  const grant = form.get("grant");
  if (grant === "run" || grant === "task" || grant === "persistent") {
    return { decision: "allow", grantScope: grant };
  }
  if (grant !== "scope_wide") return null;

  const scopeDuration = form.get("scope_duration");
  if (scopeDuration !== "run" && scopeDuration !== "task") return null;
  return {
    decision: "allow",
    grantScope: scopeDuration,
    scopeWide: true,
  };
}
