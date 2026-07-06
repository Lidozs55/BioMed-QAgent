/** 任务输入组件 — 输入研究目标并启动任务 */
import { useState } from 'react';
import { Input, Button, Select, Card, Typography, Space, App } from 'antd';
import { RocketOutlined, LoadingOutlined } from '@ant-design/icons';
import { useTaskStore } from '@/stores/taskStore';

const { TextArea } = Input;
const { Title, Text } = Typography;

const EXAMPLES = [
  '分析健脾散结方对胰腺癌肝转移的影响',
  '研究黄芪甲苷对肺癌细胞凋亡的分子机制',
  '探索人参皂苷Rb1在心血管疾病中的作用靶点',
  '分析苦参碱对肝癌的抑制作用及通路',
];

const DOMAINS = [
  { label: '自动识别', value: '' },
  { label: '中医药 (TCM)', value: 'tcm' },
  { label: '肿瘤学', value: 'oncology' },
  { label: '药理学', value: 'pharmacology' },
  { label: '分子生物学', value: 'molecular_biology' },
];

export function TaskInput() {
  const [goal, setGoal] = useState('');
  const [domain, setDomain] = useState('');
  const { createAndStartTask, loading } = useTaskStore();
  const { message } = App.useApp();

  const handleSubmit = async () => {
    if (!goal.trim()) {
      message.warning('请输入研究目标');
      return;
    }
    const tid = await createAndStartTask(goal.trim(), domain || undefined);
    if (tid) {
      message.success(`任务已创建并启动: ${tid}`);
      setGoal('');
    } else {
      message.error('任务创建失败');
    }
  };

  return (
    <Card size="small" title={<Title level={5} style={{ margin: 0 }}>研究目标</Title>}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <TextArea
          value={goal}
          onChange={e => setGoal(e.target.value)}
          placeholder="输入你的生物医学研究问题…&#10;例如：分析健脾散结方对胰腺癌肝转移的影响"
          autoSize={{ minRows: 3, maxRows: 6 }}
          onPressEnter={e => {
            if (e.ctrlKey) handleSubmit();
          }}
        />
        <Select
          value={domain}
          onChange={setDomain}
          options={DOMAINS}
          style={{ width: '100%' }}
          size="small"
        />
        <Button
          type="primary"
          icon={loading ? <LoadingOutlined /> : <RocketOutlined />}
          onClick={handleSubmit}
          loading={loading}
          block
        >
          启动研究
        </Button>
        <div style={{ marginTop: 4 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>示例：</Text>
          {EXAMPLES.slice(0, 2).map(ex => (
            <div key={ex}>
              <a style={{ fontSize: 11 }} onClick={() => setGoal(ex)}>{ex}</a>
            </div>
          ))}
        </div>
      </Space>
    </Card>
  );
}
