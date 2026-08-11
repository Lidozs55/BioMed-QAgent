import loadingMark from "../../../assets/logo/biomed-qagent-loading-mark.svg";

export function LoadingScreen() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="正在加载对话"
      className="flex h-full min-h-0 min-w-0 items-center justify-center bg-background"
    >
      <div className="flex flex-col items-center gap-5">
        <img
          src={loadingMark}
          alt="BioMed QAgent"
          draggable={false}
          className="h-24 w-24 animate-pulse"
        />
        <p className="text-sm text-muted-foreground">正在加载对话…</p>
      </div>
    </div>
  );
}
