/** 图表分析组件 — 使用 ECharts 可视化数据 */
import { useEffect, useState, useRef } from 'react';
import { Card, Typography, Empty, Row, Col, Select, Tag } from 'antd';
import ReactECharts from 'echarts-for-react';
import { api } from '@/api/client';
import type { DataRecord, DataResponse } from '@/api/types';

const { Title, Text } = Typography;

export function ChartsView({ taskId }: { taskId: string }) {
  const [data, setData] = useState<DataResponse | null>(null);
  const [chartType, setChartType] = useState('sources');

  useEffect(() => {
    api.getTaskData(taskId, 500, 0).then(setData).catch(console.error);
  }, [taskId]);

  if (!data || data.records.length === 0) {
    return <Empty description="暂无数据可供可视化" />;
  }

  // 数据源分布饼图
  const sourcePieOption = {
    title: { text: '数据源分布', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      data: Object.entries(data.sources).map(([name, value]) => ({ name, value })),
      label: { fontSize: 12 },
    }],
    color: ['#1890ff', '#52c41a', '#faad14', '#722ed1', '#13c2c2', '#eb2f96', '#fa541c'],
  };

  // 置信度分布柱状图
  const confBuckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
  data.records.forEach(r => {
    const c = r.extraction_confidence;
    const idx = Math.min(Math.floor(c * 5), 4);
    confBuckets[idx]++;
  });
  const confidenceOption = {
    title: { text: '置信度分布', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ['0-20%', '20-40%', '40-60%', '60-80%', '80-100%'] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: confBuckets, itemStyle: { color: '#1890ff' } }],
  };

  // 按数据源的记录数柱状图
  const sourceBarOption = {
    title: { text: '各数据源记录数', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: Object.keys(data.sources), axisLabel: { rotate: 30 } },
    yAxis: { type: 'value' },
    series: [{
      type: 'bar',
      data: Object.values(data.sources),
      itemStyle: { color: '#52c41a' },
    }],
  };

  return (
    <div>
      <Row gutter={16}>
        <Col span={12}>
          <Card size="small">
            <ReactECharts option={sourcePieOption} style={{ height: 320 }} />
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small">
            <ReactECharts option={confidenceOption} style={{ height: 320 }} />
          </Card>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card size="small">
            <ReactECharts option={sourceBarOption} style={{ height: 300 }} />
          </Card>
        </Col>
      </Row>
      <Card size="small" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Text strong>数据概览：</Text>
          <Tag color="blue">{data.total} 条记录</Tag>
          <Tag color="green">{Object.keys(data.sources).length} 个数据源</Tag>
          {data.records[0]?.fields?.title && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              示例：{String(data.records[0].fields.title).slice(0, 50)}
            </Text>
          )}
        </div>
      </Card>
    </div>
  );
}
