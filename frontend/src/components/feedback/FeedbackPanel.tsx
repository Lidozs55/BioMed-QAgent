/** 用户反馈面板 — 支持补充实体 / 重试阶段 / 一般反馈 */
import { useState } from 'react';
import {
  Card, Radio, Input, Button, Select, Typography, Space, App, Tag, Divider, Alert,
} from 'antd';
import {
  EditOutlined, ReloadOutlined, MessageOutlined, LoadingOutlined,
} from '@ant-design/icons';
import { api } from '@/api/client';
import type { TaskSummary } from '@/api/types';

const { TextArea } = Input;
const { Title, Text, Paragraph } = Typography;

type FeedbackType = 'refine_entities' | 'retry_stage' | 'general';

const STAGE_OPTIONS = [
  { label: '规划 (planning)', value: 'planning' },
  { label: '检索 (search)', value: 'search' },
  { label: '采集 (acquire)', value: 'acquire' },
  { label: '解析 (parse)', value: 'parse' },
  { label: '清洗 (clean)', value: 'clean' },
  { label: '分析 (analyze)', value: 'analyze' },
  { label: '审查 (review)', value: 'review' },
];

interface FeedbackPanelProps {
  task: TaskSummary;
}

/** 将换行/逗号分隔的文本拆成数组 */
function splitTokens(text: string): string[] {
  return text
    .split(/[\n,，;；]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

export function FeedbackPanel({ task }: FeedbackPanelProps) {
  const [feedbackType, setFeedbackType] = useState<FeedbackType>('refine_entities');
  const [message, setMessage] = useState('');
  // refine_entities 输入
  const [compounds, setCompounds] = useState('');
  const [genes, setGenes] = useState('');
  const [diseases, setDiseases] = useState('');
  const [pathways, setPathways] = useState('');
  // retry_stage 选择
  const [retryStage, setRetryStage] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const { message: msg } = App.useApp();

  const handleReset = () => {
    setMessage('');
    setCompounds('');
    setGenes('');
    setDiseases('');
    setPathways('');
    setRetryStage(undefined);
  };

  const handleSubmit = async () => {
    if (feedbackType === 'retry_stage' && !retryStage) {
      msg.warning('请选择要重试的阶段');
      return;
    }
    if (feedbackType === 'general' && !message.trim()) {
      msg.warning('请输入反馈内容');
      return;
    }

    const payload: Record<string, unknown> = {
      feedback_type: feedbackType,
      message,
    };

    if (feedbackType === 'refine_entities') {
      const extra: Record<string, string[]> = {};
      const c = splitTokens(compounds);
      const g = splitTokens(genes);
      const d = splitTokens(diseases);
      const p = splitTokens(pathways);
      if (c.length) extra.compounds = c;
      if (g.length) extra.genes = g;
      if (d.length) extra.diseases = d;
      if (p.length) extra.pathways = p;
      if (Object.keys(extra).length === 0) {
        msg.warning('请至少补充一类实体');
        return;
      }
      payload.extra_entities = extra;
    }

    if (feedbackType === 'retry_stage') {
      payload.retry_stage = retryStage;
    }

    setSubmitting(true);
    try {
      const resp = await api.submitFeedback(task.task_id, payload as any);
      msg.success(`反馈已提交：${resp.note || '已记录'}`);
      handleReset();
    } catch (e: any) {
      msg.error(`反馈提交失败：${e.message || e}`);
    } finally {
      setSubmitting(false);
    }
  };

  const isCompleted = task.status === 'completed';
  const isFailed = task.status === 'failed';

  return (
    <Card
      size="small"
      title={<Title level={5} style={{ margin: 0 }}>用户反馈与修正</Title>}
      extra={
        <Tag color={isCompleted ? 'green' : isFailed ? 'red' : 'blue'}>
          {task.status}
        </Tag>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert
          type="info"
          showIcon
          message="人在回路反馈"
          description="对任务结果提供反馈，补充实体或请求重试特定阶段。提交后可重新启动任务以应用修正。"
        />

        <Radio.Group
          value={feedbackType}
          onChange={e => setFeedbackType(e.target.value)}
          optionType="button"
          buttonStyle="solid"
          style={{ width: '100%' }}
        >
          <Radio.Button value="refine_entities" style={{ width: '33.33%', textAlign: 'center' }}>
            <EditOutlined /> 补充实体
          </Radio.Button>
          <Radio.Button value="retry_stage" style={{ width: '33.33%', textAlign: 'center' }}>
            <ReloadOutlined /> 重试阶段
          </Radio.Button>
          <Radio.Button value="general" style={{ width: '33.33%', textAlign: 'center' }}>
            <MessageOutlined /> 一般反馈
          </Radio.Button>
        </Radio.Group>

        {feedbackType === 'refine_entities' && (
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Text type="secondary" style={{ fontSize: 12 }}>
              补充 LLM 规划遗漏的实体（换行或逗号分隔），重新启动任务后将合并到检索查询
            </Text>
            <EntityInput label="化合物" value={compounds} onChange={setCompounds}
                          placeholder="如：黄芪甲苷, 苦参碱" />
            <EntityInput label="基因" value={genes} onChange={setGenes}
                          placeholder="如：TP53, AKT1, EGFR" />
            <EntityInput label="疾病" value={diseases} onChange={setDiseases}
                          placeholder="如：胰腺癌, 肝转移" />
            <EntityInput label="通路" value={pathways} onChange={setPathways}
                          placeholder="如：PI3K-Akt, apoptosis" />
            <Text type="secondary" style={{ fontSize: 11 }}>
              当前规划实体：
              {task.entities.compounds.length + task.entities.genes.length +
               task.entities.diseases.length + task.entities.pathways.length} 个
            </Text>
          </Space>
        )}

        {feedbackType === 'retry_stage' && (
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Text type="secondary" style={{ fontSize: 12 }}>
              选择要从哪个阶段重新执行（重新启动任务后生效）
            </Text>
            <Select
              value={retryStage}
              onChange={setRetryStage}
              options={STAGE_OPTIONS}
              placeholder="选择阶段"
              style={{ width: '100%' }}
            />
            <Alert
              type="warning"
              showIcon
              message="重试需重新启动任务"
              description="提交反馈后，请点击「启动研究」按钮重新执行任务以应用阶段重试。"
            />
          </Space>
        )}

        {feedbackType === 'general' && (
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <Text type="secondary" style={{ fontSize: 12 }}>
              输入一般性反馈或改进建议
            </Text>
            <TextArea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="例如：检索结果相关性偏低，建议增加 MeSH 限定词…"
              autoSize={{ minRows: 4, maxRows: 8 }}
            />
          </Space>
        )}

        {(feedbackType === 'refine_entities' || feedbackType === 'retry_stage') && (
          <>
            <Divider style={{ margin: '4px 0' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>附加说明（可选）</Text>
            <TextArea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="补充说明修正原因或具体要求…"
              autoSize={{ minRows: 2, maxRows: 4 }}
            />
          </>
        )}

        <Button
          type="primary"
          icon={submitting ? <LoadingOutlined /> : undefined}
          onClick={handleSubmit}
          loading={submitting}
          block
        >
          提交反馈
        </Button>

        {(isCompleted || isFailed) && (
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0, textAlign: 'center' }}>
            提交反馈后，在左侧任务面板点击「启动研究」可重新执行任务以应用修正
          </Paragraph>
        )}
      </Space>
    </Card>
  );
}

/** 实体输入子组件 — label + TextArea */
function EntityInput({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <Text style={{ fontSize: 12, marginRight: 8 }}>{label}：</Text>
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        size="small"
      />
    </div>
  );
}
