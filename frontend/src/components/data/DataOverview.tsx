/** 数据总览组件 — 整合数据记录、统计图表、数据溯源、整合CSV 下载
 *
 * 取代原来分散的 DataPreview / ChartsView / LineageGraph 三个 Tab，
 * 通过内部子 Tab 切换，避免职能重合，提供统一的数据视角。
 */
import { useState } from 'react';
import { Tabs, Button, Tooltip } from 'antd';
import {
  DatabaseOutlined, BarChartOutlined, ApartmentOutlined,
  DownloadOutlined, TableOutlined, FileTextOutlined, ExperimentOutlined,
} from '@ant-design/icons';
import { api } from '@/api/client';
import { DataPreview } from './DataPreview';
import { ChartsView } from '../charts/ChartsView';
import { LineageGraph } from '../lineage/LineageGraph';
import { AnalysisView } from '../analysis/AnalysisView';

interface Props {
  taskId: string;
}

export function DataOverview({ taskId }: Props) {
  const [activeKey, setActiveKey] = useState('records');

  return (
    <div>
      <div
        style={{
          marginBottom: 12,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
        }}
      >
        <Tooltip title="按实体类型分组的整合 CSV（文献/化合物/基因/互作/通路），字段对齐，便于研究分析">
          <a href={api.exportMergedCsv(taskId)} target="_blank" rel="noopener">
            <Button icon={<TableOutlined />} size="small" type="primary" ghost>
              下载整合CSV
            </Button>
          </a>
        </Tooltip>
        <Tooltip title="原始平铺 CSV（含所有字段，适合溯源审计）">
          <a href={api.exportCsv(taskId)} target="_blank" rel="noopener">
            <Button icon={<DownloadOutlined />} size="small">
              原始CSV
            </Button>
          </a>
        </Tooltip>
        <Tooltip title="完整 JSON 数据（含溯源信息）">
          <a href={api.exportJson(taskId)} target="_blank" rel="noopener">
            <Button icon={<FileTextOutlined />} size="small">
              JSON
            </Button>
          </a>
        </Tooltip>
      </div>

      <Tabs
        activeKey={activeKey}
        onChange={setActiveKey}
        items={[
          {
            key: 'records',
            label: (
              <span>
                <DatabaseOutlined /> 数据记录
              </span>
            ),
            children: <DataPreview taskId={taskId} />,
          },
          {
            key: 'charts',
            label: (
              <span>
                <BarChartOutlined /> 统计图表
              </span>
            ),
            children: <ChartsView taskId={taskId} />,
          },
          {
            key: 'lineage',
            label: (
              <span>
                <ApartmentOutlined /> 数据溯源
              </span>
            ),
            children: <LineageGraph taskId={taskId} />,
          },
          {
            key: 'analysis',
            label: (
              <span>
                <ExperimentOutlined /> 分析结果
              </span>
            ),
            children: <AnalysisView taskId={taskId} />,
          },
        ]}
      />
    </div>
  );
}
