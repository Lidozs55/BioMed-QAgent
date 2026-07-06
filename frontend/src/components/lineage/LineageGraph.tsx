/** 数据溯源图组件 — 使用 ReactFlow 展示数据血缘 DAG */
import { useEffect, useState, useMemo } from 'react';
import { Card, Typography, Empty, Spin, Tag } from 'antd';
import {
  ReactFlow, Background, Controls, MiniMap,
  type Node, type Edge, Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '@/api/client';
import type { LineageGraph as LGraph } from '@/api/types';

const { Title, Text } = Typography;

const OPERATION_COLOR: Record<string, string> = {
  search: '#1890ff',
  acquire: '#13c2c2',
  parse: '#52c41a',
  clean: '#faad14',
  analyze: '#722ed1',
  review: '#eb2f96',
  export: '#fa541c',
};

const OPERATION_LABEL: Record<string, string> = {
  search: '检索',
  acquire: '采集',
  parse: '解析',
  clean: '清洗',
  analyze: '分析',
  review: '审查',
  export: '导出',
};

export function LineageGraph({ taskId }: { taskId: string }) {
  const [graph, setGraph] = useState<LGraph | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getLineage(taskId)
      .then(setGraph)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [taskId]);

  const { nodes, edges } = useMemo(() => {
    if (!graph || !graph.nodes.length) return { nodes: [], edges: [] };

    // 按操作类型分组布局
    const ops = ['search', 'acquire', 'parse', 'clean', 'analyze', 'review', 'export'];
    const byOp: Record<string, typeof graph.nodes> = {};
    graph.nodes.forEach(n => {
      const op = n.operation_type || 'other';
      if (!byOp[op]) byOp[op] = [];
      byOp[op].push(n);
    });

    const xGap = 220;
    const yGap = 80;
    const flowNodes: Node[] = [];
    graph.nodes.forEach((n, i) => {
      const op = n.operation_type || 'other';
      const opIdx = ops.indexOf(op);
      const sameOp = byOp[op] || [];
      const idxInOp = sameOp.indexOf(n);
      flowNodes.push({
        id: n.node_id,
        position: { x: opIdx * xGap, y: idxInOp * yGap },
        data: {
          label: (
            <div style={{ fontSize: 11, padding: '2px 4px' }}>
              <div style={{ fontWeight: 600 }}>
                <Tag color={OPERATION_COLOR[op] || '#999'} style={{ fontSize: 10, margin: 0 }}>
                  {OPERATION_LABEL[op] || op}
                </Tag>
                {n.tool_name || n.agent_name}
              </div>
              {n.output_record_ids.length > 0 && (
                <Text type="secondary" style={{ fontSize: 10 }}>
                  → {n.output_record_ids.length} 条记录
                </Text>
              )}
            </div>
          ),
        },
        style: {
          border: `2px solid ${OPERATION_COLOR[op] || '#d9d9d9'}`,
          borderRadius: 6,
          background: '#fff',
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      });
    });

    const flowEdges: Edge[] = graph.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      animated: true,
      style: { stroke: '#bbb' },
    }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [graph]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin tip="加载溯源图…" size="large">
          <div style={{ padding: 20, minHeight: 100 }} />
        </Spin>
      </div>
    );
  }

  if (!graph || graph.nodes.length === 0) {
    return <Empty description="暂无溯源数据" />;
  }

  return (
    <Card size="small" title={<Title level={5} style={{ margin: 0 }}>数据血缘图</Title>}>
      <div style={{ height: 500, border: '1px solid #f0f0f0', borderRadius: 6, overflow: 'hidden' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          attributionPosition="bottom-right"
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
      <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {Object.entries(OPERATION_LABEL).map(([op, label]) => (
          <Tag key={op} color={OPERATION_COLOR[op]}>{label}</Tag>
        ))}
      </div>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        共 {graph.stats.total_nodes} 个操作节点，追踪 {graph.stats.total_records_tracked} 条数据记录
      </Text>
    </Card>
  );
}
