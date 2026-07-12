import { useAgentStore } from "../stores/agentStore";
import { useAPI } from "../hooks/useAPI";

/** 侧边栏 — 连接状态 + 产物列表 + 使用说明。 */
export function Sidebar() {
  const { isConnected, isRunning, databases, selectedDatabases, artifacts, taskId } =
    useAgentStore();
  const { getArtifactUrl } = useAPI();

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

      {databases.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            已加载数据源 ({databases.length})
          </div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            {selectedDatabases.length > 0
              ? `已选 ${selectedDatabases.length}/${databases.length} 个`
              : "未选择数据源"}
          </div>
        </div>
      )}

      {taskId && artifacts.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">
            产物 ({artifacts.length})
          </div>
          {artifacts.map((a) => (
            <div key={a.name} style={{ fontSize: 12, marginBottom: 4 }}>
              <a
                href={getArtifactUrl(taskId, a.name)}
                download
                style={{ color: "var(--accent)" }}
              >
                {a.name}
              </a>
              <span style={{ color: "var(--text-secondary)", marginLeft: 8 }}>
                {(a.size / 1024).toFixed(1)} KB
              </span>
            </div>
          ))}
        </div>
      )}

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
