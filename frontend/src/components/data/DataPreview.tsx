/** 数据预览组件 — 展示任务产生的数据记录 */
import { useEffect, useState } from 'react';
import { Table, Card, Tag, Typography, Select, Space, Button, Statistic, Row, Col, Tooltip, Empty } from 'antd';
import { DownloadOutlined, DatabaseOutlined, FilePdfOutlined, LinkOutlined } from '@ant-design/icons';
import { api } from '@/api/client';
import type { DataRecord, DataResponse } from '@/api/types';

const { Title, Text, Paragraph } = Typography;

export function DataPreview({ taskId }: { taskId: string }) {
  const [data, setData] = useState<DataResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState<string | undefined>();

  const fetchData = async () => {
    setLoading(true);
    try {
      const offset = (page - 1) * 20;
      const res = await api.getTaskData(taskId, 20, offset, sourceFilter);
      setData(res);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [taskId, page, sourceFilter]);

  const columns = [
    {
      title: '#',
      key: 'idx',
      width: 50,
      render: (_: any, __: DataRecord, idx: number) => (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {(page - 1) * 20 + idx + 1}
        </Text>
      ),
    },
    {
      title: '标题/名称',
      dataIndex: 'fields',
      key: 'title',
      width: 320,
      render: (fields: Record<string, any>) => {
        const title = fields.title || fields.compound_name || fields.gene_symbol
                    || fields.name || fields.caption || fields.arxiv_id
                    || (fields.entity_type === 'Table' ? `[表格] 第${fields.page}页` : '')
                    || JSON.stringify(fields).slice(0, 60);
        const entityType = fields.entity_type || '';
        const abstract = fields.abstract || fields.summary || fields.description || '';
        return (
          <div>
            <Text strong style={{ fontSize: 12 }}>
              {entityType === 'Table' && <FilePdfOutlined style={{ color: '#ff4d4f', marginRight: 4 }} />}
              {entityType === 'Caption' && <FilePdfOutlined style={{ color: '#faad14', marginRight: 4 }} />}
              {title}
            </Text>
            {abstract && (
              <Tooltip title={abstract}>
                <Paragraph
                  type="secondary"
                  ellipsis={{ rows: 2 }}
                  style={{ fontSize: 11, margin: '4px 0 0' }}
                >
                  {abstract}
                </Paragraph>
              </Tooltip>
            )}
          </div>
        );
      },
    },
    {
      title: '来源',
      dataIndex: ['source_ref', 'source_name'],
      key: 'source',
      width: 90,
      render: (src: string) => {
        const color = src === 'arxiv' ? '#ff4d4f'
                    : src === 'pubmed' ? '#1890ff'
                    : src === 'pdf' ? '#fa541c'
                    : src === 'openalex' ? '#52c41a'
                    : '#d9d9d9';
        return <Tag color={color}>{src || 'unknown'}</Tag>;
      },
    },
    {
      title: '类型',
      key: 'entity_type',
      width: 70,
      render: (_: any, r: DataRecord) => {
        const et = r.fields?.entity_type;
        if (et === 'Table') return <Tag color="orange">表格</Tag>;
        if (et === 'Caption') return <Tag color="gold">Caption</Tag>;
        if (r.fields?.arxiv_id) return <Tag color="red">论文</Tag>;
        if (r.fields?.pmid) return <Tag color="blue">文献</Tag>;
        return <Tag>数据</Tag>;
      },
    },
    {
      title: '置信度',
      dataIndex: 'extraction_confidence',
      key: 'confidence',
      width: 75,
      render: (conf: number) => (
        <span style={{
          color: conf >= 0.9 ? '#52c41a' : conf >= 0.7 ? '#faad14' : '#ff4d4f',
          fontWeight: 600,
        }}>
          {(conf * 100).toFixed(0)}%
        </span>
      ),
      sorter: (a: DataRecord, b: DataRecord) =>
        a.extraction_confidence - b.extraction_confidence,
    },
    {
      title: 'ID/链接',
      key: 'id',
      width: 100,
      render: (_: any, r: DataRecord) => {
        const ref = r.source_ref || {};
        const fields = r.fields || {};
        const idStr = ref.doi || ref.pmid || fields.arxiv_id || '';
        const url = fields.pdf_url || fields.abs_url || ref.source_url || ref.url || '';
        return (
          <div>
            {idStr && <div><Text style={{ fontSize: 10 }} type="secondary">{idStr}</Text></div>}
            {url && (
              <a href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
                <LinkOutlined /> 链接
              </a>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <Row gutter={12} style={{ marginBottom: 12 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="总记录数" value={data?.total || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="数据源数" value={Object.keys(data?.sources || {}).length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="PDF 文档" value={data?.sources?.pdf || 0} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="arXiv 论文" value={data?.sources?.arxiv || 0} />
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={
          <Space>
            <DatabaseOutlined />
            <Title level={5} style={{ margin: 0 }}>数据记录详情</Title>
          </Space>
        }
        extra={
          <Space>
            <Select
              placeholder="按数据源过滤"
              allowClear
              value={sourceFilter}
              onChange={v => { setSourceFilter(v); setPage(1); }}
              style={{ width: 160 }}
              options={Object.entries(data?.sources || {}).map(([k, v]) => ({ label: `${k} (${v})`, value: k }))}
            />
            <a href={api.exportCsv(taskId)} target="_blank">
              <Button icon={<DownloadOutlined />} size="small">CSV</Button>
            </a>
            <a href={api.exportJson(taskId)} target="_blank">
              <Button icon={<DownloadOutlined />} size="small">JSON</Button>
            </a>
          </Space>
        }
      >
        {data && data.total > 0 ? (
          <Table
            dataSource={data?.records || []}
            columns={columns}
            rowKey="record_id"
            loading={loading}
            size="small"
            pagination={{
              current: page,
              pageSize: 20,
              total: data?.total || 0,
              onChange: setPage,
              showSizeChanger: false,
              showTotal: t => `共 ${t} 条`,
            }}
            expandable={{
              expandedRowRender: (r: DataRecord) => (
                <pre style={{ fontSize: 11, maxHeight: 240, overflow: 'auto', background: '#f6f8fa', padding: 8, borderRadius: 4 }}>
                  {JSON.stringify(r.fields, null, 2)}
                </pre>
              ),
            }}
          />
        ) : (
          <Empty description={loading ? '加载中…' : '暂无数据记录'} />
        )}
      </Card>
    </div>
  );
}
