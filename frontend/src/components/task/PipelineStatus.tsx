/** 流水线状态组件 — 展示各阶段进度和实时消息 */
import { Badge, Card, Steps, Space, Tag, Typography, Timeline, Statistic, Row, Col, Progress, Empty, Alert, Collapse, Button, Tooltip } from 'antd';
import {
  CheckCircleOutlined, LoadingOutlined, ClockCircleOutlined,
  CloseCircleOutlined, BulbOutlined, WarningOutlined, ExpandOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useTaskStore } from '@/stores/taskStore';
import { IterationPanel } from '@/components/task/IterationPanel';
import type { TaskSummary, StageInfo, StageStatus } from '@/api/types';

const { Title, Text, Paragraph } = Typography;

const STAGE_LABELS: Record<string, string> = {
  planning: '意图理解',
  search: '数据检索',
  acquire: '数据采集',
  parse: '数据解析',
  clean: '数据清洗',
  analyze: '数据分析',
  review: '质量审查',
  export: '报告导出',
};

const STAGE_DESC: Record<string, string> = {
  planning: 'DashScope LLM 分析研究目标，提取关键实体',
  search: '并行检索 PubMed/OpenAlex/Semantic Scholar/arXiv 等数据源',
  acquire: '爬虫采集无 API 数据源',
  parse: '解析 PDF 文献、GEO/SOFT、PDB 等生物数据',
  clean: '字段对齐、单位归一化、去重',
  analyze: 'PPI 网络、GO/KEGG 富集、药物-靶点分析',
  review: 'DashScope qwen-max 审查数据质量与完整性',
  export: '生成 CSV 数据和 HTML 研究报告',
};

function stageIcon(status: StageStatus) {
  switch (status) {
    case 'done': return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    case 'running': return <LoadingOutlined style={{ color: '#1890ff' }} />;
    case 'failed': return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    case 'skipped': return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />;
    default: return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />;
  }
}

function stageStatus(status: StageStatus): 'wait' | 'process' | 'finish' | 'error' {
  switch (status) {
    case 'done': return 'finish';
    case 'running': return 'process';
    case 'failed': return 'error';
    case 'skipped': return 'wait';
    default: return 'wait';
  }
}

export function PipelineStatus({ task }: { task: TaskSummary }) {
  const { wsMessages, stageProgress, currentStage, roundIdx, maxRounds, iterationDecisions, convergenceReason } = useTaskStore();

  const stages = Object.values(task.stages);
  const entities = task.entities || {};
  const totalEntities = Object.values(entities).reduce((s, arr) => s + (arr?.length || 0), 0);

  return (
    <div>
      {/* 概览统计 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="总记录数" value={task.total_records} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="数据源数" value={task.source_count} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="平均置信度" value={task.avg_confidence}
                       precision={3} suffix="" />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="识别实体数" value={totalEntities} />
          </Card>
        </Col>
      </Row>

      {/* ====== Multi-Round Iteration Indicator ====== */}
      {roundIdx > 0 && (
        <Card size="small" style={{ marginBottom: 16, background: '#f6f8fa' }}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {/* Round counter */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Space>
                <Badge count={roundIdx} style={{ backgroundColor: '#1677ff' }} />
                <Text strong>
                  {task.status === 'completed' && convergenceReason
                    ? `迭代完成 · ${roundIdx}/${maxRounds} 轮`
                    : `第 ${roundIdx}/${maxRounds} 轮`}
                </Text>
                {task.status !== 'completed' && roundIdx > 0 && (
                  <Tag icon={<SyncOutlined spin />} color="processing">迭代中</Tag>
                )}
              </Space>
              {convergenceReason && (
                <Tag icon={<CheckCircleOutlined />} color="success">{convergenceReason}</Tag>
              )}
            </div>
            {/* Per-round decisions timeline */}
            {iterationDecisions.length > 0 && (
              <Timeline
                items={iterationDecisions.map((d, i) => ({
                  color: d.should_continue ? 'blue' : 'green',
                  dot: d.should_continue ? <SyncOutlined /> : <CheckCircleOutlined />,
                  children: (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      第 {d.round} 轮 · {d.should_continue ? '继续迭代' : '收敛'} · {d.reason}
                    </Text>
                  ),
                }))}
              />
            )}
          </Space>
        </Card>
      )}

      {/* 当前阶段进度条 */}
      {currentStage && task.status !== 'completed' && task.status !== 'failed' && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Progress
            percent={Math.round(stageProgress * 100)}
            status="active"
            format={() => `${STAGE_LABELS[currentStage] || currentStage} - ${Math.round(stageProgress * 100)}%`}
          />
        </Card>
      )}

      {/* 致命错误（导致任务失败） */}
      {task.status === 'failed' && task.errors.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="任务执行失败 — 致命错误"
          description={
            <div>
              <Text strong style={{ color: '#ff4d4f', display: 'block', marginBottom: 4 }}>
                {task.errors[task.errors.length - 1]}
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                请检查后端日志获取完整 traceback。常见原因：数据清洗异常、LLM 报告生成失败、数据源 API 不可用。
              </Text>
            </div>
          }
        />
      )}

      {/* 非致命错误（可展开查看全部） */}
      {task.errors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          style={{ marginBottom: 16 }}
          message={
            <span>
              {task.status === 'failed'
                ? `${task.errors.length - 1} 个非致命警告`
                : `${task.errors.length} 个非致命错误`}
              <Tooltip title="点击展开查看全部错误详情">
                <Button
                  type="link"
                  size="small"
                  icon={<ExpandOutlined />}
                  style={{ padding: '0 4px', height: 'auto', fontSize: 12 }}
                  onClick={(e) => {
                    e.preventDefault();
                    const panel = document.getElementById('error-detail-panel');
                    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
                  }}
                >
                  详情
                </Button>
              </Tooltip>
            </span>
          }
          description={
            <div>
              <div style={{ marginBottom: 4 }}>
                {task.errors.slice(0, 3).map((err, i) => (
                  <div key={i} style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 2 }}>
                    • {err.length > 120 ? err.slice(0, 120) + '…' : err}
                  </div>
                ))}
              </div>
              <div id="error-detail-panel" style={{ display: 'none', marginTop: 8,
                   maxHeight: 300, overflowY: 'auto', padding: 8,
                   background: '#fafafa', borderRadius: 4 }}>
                {task.errors.map((err, i) => (
                  <div key={i} style={{ fontSize: 11, fontFamily: 'monospace',
                       marginBottom: 4, padding: '2px 0',
                       borderBottom: i < task.errors.length - 1 ? '1px dashed #e8e8e8' : 'none' }}>
                    <Tag style={{ fontSize: 10 }}>#{i + 1}</Tag>
                    {err}
                  </div>
                ))}
              </div>
            </div>
          }
        />
      )}

      {/* 阶段步骤 */}
      <Card size="small" title={<Title level={5} style={{ margin: 0 }}>流水线阶段</Title>} style={{ marginBottom: 16 }}>
        <Steps
          size="small"
          direction="vertical"
          current={stages.findIndex(s => s.status === 'running')}
          items={stages.map(s => ({
            title: (
              <span>
                {STAGE_LABELS[s.name] || s.name}
                {s.records_count > 0 && (
                  <Tag style={{ marginLeft: 8, fontSize: 11 }}>{s.records_count} 条</Tag>
                )}
              </span>
            ),
            description: (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>{STAGE_DESC[s.name]}</Text>
                {s.message && (
                  <div style={{ marginTop: 4 }}>
                    <Text style={{
                      fontSize: 12,
                      color: s.status === 'failed' ? '#ff4d4f' : undefined,
                      fontWeight: s.status === 'failed' ? 600 : 400,
                    }}>
                      {s.message}
                    </Text>
                  </div>
                )}
              </div>
            ),
            status: stageStatus(s.status),
            icon: stageIcon(s.status),
          }))}
        />
      </Card>

      {/* 识别实体 */}
      {totalEntities > 0 && (
        <Card size="small" title={<Title level={5} style={{ margin: 0 }}>
          <BulbOutlined /> 识别实体（DashScope LLM）
        </Title>} style={{ marginBottom: 16 }}>
          {entities.compounds?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 12 }}>化合物/成分：</Text>
              <div>
                {entities.compounds.map(c => <span key={c} className="entity-tag compound">{c}</span>)}
              </div>
            </div>
          )}
          {entities.genes?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 12 }}>靶点基因：</Text>
              <div>
                {entities.genes.map(g => <span key={g} className="entity-tag gene">{g}</span>)}
              </div>
            </div>
          )}
          {entities.diseases?.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 12 }}>疾病：</Text>
              <div>
                {entities.diseases.map(d => <span key={d} className="entity-tag disease">{d}</span>)}
              </div>
            </div>
          )}
          {entities.pathways?.length > 0 && (
            <div>
              <Text strong style={{ fontSize: 12 }}>通路：</Text>
              <div>
                {entities.pathways.map(p => <span key={p} className="entity-tag pathway">{p}</span>)}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* 迭代决策面板（达尔文 Stage Gate 量化指标 + 收敛决策）*/}
      <IterationPanel />

      {/* 实时日志 */}
      <Card size="small" title={<Title level={5} style={{ margin: 0 }}>实时日志</Title>}>
        {wsMessages.length === 0 ? (
          <Empty description="等待消息…" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Timeline
            items={wsMessages.slice(-50).reverse().map((msg, i) => ({
              color: msg.type === 'error' ? 'red'
                   : msg.type === 'task_complete' ? 'green'
                   : msg.type === 'stage_complete' ? 'blue'
                   : msg.type === 'stage_start' ? 'blue'
                   : 'gray',
              children: (
                <div>
                  <Tag style={{
                    fontSize: 10,
                    color: msg.type === 'error' ? '#ff4d4f' : undefined,
                    borderColor: msg.type === 'error' ? '#ff4d4f' : undefined,
                  }}>{msg.type}</Tag>
                  {msg.stage && <Tag color="blue" style={{ fontSize: 10 }}>{STAGE_LABELS[msg.stage] || msg.stage}</Tag>}
                  {msg.pct !== undefined && msg.pct > 0 && (
                    <Tag style={{ fontSize: 10 }}>{Math.round(msg.pct * 100)}%</Tag>
                  )}
                  {msg.message && (
                    <Text style={{
                      fontSize: 12,
                      color: msg.type === 'error' ? '#ff4d4f' : undefined,
                      wordBreak: 'break-all',
                      display: 'block',
                      marginTop: 2,
                    }}>
                      {msg.message}
                    </Text>
                  )}
                </div>
              ),
              key: i,
            }))}
          />
        )}
      </Card>
    </div>
  );
}
