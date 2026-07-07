/** 研究报告组件 — 整合 LLM 综合研究报告 + 分析结果
 *
 * - LLM 综合报告：由 qwen-max 生成的科学叙事报告（iframe 展示）
 * - 分析结果：PPI 网络 / 富集分析 / 药物-靶点 等结构化分析
 *
 * 后端只生成 LLM 报告（无模板回退），失败则任务失败。
 * 保留分析结果原始结构化展示，便于用户核查 LLM 解读的准确性。
 */
import { useEffect, useState } from 'react';
import { Tabs, Card, Typography, Button, Spin, Empty, Space, Table, message } from 'antd';
import {
  FileTextOutlined, ExperimentOutlined, ReloadOutlined,
  DownloadOutlined, NodeIndexOutlined, ShareAltOutlined, MedicineBoxOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { api } from '@/api/client';

const { Title, Text, Paragraph } = Typography;

interface Props {
  taskId: string;
}

interface AnalysisResponse {
  task_id: string;
  analysis_types: string[];
  analysis: Record<string, any>;
  has_results: boolean;
}

export function ResearchReport({ taskId }: Props) {
  const [activeKey, setActiveKey] = useState('llm_report');
  const [reportLoading, setReportLoading] = useState(true);
  const [hasReport, setHasReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportVersion, setReportVersion] = useState(0); // 强制刷新 iframe
  const [regenerating, setRegenerating] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(true);

  const loadReport = () => {
    setReportLoading(true);
    setReportError(null);
    fetch(`${api.getReportUrl(taskId)}?_t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error('报告尚未生成');
        setHasReport(true);
      })
      .catch((e) => {
        setHasReport(false);
        setReportError(String(e));
      })
      .finally(() => setReportLoading(false));
  };

  const regenerateReport = () => {
    setRegenerating(true);
    api
      .regenerateReport(taskId)
      .then(() => {
        message.success('报告已重新生成');
        setReportVersion((v) => v + 1); // 强制刷新 iframe
      })
      .catch((e) => {
        message.error(`重新生成失败: ${e.message || e}`);
      })
      .finally(() => setRegenerating(false));
  };

  const loadAnalysis = () => {
    setAnalysisLoading(true);
    api
      .getAnalysis(taskId)
      .then(setAnalysis)
      .catch(console.error)
      .finally(() => setAnalysisLoading(false));
  };

  useEffect(() => {
    loadReport();
    loadAnalysis();
  }, [taskId]);

  return (
    <Tabs
      activeKey={activeKey}
      onChange={setActiveKey}
      items={[
        {
          key: 'llm_report',
          label: (
            <span>
              <FileTextOutlined /> LLM 综合报告
            </span>
          ),
          children: (
            <LLMReportPanel
              taskId={taskId}
              loading={reportLoading}
              hasReport={hasReport}
              error={reportError}
              reportVersion={reportVersion}
              regenerating={regenerating}
              onReload={loadReport}
              onRegenerate={regenerateReport}
            />
          ),
        },
        {
          key: 'analysis',
          label: (
            <span>
              <ExperimentOutlined /> 分析结果
              {analysis?.has_results && (
                <span style={{ marginLeft: 4, color: '#52c41a' }}>
                  · {analysis.analysis_types.length}
                </span>
              )}
            </span>
          ),
          children: (
            <AnalysisPanel
              loading={analysisLoading}
              data={analysis}
              onReload={loadAnalysis}
            />
          ),
        },
      ]}
    />
  );
}

// ===== LLM 综合报告面板 =====
function LLMReportPanel({
  taskId,
  loading,
  hasReport,
  error,
  reportVersion,
  regenerating,
  onReload,
  onRegenerate,
}: {
  taskId: string;
  loading: boolean;
  hasReport: boolean;
  error: string | null;
  reportVersion: number;
  regenerating: boolean;
  onReload: () => void;
  onRegenerate: () => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin tip="加载 LLM 综合报告…" size="large">
          <div style={{ padding: 20, minHeight: 100 }} />
        </Spin>
      </div>
    );
  }

  if (!hasReport) {
    return (
      <Empty description={error || '报告尚未生成，请等待任务完成'}>
        <Button icon={<ReloadOutlined />} onClick={onReload}>
          重新加载
        </Button>
      </Empty>
    );
  }

  return (
    <Card
      size="small"
      title={
        <Space>
          <FileTextOutlined />
          <Title level={5} style={{ margin: 0 }}>
            LLM 综合研究报告
          </Title>
        </Space>
      }
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            loading={regenerating}
            onClick={onRegenerate}
          >
            重新生成
          </Button>
          <a href={api.getReportUrl(taskId)} target="_blank" rel="noopener">
            <Button icon={<DownloadOutlined />} size="small">
              新窗口打开
            </Button>
          </a>
          <Button icon={<ReloadOutlined />} size="small" onClick={onReload}>
            刷新
          </Button>
        </Space>
      }
    >
      <iframe
        key={reportVersion}
        src={`${api.getReportUrl(taskId)}?_v=${reportVersion}`}
        className="report-frame"
        title="LLM 综合研究报告"
      />
    </Card>
  );
}

// ===== 分析结果面板 =====
function AnalysisPanel({
  loading,
  data,
  onReload,
}: {
  loading: boolean;
  data: AnalysisResponse | null;
  onReload: () => void;
}) {
  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin tip="加载分析结果…" size="large">
          <div style={{ padding: 20, minHeight: 100 }} />
        </Spin>
      </div>
    );
  }

  if (!data || !data.has_results) {
    return (
      <Empty description="暂无分析结果（任务可能未启用分析或仍在运行）">
        <Button icon={<ReloadOutlined />} onClick={onReload}>
          重新加载
        </Button>
      </Empty>
    );
  }

  const { analysis } = data;

  return (
    <div>
      <Tabs
        items={[
          {
            key: 'ppi',
            label: (
              <span>
                <NodeIndexOutlined /> PPI 网络
              </span>
            ),
            children: analysis.ppi_network ? (
              <PPIPanel data={analysis.ppi_network} />
            ) : (
              <Empty description="无 PPI 分析结果" />
            ),
          },
          {
            key: 'enrichment',
            label: (
              <span>
                <ShareAltOutlined /> 富集分析
              </span>
            ),
            children: analysis.enrichment ? (
              <EnrichmentPanel data={analysis.enrichment} />
            ) : (
              <Empty description="无富集分析结果" />
            ),
          },
          {
            key: 'drug',
            label: (
              <span>
                <MedicineBoxOutlined /> 药物-靶点
              </span>
            ),
            children: analysis.drug_targets ? (
              <DrugTargetPanel data={analysis.drug_targets} />
            ) : (
              <Empty description="无药物-靶点结果" />
            ),
          },
        ]}
      />
      <Card size="small" style={{ marginTop: 12 }}>
        <Button icon={<ReloadOutlined />} onClick={onReload} size="small">
          重新加载分析结果
        </Button>
      </Card>
    </div>
  );
}

// ===== PPI 网络面板 =====
function PPIPanel({ data }: { data: any }) {
  const statsTable = data.stats_table || [];
  const chartData = data.chart_data || { nodes: [], edges: [] };
  const params = data.parameters || {};

  const graphOption = {
    title: {
      text: 'PPI 蛋白互作网络',
      left: 'center',
      textStyle: { fontSize: 14 },
    },
    tooltip: {
      trigger: 'item',
      formatter: (p: any) => {
        if (p.dataType === 'node') {
          const d = p.data || {};
          return `<b>${d.name || d.id}</b><br/>degree: ${d.degree || 0}<br/>hub: ${d.is_hub ? '是' : '否'}`;
        }
        return `${p.data.source} → ${p.data.target}<br/>score: ${p.data.score}`;
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        force: { repulsion: 200, edgeLength: 80, gravity: 0.1 },
        label: { show: true, position: 'right', fontSize: 11 },
        edgeSymbol: ['none', 'arrow'],
        data: (chartData.nodes || []).map((n: any) => ({
          id: n.id,
          name: n.id,
          symbolSize: 20 + (n.degree || 0) * 8,
          itemStyle: { color: n.is_hub ? '#ff4d4f' : '#1890ff' },
          label: { show: true, formatter: n.id },
        })),
        links: (chartData.edges || []).map((e: any) => ({
          source: e.source,
          target: e.target,
          score: e.score,
          lineStyle: { width: 1 + (e.score || 0) * 3, opacity: 0.6 },
        })),
      },
    ],
  };

  const columns = [
    {
      title: '基因',
      dataIndex: 'gene',
      key: 'gene',
      render: (g: string) => <Text strong>{g}</Text>,
    },
    {
      title: '度数',
      dataIndex: 'degree',
      key: 'degree',
      sorter: (a: any, b: any) => b.degree - a.degree,
    },
    {
      title: '介数中心性',
      dataIndex: 'betweenness',
      key: 'betw',
      render: (v: number) => v.toFixed(4),
    },
    {
      title: '接近中心性',
      dataIndex: 'closeness',
      key: 'close',
      render: (v: number) => v.toFixed(4),
    },
    {
      title: 'Hub',
      dataIndex: 'is_hub',
      key: 'hub',
      render: (h: boolean) =>
        h ? (
          <span style={{ color: '#ff4d4f', fontWeight: 600 }}>Hub</span>
        ) : (
          '—'
        ),
    },
  ];

  return (
    <div>
      <Paragraph>
        <Text strong>摘要：</Text> {data.summary || '—'}
        <br />
        <Text type="secondary" style={{ fontSize: 11 }}>
          物种: {params.species || 9606} | 置信度阈值: {params.score_threshold || 0.4} | 基因数:{' '}
          {params.gene_count || 0}
        </Text>
      </Paragraph>
      {chartData.nodes?.length > 0 && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <ReactECharts option={graphOption} style={{ height: 400 }} />
        </Card>
      )}
      {statsTable.length > 0 && (
        <Card
          size="small"
          title={
            <Title level={5} style={{ margin: 0 }}>
              节点中心性指标
            </Title>
          }
        >
          <TableSimple columns={columns} data={statsTable} rowKey="gene" />
        </Card>
      )}
    </div>
  );
}

// ===== 富集分析面板 =====
function EnrichmentPanel({ data }: { data: any }) {
  const statsTable = data.stats_table || [];
  const params = data.parameters || {};
  const topTerms = statsTable.slice(0, 20);

  const barOption = {
    title: {
      text: 'Top 20 富集通路 (-log10 p)',
      left: 'center',
      textStyle: { fontSize: 14 },
    },
    tooltip: { trigger: 'axis' },
    grid: { left: '20%', right: '10%' },
    xAxis: { type: 'value', name: '-log10(p)' },
    yAxis: {
      type: 'category',
      data: topTerms.map((t: any) => t.term || t.name || '').slice().reverse(),
      axisLabel: { fontSize: 10 },
    },
    series: [
      {
        type: 'bar',
        data: topTerms
          .map((t: any) => {
            const p = parseFloat(t.p_value || t.pvalue || 1);
            return p > 0 ? -Math.log10(p) : 0;
          })
          .reverse(),
        itemStyle: { color: '#722ed1' },
      },
    ],
  };

  const columns = [
    {
      title: '通路/术语',
      dataIndex: 'term',
      key: 'term',
      width: 280,
      render: (t: string) => (
        <Text strong style={{ fontSize: 12 }}>
          {t}
        </Text>
      ),
    },
    {
      title: 'p 值',
      dataIndex: 'p_value',
      key: 'p',
      render: (p: any) => {
        const v = parseFloat(p || 1);
        return (
          <span
            style={{
              color: v < 0.001 ? '#ff4d4f' : v < 0.05 ? '#faad14' : '#999',
            }}
          >
            {v < 0.001 ? v.toExponential(2) : v.toFixed(4)}
          </span>
        );
      },
      sorter: (a: any, b: any) => parseFloat(a.p_value) - parseFloat(b.p_value),
    },
    { title: '基因数', dataIndex: 'gene_count', key: 'gc', width: 80 },
  ];

  return (
    <div>
      <Paragraph>
        <Text strong>摘要：</Text> {data.summary || '—'}
        <br />
        <Text type="secondary" style={{ fontSize: 11 }}>
          输入基因数: {params.gene_count || 0} | 数据库: {params.database || 'Enrichr'}
        </Text>
      </Paragraph>
      {topTerms.length > 0 && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <ReactECharts option={barOption} style={{ height: 400 }} />
        </Card>
      )}
      {statsTable.length > 0 && (
        <Card
          size="small"
          title={
            <Title level={5} style={{ margin: 0 }}>
              富集通路详情 ({statsTable.length} 条)
            </Title>
          }
        >
          <TableSimple columns={columns} data={statsTable} rowKey={(r: any) => r.term || r.name} />
        </Card>
      )}
    </div>
  );
}

// ===== 药物-靶点面板 =====
function DrugTargetPanel({ data }: { data: any }) {
  const statsTable = data.stats_table || [];
  const params = data.parameters || {};

  const columns = [
    {
      title: '化合物',
      dataIndex: 'compound',
      key: 'compound',
      render: (c: string) => (
        <span style={{ color: '#52c41a', fontWeight: 600 }}>{c}</span>
      ),
    },
    {
      title: '靶点',
      dataIndex: 'target',
      key: 'target',
      render: (t: string) => <Text strong>{t}</Text>,
    },
    {
      title: '作用',
      dataIndex: 'action',
      key: 'action',
      render: (a: string) =>
        a ? (
          <span
            style={{
              color: a === 'inhibitor' ? '#ff4d4f' : a === 'activator' ? '#52c41a' : '#1890ff',
              fontWeight: 600,
            }}
          >
            {a}
          </span>
        ) : (
          '—'
        ),
    },
    { title: '来源', dataIndex: 'source', key: 'source', width: 100 },
  ];

  return (
    <div>
      <Paragraph>
        <Text strong>摘要：</Text> {data.summary || '—'}
        <br />
        <Text type="secondary" style={{ fontSize: 11 }}>
          化合物数: {params.compound_count || 0}
        </Text>
      </Paragraph>
      {statsTable.length > 0 ? (
        <Card
          size="small"
          title={
            <Title level={5} style={{ margin: 0 }}>
              药物-靶点关系 ({statsTable.length} 条)
            </Title>
          }
        >
          <TableSimple
            columns={columns}
            data={statsTable}
            rowKey={(r: any, i: number) => `${r.compound}_${r.target}_${i}`}
          />
        </Card>
      ) : (
        <Empty description="无药物-靶点数据（可能化合物名称为中文，OpenTargets 用英文标识）" />
      )}
    </div>
  );
}

// ===== 轻量表格封装 =====
function TableSimple({
  columns,
  data,
  rowKey,
}: {
  columns: any[];
  data: any[];
  rowKey: string | ((r: any, i: number) => string);
}) {
  return (
    <Table
      dataSource={data}
      columns={columns}
      rowKey={rowKey as any}
      size="small"
      pagination={{ pageSize: 15, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
    />
  );
}
