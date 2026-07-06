/** 任务列表面板 */
import { List, Tag, Typography, Empty, Popconfirm, Button, Tooltip } from 'antd';
import { DeleteOutlined, ClockCircleOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useTaskStore } from '@/stores/taskStore';
import type { TaskSummary, TaskStatus } from '@/api/types';

const STATUS_COLOR: Record<TaskStatus, string> = {
  created: 'default',
  planning: 'processing',
  searching: 'processing',
  acquiring: 'processing',
  parsing: 'processing',
  cleaning: 'processing',
  analyzing: 'processing',
  reviewing: 'processing',
  completed: 'success',
  failed: 'error',
};

const STATUS_LABEL: Record<string, string> = {
  created: '已创建',
  planning: '规划中',
  searching: '检索中',
  acquiring: '采集中',
  parsing: '解析中',
  cleaning: '清洗中',
  analyzing: '分析中',
  reviewing: '审查中',
  completed: '已完成',
  failed: '失败',
};

export function TaskListPanel() {
  const { tasks, selectedTaskId, selectTask, deleteTask } = useTaskStore();

  if (tasks.length === 0) {
    return <Empty description="暂无任务" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }

  return (
    <List
      size="small"
      dataSource={tasks}
      renderItem={(task: TaskSummary) => (
        <List.Item
          style={{
            cursor: 'pointer',
            background: selectedTaskId === task.task_id ? '#e6f7ff' : undefined,
            padding: '8px 12px',
            borderLeft: selectedTaskId === task.task_id ? '3px solid #1890ff' : '3px solid transparent',
          }}
          onClick={() => selectTask(task.task_id)}
          actions={[
            <Popconfirm
              key="delete"
              title="确认删除此任务？"
              onConfirm={(e) => { e?.stopPropagation(); deleteTask(task.task_id); }}
            >
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={e => e.stopPropagation()}
              />
            </Popconfirm>,
          ]}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 12,
              color: '#333',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {task.research_goal}
            </div>
            <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <Tag color={STATUS_COLOR[task.status]} style={{ margin: 0, fontSize: 11 }}>
                {STATUS_LABEL[task.status] || task.status}
              </Tag>
              {task.total_records > 0 && (
                <Tag style={{ margin: 0, fontSize: 11 }}>{task.total_records} 条</Tag>
              )}
              <Tooltip title={dayjs(task.created_at).format('YYYY-MM-DD HH:mm:ss')}>
                <span style={{ fontSize: 10, color: '#999' }}>
                  <ClockCircleOutlined /> {dayjs(task.created_at).format('MM-DD HH:mm')}
                </span>
              </Tooltip>
            </div>
          </div>
        </List.Item>
      )}
    />
  );
}
