/** 迭代决策面板 — 展示达尔文 Stage Gate 量化指标 + 多轮迭代收敛决策。
 *
 * 数据来源：
 * - latestStageGateEvaluation: stage_gate_evaluation WS 事件（量化指标 + 建议）
 * - latestIterationDecision: iteration_decision WS 事件（收敛决策 + 下一轮查询）
 * - iteration_round / iteration_converged: 轮次与收敛信号
 *
 * 对齐 TASK-034：前端展示 Stage Gate 量化指标 + 迭代收敛决策。
 */
import { Card, Row, Col, Statistic, Progress, Tag, Typography, Empty, Alert, Collapse, Timeline, Tooltip } from 'antd';
import {
  CheckCircleOutlined, WarningOutlined, ReloadOutlined,
  AimOutlined, BulbOutlined, ClusterOutlined,
} from '@ant-design/icons';
import { useTaskStore } from '@/stores/taskStore';
import type { StageGateMetrics, StageGateSuggestion, WSMessage } from '@/api/types';

const { Title, Text, Paragraph } = Typography;

/** 格式化百分比（0-1 → xx%）*/
function pct(v: number | undefined): string {
  if (v === undefined || v === null) return '-';
  return `${Math.round(v * 100)}%`;
}

/** 单个指标单元格：依据后端 stage_gate_evaluation.passed 字段达标/未达标着色 */
function MetricCell({
  label, value, format, passed, hint,
}: {
  label: string;
  value: number | undefined;
  format: (v: number) => string;
  passed: boolean | undefined;
  hint: string;
}) {
  const color = passed === undefined ? '#595959' : passed ? '#52c41a' : '#ff4d4f';
  return (
    <Tooltip title={hint}>
      <div style={{ textAlign: 'center' }}>
        <Statistic
          title={label}
          value={value !== undefined ? format(value) : '-'}
          valueStyle={{
            color,
            fontSize: 18,
          }}
        />
      </div>
    </Tooltip>
  );
}

/** 实体覆盖率明细：展示已覆盖 + 缺失实体 */
function EntityCoverageDetail({ metrics }: { metrics: StageGateMetrics }) {
  const ec = metrics.entity_coverage;
  if (!ec) return null;
  const types = [
    { key: 'gene', label: '基因', color: '#1890ff' },
    { key: 'compound', label: '化合物', color: '#52c41a' },
    { key: 'disease', label: '疾病', color: '#722ed1' },
    { key: 'pathway', label: '通路', color: '#fa8c16' },
  ];
  const entries = types.filter(t => ec[t.key]);
  if (entries.length === 0) return null;
  return (
    <div>
      {entries.map(({ key, label, color }) => {
        const item = ec[key];
        const covered = item.covered || [];
        const missing = item.missing || [];
        return (
          <div key={key} style={{ marginBottom: 8 }}>
            <Text strong style={{ fontSize: 12, color }}>{label}：</Text>
            <Text style={{ fontSize: 12, color: '#52c41a' }}>
              {covered.length > 0 ? `✓ ${covered.join(', ')}` : '无覆盖'}
            </Text>
            {missing.length > 0 && (
              <Text style={{ fontSize: 12, color: '#ff4d4f', marginLeft: 8 }}>
                ✗ 缺: {missing.join(', ')}
              </Text>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Stage Gate 建议列表 */
function SuggestionList({ suggestions }: { suggestions: StageGateSuggestion[] }) {
  if (suggestions.length === 0) return null;
  const actionColor: Record<string, string> = {
    expand_search: '#1890ff',
    add_source: '#52c41a',
    deepen_analysis: '#722ed1',
    refine_keywords: '#fa8c16',
    request_user_input: '#ff4d4f',
  };
  return (
    <Timeline
      items={suggestions.map((s, i) => ({
        color: actionColor[s.action] || 'gray',
        children: (
          <div>
            <Tag color={actionColor[s.action] || 'default'} style={{ fontSize: 11 }}>
              {s.action}
            </Tag>
            <Text style={{ fontSize: 12 }}>{s.reason || ''}</Text>
            {s.query && (
              <Text code style={{ fontSize: 11, marginLeft: 4 }}>{s.query}</Text>
            )}
            {s.source && (
              <Tag style={{ fontSize: 10, marginLeft: 4 }}>{s.source}</Tag>
            )}
            {s.analysis && (
              <Tag style={{ fontSize: 10, marginLeft: 4 }}>{s.analysis}</Tag>
            )}
          </div>
        ),
        key: i,
      }))}
    />
  );
}

export function IterationPanel() {
  const { latestStageGateEvaluation, latestIterationDecision, wsMessages } = useTaskStore();

  // 从 wsMessages 提取最新轮次信息（iteration_round / iteration_converged）
  const latestRound = [...wsMessages].reverse().find(
    m => m.type === 'iteration_round' || m.type === 'iteration_converged'
  );
  const roundIdx = latestRound?.round;
  const maxRounds = latestRound?.max_rounds;
  const converged = latestRound?.type === 'iteration_converged';
  const convergedReason = latestRound?.reason;

  const evalMsg: WSMessage | null = latestStageGateEvaluation;
  const decisionMsg: WSMessage | null = latestIterationDecision;

  // 无任何迭代数据时显示占位
  if (!evalMsg && !decisionMsg && !latestRound) {
    return null;  // 静默不显示，避免占空间
  }

  const metrics: StageGateMetrics | undefined = evalMsg?.metrics;
  const passed: boolean | undefined = evalMsg?.passed;
  const suggestions: StageGateSuggestion[] = evalMsg?.suggestions || [];
  const shouldContinue: boolean | undefined = decisionMsg?.should_continue;
  const reason: string | undefined = decisionMsg?.reason;
  const nextQueries: string[] = decisionMsg?.next_round_queries || [];
  const targetEntities: string[] = decisionMsg?.target_entities || [];
  const convergenceSignals: string[] = decisionMsg?.convergence_signals || [];
  const needsUserInput: boolean = !!decisionMsg?.needs_user_input;

  return (
    <Card
      size="small"
      style={{ marginBottom: 16 }}
      title={
        <Title level={5} style={{ margin: 0 }}>
          <ClusterOutlined /> 迭代决策面板
          {roundIdx !== undefined && (
            <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>
              第 {roundIdx}{maxRounds ? `/${maxRounds}` : ''} 轮
            </Tag>
          )}
          {converged && (
            <Tag color="green" style={{ marginLeft: 4, fontSize: 11 }}>已收敛</Tag>
          )}
        </Title>
      }
    >
      {/* Stage Gate 通过/未通过状态条 */}
      {passed !== undefined && (
        <Alert
          type={passed ? 'success' : 'warning'}
          showIcon
          icon={passed ? <CheckCircleOutlined /> : <WarningOutlined />}
          style={{ marginBottom: 12 }}
          message={passed ? 'Stage Gate 通过 — 数据质量达标' : 'Stage Gate 未通过 — 指标未达标'}
          description={metrics ? `覆盖率 ${pct(metrics.coverage)} · 置信度 ${metrics.avg_confidence?.toFixed(2) || '-'} · 冲突率 ${pct(metrics.conflict_rate)} · 数据源 ${metrics.source_diversity ?? '-'}` : ''}
        />
      )}

      {/* 量化指标四宫格 */}
      {metrics && (
        <Row gutter={8} style={{ marginBottom: 12 }}>
          <Col span={6}>
            <MetricCell
              label="覆盖率"
              value={metrics.coverage}
              format={pct}
              passed={passed}
              hint="规划实体已获数据的比例"
            />
          </Col>
          <Col span={6}>
            <MetricCell
              label="平均置信度"
              value={metrics.avg_confidence}
              format={v => v.toFixed(2)}
              passed={passed}
              hint="所有记录的平均抽取置信度"
            />
          </Col>
          <Col span={6}>
            <MetricCell
              label="冲突率"
              value={metrics.conflict_rate}
              format={pct}
              passed={passed}
              hint="quality_flags 含 conflict/needs_review 的记录占比"
            />
          </Col>
          <Col span={6}>
            <MetricCell
              label="数据源数"
              value={metrics.source_diversity}
              format={v => String(v)}
              passed={passed}
              hint="不同 source_name 的数量"
            />
          </Col>
        </Row>
      )}

      {/* 覆盖率进度条 */}
      {metrics?.coverage !== undefined && (
        <Progress
          percent={Math.round(metrics.coverage * 100)}
          status={passed === undefined ? 'active' : passed ? 'success' : 'exception'}
          format={() => `实体覆盖率 ${pct(metrics.coverage)}`}
          size="small"
          style={{ marginBottom: 12 }}
        />
      )}

      {/* 实体覆盖率明细 + 建议折叠面板 */}
      {(metrics?.entity_coverage || suggestions.length > 0) && (
        <Collapse
          size="small"
          style={{ marginBottom: 12 }}
          items={[
            ...(metrics?.entity_coverage ? [{
              key: 'coverage',
              label: <span><AimOutlined /> 实体覆盖率明细</span>,
              children: <EntityCoverageDetail metrics={metrics} />,
            }] : []),
            ...(suggestions.length > 0 ? [{
              key: 'suggestions',
              label: <span><BulbOutlined /> Stage Gate 建议（{suggestions.length}）</span>,
              children: <SuggestionList suggestions={suggestions} />,
            }] : []),
          ]}
        />
      )}

      {/* 迭代决策 */}
      {decisionMsg && (
        <Card
          size="small"
          type="inner"
          style={{ marginBottom: 12 }}
          title={
            <span>
              <ReloadOutlined /> 迭代决策：
              <Tag
                color={shouldContinue ? 'processing' : 'success'}
                style={{ marginLeft: 8, fontSize: 11 }}
              >
                {shouldContinue ? '继续迭代' : '已收敛/终止'}
              </Tag>
              {needsUserInput && (
                <Tag color="red" style={{ fontSize: 11 }}>需用户介入</Tag>
              )}
            </span>
          }
        >
          {reason && (
            <Paragraph style={{ fontSize: 12, marginBottom: 8 }}>
              <Text strong>原因：</Text>
              <Text type="secondary">{reason}</Text>
            </Paragraph>
          )}
          {convergedReason && !reason && (
            <Paragraph style={{ fontSize: 12, marginBottom: 8 }}>
              <Text strong>收敛信号：</Text>
              <Text type="secondary">{convergedReason}</Text>
            </Paragraph>
          )}
          {targetEntities.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 12 }}>目标实体：</Text>
              {targetEntities.map(e => (
                <Tag key={e} color="orange" style={{ fontSize: 11 }}>{e}</Tag>
              ))}
            </div>
          )}
          {nextQueries.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong style={{ fontSize: 12 }}>下一轮查询：</Text>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {nextQueries.map((q, i) => (
                  <li key={i} style={{ fontSize: 12, color: '#595959' }}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {convergenceSignals.length > 0 && (
            <div>
              <Text strong style={{ fontSize: 12 }}>收敛信号：</Text>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {convergenceSignals.map((s, i) => (
                  <li key={i} style={{ fontSize: 12, color: '#595959' }}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      {/* 无决策数据但有评估数据时的提示 */}
      {!decisionMsg && evalMsg && (
        <Empty
          description="等待迭代决策…"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        />
      )}
    </Card>
  );
}
