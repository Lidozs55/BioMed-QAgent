/** 分析结果视图 — 展示 PPI/富集/药靶/生存分析等分析结果
 *
 * 当前重点：生存分析 KM 曲线可视化（proBLEM.md 加分项闭环）
 * 后续可扩展：PPI 网络图、富集条形图、药靶热图等
 */
import { useEffect, useState } from 'react';
import { Card, Typography, Empty, Row, Col, Tag, Descriptions, Statistic, Spin } from 'antd';
import ReactECharts from 'echarts-for-react';
import { api } from '@/api/client';

const { Title, Text, Paragraph } = Typography;

interface Props {
  taskId: string;
}

interface SurvivalResult {
  gene: string;
  cohort: string;
  groups: {
    high_expression: { n: number; events: number; median_survival_months: number };
    low_expression: { n: number; events: number; median_survival_months: number };
  };
  log_rank_p: number;
  hr: number;
  hr_ci_95: [number, number];
  significance: string;
  chart_data: { km_curves: Array<{ time: number; survival_high: number; survival_low: number }> };
  summary: string;
}

export function AnalysisView({ taskId }: Props) {
  const [loading, setLoading] = useState(true);
  const [analysis, setAnalysis] = useState<Record<string, any>>({});
  const [hasResults, setHasResults] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.getAnalysis(taskId)
      .then((resp) => {
        setAnalysis(resp.analysis || {});
        setHasResults(resp.has_results);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [taskId]);

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 40 }}><Spin tip="加载分析结果..." /></div>;
  }

  if (!hasResults || Object.keys(analysis).length === 0) {
    return <Empty description="暂无分析结果（任务完成后将显示 PPI/富集/药靶/生存分析等结果）" />;
  }

  return (
    <div>
      {Object.entries(analysis).map(([key, result]) => {
        if (!result || typeof result !== 'object') return null;
        // 生存分析特殊渲染（KM 曲线）
        if (key === 'survival' || result.analysis_type === 'survival_analysis') {
          return <SurvivalCard key={key} result={result as SurvivalResult} />;
        }
        // 其他分析类型：通用摘要卡片
        return <GenericAnalysisCard key={key} typeKey={key} result={result} />;
      })}
    </div>
  );
}

/** 生存分析 KM 曲线卡片 */
function SurvivalCard({ result }: { result: SurvivalResult }) {
  const curves = result.chart_data?.km_curves || [];
  const isInsufficient = result.significance === 'insufficient_data';

  // KM 曲线 ECharts 配置
  const kmOption = {
    title: { text: `Kaplan-Meier 生存曲线 — ${result.gene}（${result.cohort}）`,
             left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis', formatter: (params: any[]) => {
      const t = params[0]?.axisValue ?? '';
      const lines = [`时间: ${t} 月`];
      params.forEach(p => {
        lines.push(`${p.marker} ${p.seriesName}: ${(p.value * 100).toFixed(1)}%`);
      });
      return lines.join('<br/>');
    }},
    legend: { data: ['高表达组', '低表达组'], bottom: 0 },
    grid: { left: 60, right: 30, top: 60, bottom: 50 },
    xAxis: { type: 'category', name: '时间（月）', data: curves.map(c => c.time) },
    yAxis: { type: 'value', name: '生存概率',
             min: 0, max: 1,
             axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
    series: [
      {
        name: '高表达组', type: 'line', step: 'after',
        data: curves.map(c => c.survival_high),
        itemStyle: { color: '#ff4d4f' }, lineStyle: { width: 2 },
      },
      {
        name: '低表达组', type: 'line', step: 'after',
        data: curves.map(c => c.survival_low),
        itemStyle: { color: '#1890ff' }, lineStyle: { width: 2 },
      },
    ],
  };

  const sigColor = result.significance === 'significant' ? 'red' :
                   result.significance === 'not_significant' ? 'default' : 'orange';
  const sigText = result.significance === 'significant' ? '显著' :
                  result.significance === 'not_significant' ? '不显著' : '数据不足';

  return (
    <Card size="small" title={<Title level={5} style={{ margin: 0 }}>生存分析</Title>}
          style={{ marginBottom: 16 }}>
      <Row gutter={16}>
        <Col span={16}>
          {isInsufficient || curves.length === 0 ? (
            <Empty description="生存分析数据不足（TCGA API 不可用或表达数据缺失）"
                   style={{ padding: 40 }} />
          ) : (
            <ReactECharts option={kmOption} style={{ height: 360 }} />
          )}
        </Col>
        <Col span={8}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="基因">{result.gene}</Descriptions.Item>
            <Descriptions.Item label="TCGA 队列">{result.cohort}</Descriptions.Item>
            <Descriptions.Item label="显著性">
              <Tag color={sigColor}>{sigText}</Tag>
            </Descriptions.Item>
          </Descriptions>
          <Row gutter={8} style={{ marginTop: 12 }}>
            <Col span={12}>
              <Statistic title="log-rank p 值" value={result.log_rank_p}
                         precision={4} valueStyle={{ fontSize: 16 }} />
            </Col>
            <Col span={12}>
              <Statistic title="HR (95% CI)"
                         value={`${result.hr.toFixed(2)} (${result.hr_ci_95[0].toFixed(2)}-${result.hr_ci_95[1].toFixed(2)})`}
                         valueStyle={{ fontSize: 14 }} />
            </Col>
          </Row>
          <Card size="small" type="inner" style={{ marginTop: 12 }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="高表达 n">{result.groups?.high_expression?.n ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="低表达 n">{result.groups?.low_expression?.n ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="高表达事件">
                {result.groups?.high_expression?.events ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="低表达事件">
                {result.groups?.low_expression?.events ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="高中位生存(月)">
                {result.groups?.high_expression?.median_survival_months?.toFixed(1) ?? '-'}
              </Descriptions.Item>
              <Descriptions.Item label="低中位生存(月)">
                {result.groups?.low_expression?.median_survival_months?.toFixed(1) ?? '-'}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Col>
      </Row>
      {result.summary && (
        <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          {result.summary}
        </Paragraph>
      )}
    </Card>
  );
}

/** 通用分析结果卡片（PPI/富集/药靶等，显示摘要） */
function GenericAnalysisCard({ typeKey, result }: { typeKey: string; result: any }) {
  const typeNames: Record<string, string> = {
    ppi_network: 'PPI 蛋白互作网络',
    enrichment: 'GO/KEGG 富集分析',
    drug_target: '药物-靶点分析',
    differential_expression: '差异表达分析',
    hub_gene: 'Hub 基因分析',
    upstream_regulator: '上游调控分析',
  };
  const title = typeNames[typeKey] || typeKey;
  const summary = result.summary || '';
  const statsTable = result.stats_table || [];

  return (
    <Card size="small" title={<Title level={5} style={{ margin: 0 }}>{title}</Title>}
          style={{ marginBottom: 16 }}>
      {summary && <Paragraph>{summary}</Paragraph>}
      {statsTable.length > 0 && (
        <Card size="small" type="inner" title={`统计表（前 ${Math.min(statsTable.length, 10)} 条）`}>
          <pre style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', margin: 0 }}>
            {JSON.stringify(statsTable.slice(0, 10), null, 2)}
          </pre>
        </Card>
      )}
      {!summary && statsTable.length === 0 && (
        <Text type="secondary">（无详细摘要，原始数据见 JSON 导出）</Text>
      )}
    </Card>
  );
}
