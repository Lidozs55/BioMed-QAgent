/** 研究报告组件 — 展示 HTML 报告 */
import { useEffect, useState } from 'react';
import { Card, Typography, Button, Spin, Empty, Space } from 'antd';
import { DownloadOutlined, FileTextOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '@/api/client';

const { Title, Text } = Typography;

export function ReportView({ taskId }: { taskId: string }) {
  const [loading, setLoading] = useState(true);
  const [hasReport, setHasReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useState<HTMLIFrameElement | null>(null);

  const loadReport = () => {
    setLoading(true);
    setError(null);
    fetch(api.getReportUrl(taskId))
      .then(r => {
        if (!r.ok) throw new Error('报告尚未生成');
        setHasReport(true);
      })
      .catch(e => {
        setHasReport(false);
        setError(String(e));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadReport(); }, [taskId]);

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <Spin tip="加载报告…" size="large">
          <div style={{ padding: 20, minHeight: 100 }} />
        </Spin>
      </div>
    );
  }

  if (!hasReport) {
    return (
      <Empty description={error || '报告尚未生成，请等待任务完成'}>
        <Button icon={<ReloadOutlined />} onClick={loadReport}>重新加载</Button>
      </Empty>
    );
  }

  return (
    <Card
      size="small"
      title={
        <Space>
          <FileTextOutlined />
          <Title level={5} style={{ margin: 0 }}>研究报告（HTML）</Title>
        </Space>
      }
      extra={
        <Space>
          <a href={api.getReportUrl(taskId)} target="_blank" rel="noopener">
            <Button icon={<DownloadOutlined />} size="small">新窗口打开</Button>
          </a>
          <Button icon={<ReloadOutlined />} size="small" onClick={loadReport}>刷新</Button>
        </Space>
      }
    >
      <iframe
        src={api.getReportUrl(taskId)}
        className="report-frame"
        title="研究报告"
      />
    </Card>
  );
}
