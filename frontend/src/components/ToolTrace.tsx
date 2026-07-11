import { useAgentStore } from "../stores/agentStore";

/** 工具调用轨迹面板 — 实时展示 Agent loop 中的工具调用链。 */
export function ToolTrace() {
  const { traces } = useAgentStore();

  return (
    <div className="trace-panel">
      <div className="trace-title">工具调用轨迹</div>
      {traces.length === 0 && (
        <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          Agent loop 尚无工具调用
        </div>
      )}
      {traces.map((t) => (
        <div key={t.id} className={`trace-item ${t.kind}`}>
          {t.kind === "tool_call" && (
            <>
              <div className="trace-item-name">调用: {t.name}</div>
              {t.arguments && (
                <div className="trace-item-args">{t.arguments}</div>
              )}
            </>
          )}
          {t.kind === "tool_output" && (
            <>
              <div className="trace-item-name">结果</div>
              <div className="trace-item-output">{t.output}</div>
            </>
          )}
          {t.kind === "error" && (
            <>
              <div className="trace-item-name">错误</div>
              <div className="trace-item-output">{t.message}</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
