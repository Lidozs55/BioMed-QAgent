export function experimentalPiUiEnabled(
  buildValue: unknown = import.meta.env.VITE_PI_EXPERIMENTAL_UI,
  runtimeValue: unknown =
    typeof window === "undefined"
      ? undefined
      : window.__BIOMED_RUNTIME_CONFIG__?.piExperimentalUi,
): boolean {
  return buildValue === "1" || buildValue === true || runtimeValue === true;
}
