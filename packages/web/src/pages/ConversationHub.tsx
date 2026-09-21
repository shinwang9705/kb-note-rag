import { useEffect, useState } from 'react';
import ChatPage from './ChatPage.js';
import ConversationPage from './ConversationPage.js';
import HistoryPage from './HistoryPage.js';

interface ConversationHubProps {
  /** App 下发的 llmEnabled；false 时整个对话工作区置灰提示 */
  llmEnabled: boolean | null;
  /** 外部跳转（如工作台「继续对话」）传入的目标会话 id */
  targetConversationId: number | null;
  onConsumedTarget: () => void;
  /** 问答引用 → 原文 */
  onOpenDocument: (docId: number) => void;
}

type HubMode = 'conversation' | 'chat' | 'history';

const MODES: Array<{ key: HubMode; label: string }> = [
  { key: 'conversation', label: '多轮对话' },
  { key: 'chat', label: '单轮问答' },
  { key: 'history', label: '历史' },
];

/**
 * 对话容器页：顶部模式切换（多轮对话[默认]/单轮问答/历史），分发渲染子页面。
 * 历史 → 打开对话：内部切到多轮并下发目标会话 id。
 */
export default function ConversationHub({
  llmEnabled,
  targetConversationId,
  onConsumedTarget,
  onOpenDocument,
}: ConversationHubProps) {
  const [mode, setMode] = useState<HubMode>('conversation');
  const [internalTargetId, setInternalTargetId] = useState<number | null>(null);

  // 外部 targetConversationId（工作台「继续对话」等）→ 切多轮并消费
  useEffect(() => {
    if (targetConversationId) {
      setMode('conversation');
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
    <div className="space-y-4">
      {/* 模式切换 */}
      <nav className="flex gap-1 border-b border-line">
        {MODES.map((item) => {
          const active = mode === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setMode(item.key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'border-primary-600 text-primary-600'
                  : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {mode === 'conversation' ? (
        <ConversationPage
          targetConversationId={internalTargetId}
          onConsumedTarget={() => setInternalTargetId(null)}
          onOpenDocument={onOpenDocument}
        />
      ) : null}
      {mode === 'chat' ? <ChatPage onOpenDocument={onOpenDocument} /> : null}
      {mode === 'history' ? (
        <HistoryPage
          onOpenConversation={(id) => {
            setMode('conversation');
            setInternalTargetId(id);
          }}
        />
      ) : null}
    </div>
  );
}
