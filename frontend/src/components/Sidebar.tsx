import { useAgentStore } from "../stores/agentStore";

/** 侧边栏 — 连接状态 + 使用说明。 */
export function Sidebar() {
  const { isConnected, isRunning } = useAgentStore();

  return (
    <div className="app-sidebar">
      <div className="sidebar-title">BioMed QAgent</div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">后端状态</div>
        <span className={`status-badge ${isConnected ? "connected" : "disconnected"}`}>
          {isConnected ? "已连接" : "未连接"}
        </span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">Agent Loop</div>
        <span className={`status-badge ${isRunning ? "connected" : "disconnected"}`}>
          {isRunning ? "运行中" : "空闲"}
        </span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">架构</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          v1 — Agent Loop
          <br />
          前端 + 后端 {"{"}agentloop + 工具 + skill{"}"}
          <br />
          基于 openai-agents-python
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">说明</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          数据获取接口暂为占位，
          Agent 可正常对话与读写文件。
        </div>
      </div>
    </div>
  );
}
