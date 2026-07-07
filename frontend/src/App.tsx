/** BioMed QAgent 主应用 */
import { useEffect } from 'react';
import { Layout, Row, Col, Tabs, Typography, Tag, Badge } from 'antd';
import {
  ExperimentOutlined, DatabaseOutlined, ApartmentOutlined,
  BarChartOutlined, FileTextOutlined, ApiOutlined,
} from '@ant-design/icons';
import { useTaskStore } from '@/stores/taskStore';
import { useTaskWebSocket } from '@/hooks/useTaskWebSocket';
import { TaskInput } from '@/components/task/TaskInput';
import { TaskListPanel } from '@/components/task/TaskList';
import { PipelineStatus } from '@/components/task/PipelineStatus';
import { DataOverview } from '@/components/data/DataOverview';
import { ResearchReport } from '@/components/report/ResearchReport';

const { Header, Sider, Content } = Layout;
const { Title, Text } = Typography;

export default function App() {
  const { tasks, selectedTaskId, selectedTask, fetchTasks, wsConnected } = useTaskStore();
  useTaskWebSocket(selectedTaskId);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#16213e', display: 'flex', alignItems: 'center', gap: 16 }}>
        <ExperimentOutlined style={{ fontSize: 24, color: '#fff' }} />
        <Title level={4} style={{ color: '#fff', margin: 0 }}>
          BioMed QAgent
        </Title>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
          生物医学研究智能体 · DashScope 驱动
        </Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          {selectedTask && (
            <Tag color="blue">{selectedTask.domain || '未分类'}</Tag>
          )}
          <Badge status={wsConnected ? 'success' : 'default'}
                 text={<span style={{ color: 'rgba(255,255,255,0.8)' }}>
                   {wsConnected ? 'WS 已连接' : 'WS 未连接'}
                 </span>} />
          <ApiOutlined style={{ color: 'rgba(255,255,255,0.5)' }} />
        </div>
      </Header>

      <Layout>
        <Sider width={380} style={{ background: '#fff', padding: 16, overflow: 'auto', height: 'calc(100vh - 64px)' }}>
          <TaskInput />
          <div style={{ marginTop: 16 }}>
            <TaskListPanel />
          </div>
        </Sider>

        <Content style={{ padding: 16, overflow: 'auto' }}>
          {selectedTask ? (
            <Tabs
              defaultActiveKey="pipeline"
              items={[
                {
                  key: 'pipeline',
                  label: <span><BarChartOutlined /> 流水线状态</span>,
                  children: <PipelineStatus task={selectedTask} />,
                },
                {
                  key: 'data',
                  label: <span><DatabaseOutlined /> 数据总览</span>,
                  children: <DataOverview taskId={selectedTask.task_id} />,
                },
                {
                  key: 'report',
                  label: <span><FileTextOutlined /> 研究报告</span>,
                  children: <ResearchReport taskId={selectedTask.task_id} />,
                },
              ]}
            />
          ) : (
            <div style={{ textAlign: 'center', padding: '80px 20px', color: '#999' }}>
              <ExperimentOutlined style={{ fontSize: 64, marginBottom: 16, color: '#d9d9d9' }} />
              <Title level={3} type="secondary">输入研究目标开始</Title>
              <Text type="secondary">
                例如：分析健脾散结方对胰腺癌肝转移的影响
              </Text>
              <Row gutter={16} style={{ marginTop: 32, maxWidth: 800, margin: '32px auto 0' }}>
                <Col span={8}>
                  <div style={{ background: '#fff', padding: 16, borderRadius: 8 }}>
                    <DatabaseOutlined style={{ fontSize: 28, color: '#1890ff' }} />
                    <Title level={5} style={{ marginTop: 8 }}>多源数据检索</Title>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      PubMed / OpenAlex / Semantic Scholar / arXiv / GEO / STRING / KEGG
                    </Text>
                  </div>
                </Col>
                <Col span={8}>
                  <div style={{ background: '#fff', padding: 16, borderRadius: 8 }}>
                    <BarChartOutlined style={{ fontSize: 28, color: '#52c41a' }} />
                    <Title level={5} style={{ marginTop: 8 }}>智能分析</Title>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      PPI 网络 · GO/KEGG 富集 · 药物-靶点 · Darwinian Stage Gate
                    </Text>
                  </div>
                </Col>
                <Col span={8}>
                  <div style={{ background: '#fff', padding: 16, borderRadius: 8 }}>
                    <ApartmentOutlined style={{ fontSize: 28, color: '#722ed1' }} />
                    <Title level={5} style={{ marginTop: 8 }}>来源追溯</Title>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      完整数据血缘 DAG · 可视化 HTML 报告
                    </Text>
                  </div>
                </Col>
              </Row>
            </div>
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
