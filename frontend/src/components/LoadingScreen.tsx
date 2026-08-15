import loadingMark from "../../../assets/logo/Logo.svg";

export function LoadingScreen() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="正在加载对话"
      className="flex h-full min-h-0 min-w-0 items-center justify-center bg-background"
    >
      <div className="flex flex-col items-center gap-5">
        {/* 品牌 logo 呼吸动画为有意保留；占位符场景应使用 Skeleton 组件 */}
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
