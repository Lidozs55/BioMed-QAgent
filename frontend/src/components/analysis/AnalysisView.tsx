/** 分析结果组件 — 展示 PPI 网络、富集分析、药物-靶点结果 */
import { useEffect, useState } from 'react';
import { Card, Typography, Empty, Row, Col, Table, Tag, Collapse, Statistic, Button, Spin, Tabs } from 'antd';
import { ExperimentOutlined, NodeIndexOutlined, ShareAltOutlined, MedicineBoxOutlined, ReloadOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { api } from '@/api/client';

const { Title, Text, Paragraph } = Typography;

interface AnalysisResponse {
  task_id: string;
  analysis_types: string[];
  analysis: Record<string, any>;
  has_results: boolean;
}

export function AnalysisView({ taskId }: { taskId: string }) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.getAnalysis(taskId)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [taskId]);

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
        <Button icon={<ReloadOutlined />} onClick={load}>重新加载</Button>
      </Empty>
    );
  }

  const { analysis } = data;

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="分析项数" value={data.analysis_types.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="PPI 节点" value={analysis.ppi_network?.stats_table?.length || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="富集通路" value={analysis.enrichment?.stats_table?.length || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="药物-靶点" value={analysis.drug_targets?.stats_table?.length || 0} />
          </Card>
        </Col>
      </Row>

      <Tabs
        items={[
          {
            key: 'ppi',
            label: <span><NodeIndexOutlined /> PPI 网络</span>,
            children: analysis.ppi_network
              ? <PPIPanel data={analysis.ppi_network} />
              : <Empty description="无 PPI 分析结果" />,
          },
          {
            key: 'enrichment',
            label: <span><ShareAltOutlined /> 富集分析</span>,
            children: analysis.enrichment
              ? <EnrichmentPanel data={analysis.enrichment} />
              : <Empty description="无富集分析结果" />,
          },
          {
            key: 'drug',
            label: <span><MedicineBoxOutlined /> 药物-靶点</span>,
            children: analysis.drug_targets
              ? <DrugTargetPanel data={analysis.drug_targets} />
              : <Empty description="无药物-靶点结果" />,
          },
        ]}
      />

      <Card size="small" style={{ marginTop: 12 }}>
        <Button icon={<ReloadOutlined />} onClick={load} size="small">重新加载分析结果</Button>
      </Card>
    </div>
  );
}

// ===== PPI 网络面板 =====
function PPIPanel({ data }: { data: any }) {
  const statsTable = data.stats_table || [];
  const chartData = data.chart_data || { nodes: [], edges: [] };
  const params = data.parameters || {};

  // 构建 ECharts 关系图
  const graphOption = {
    title: { text: 'PPI 蛋白互作网络', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'item', formatter: (p: any) => {
      if (p.dataType === 'node') {
        const d = p.data || {};
        return `<b>${d.name || d.id}</b><br/>degree: ${d.degree || 0}<br/>hub: ${d.is_hub ? '是' : '否'}`;
      }
      return `${p.data.source} → ${p.data.target}<br/>score: ${p.data.score}`;
    }},
    series: [{
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
    }],
  };

  const columns = [
    { title: '基因', dataIndex: 'gene', key: 'gene',
      render: (g: string, r: any) => <Text strong>{g}</Text> },
    { title: '度数', dataIndex: 'degree', key: 'degree', sorter: (a: any, b: any) => b.degree - a.degree },
    { title: '介数中心性', dataIndex: 'betweenness', key: 'betw',
      render: (v: number) => v.toFixed(4) },
    { title: '接近中心性', dataIndex: 'closeness', key: 'close',
      render: (v: number) => v.toFixed(4) },
    { title: 'Hub', dataIndex: 'is_hub', key: 'hub',
      render: (h: boolean) => h ? <Tag color="red">Hub</Tag> : <Tag>—</Tag> },
  ];

  return (
    <div>
      <Paragraph>
        <Text strong>摘要：</Text> {data.summary || '—'}
        <br/>
        <Text type="secondary" style={{ fontSize: 11 }}>
          物种: {params.species || 9606} | 置信度阈值: {params.score_threshold || 0.4} | 基因数: {params.gene_count || 0}
        </Text>
      </Paragraph>
      {chartData.nodes?.length > 0 && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <ReactECharts option={graphOption} style={{ height: 400 }} />
        </Card>
      )}
      {statsTable.length > 0 && (
        <Card size="small" title={<Title level={5} style={{ margin: 0 }}>节点中心性指标</Title>}>
          <Table
            dataSource={statsTable}
            columns={columns}
            rowKey="gene"
            size="small"
            pagination={{ pageSize: 10, showSizeChanger: false }}
          />
        </Card>
      )}
    </div>
  );
}

// ===== 富集分析面板 =====
function EnrichmentPanel({ data }: { data: any }) {
  const statsTable = data.stats_table || [];
  const params = data.parameters || {};

  // 取 top 20 通路做柱状图
  const topTerms = statsTable.slice(0, 20);
  const barOption = {
    title: { text: 'Top 20 富集通路 (-log10 p)', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    grid: { left: '20%', right: '10%' },
    xAxis: { type: 'value', name: '-log10(p)' },
    yAxis: { type: 'category', data: topTerms.map((t: any) => t.term || t.name || '').slice().reverse(),
             axisLabel: { fontSize: 10 } },
    series: [{
      type: 'bar',
      data: topTerms.map((t: any) => {
        const p = parseFloat(t.p_value || t.pvalue || 1);
        return p > 0 ? -Math.log10(p) : 0;
      }).reverse(),
      itemStyle: { color: '#722ed1' },
    }],
  };

  const columns = [
    { title: '通路/术语', dataIndex: 'term', key: 'term', width: 280,
      render: (t: string) => <Text strong style={{ fontSize: 12 }}>{t}</Text> },
    { title: '类别', dataIndex: 'category', key: 'cat', width: 100,
      render: (c: string) => c ? <Tag color="purple">{c}</Tag> : '—' },
    { title: 'p 值', dataIndex: 'p_value', key: 'p',
      render: (p: any) => {
        const v = parseFloat(p || 1);
        return <span style={{ color: v < 0.001 ? '#ff4d4f' : v < 0.05 ? '#faad14' : '#999' }}>
          {v < 0.001 ? v.toExponential(2) : v.toFixed(4)}
        </span>;
      },
      sorter: (a: any, b: any) => parseFloat(a.p_value) - parseFloat(b.p_value) },
    { title: '基因数', dataIndex: 'gene_count', key: 'gc', width: 80 },
    { title: '比例', dataIndex: 'ratio', key: 'ratio', width: 100,
      render: (r: any) => r ? `${(r * 100).toFixed(1)}%` : '—' },
  ];

  return (
    <div>
      <Paragraph>
        <Text strong>摘要：</Text> {data.summary || '—'}
        <br/>
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
        <Card size="small" title={<Title level={5} style={{ margin: 0 }}>富集通路详情 ({statsTable.length} 条)</Title>}>
          <Table
            dataSource={statsTable}
            columns={columns}
            rowKey={(r: any) => r.term || r.name}
            size="small"
            pagination={{ pageSize: 15, showSizeChanger: false, showTotal: t => `共 ${t} 条` }}
          />
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
    { title: '化合物', dataIndex: 'compound', key: 'compound',
      render: (c: string) => <Tag color="green">{c}</Tag> },
    { title: '靶点', dataIndex: 'target', key: 'target',
      render: (t: string) => <Text strong>{t}</Text> },
    { title: '作用', dataIndex: 'action', key: 'action',
      render: (a: string) => a ? <Tag color={a === 'inhibitor' ? 'red' : a === 'activator' ? 'green' : 'blue'}>{a}</Tag> : '—' },
    { title: '来源', dataIndex: 'source', key: 'source', width: 100 },
  ];

  return (
    <div>
      <Paragraph>
        <Text strong>摘要：</Text> {data.summary || '—'}
        <br/>
        <Text type="secondary" style={{ fontSize: 11 }}>
          化合物数: {params.compound_count || 0}
        </Text>
      </Paragraph>
      {statsTable.length > 0 ? (
        <Card size="small" title={<Title level={5} style={{ margin: 0 }}>药物-靶点关系 ({statsTable.length} 条)</Title>}>
          <Table
            dataSource={statsTable}
            columns={columns}
            rowKey={(r: any, i: number) => `${r.compound}_${r.target}_${i}`}
            size="small"
            pagination={{ pageSize: 15, showSizeChanger: false }}
          />
        </Card>
      ) : (
        <Empty description="无药物-靶点数据（可能化合物名称为中文，OpenTargets 用英文标识）" />
      )}
    </div>
  );
}
