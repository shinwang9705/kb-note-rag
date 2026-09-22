import { useEffect, useState } from 'react';
import ConversationPage from './ConversationPage.js';

interface ConversationHubProps {
  /** App 下发的 llmEnabled；false 时整个对话工作区置灰提示 */
  llmEnabled: boolean | null;
  /** 外部跳转（如工作台「继续对话」）传入的目标会话 id */
  targetConversationId: number | null;
  onConsumedTarget: () => void;
  /** 问答引用 → 原文 */
  onOpenDocument: (docId: number) => void;
}

/**
 * 统一对话工作区。单轮问答是“新建对话后只问一次”的自然子集，历史也直接
 * 收纳在左侧会话栏，不再让用户先判断应该进入哪个模式。
 */
export default function ConversationHub({
  llmEnabled,
  targetConversationId,
  onConsumedTarget,
  onOpenDocument,
}: ConversationHubProps) {
  const [internalTargetId, setInternalTargetId] = useState<number | null>(null);

  // 外部 targetConversationId（工作台「继续对话」等）→ 切多轮并消费
  useEffect(() => {
    if (targetConversationId) {
      setInternalTargetId(targetConversationId);
      onConsumedTarget();
    }
  }, [targetConversationId, onConsumedTarget]);

  if (llmEnabled === false) {
    return (
      <div className="rounded-lg border border-line bg-surface p-10 text-center shadow-sm">
        <h2 className="text-lg font-medium text-ink">问答未启用（未配置 LLM）</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted">
          请在服务端配置 <code className="rounded bg-secondary-100 px-1 text-secondary-700">LLM_PROVIDER</code> 与{' '}
          <code className="rounded bg-secondary-100 px-1 text-secondary-700">LLM_API_KEY</code>
          ，或到「设置」中完成供应商配置后再使用对话功能。
        </p>
      </div>
    );
  }

  return (
    <ConversationPage
      targetConversationId={internalTargetId}
      onConsumedTarget={() => setInternalTargetId(null)}
      onOpenDocument={onOpenDocument}
    />
  );
}
