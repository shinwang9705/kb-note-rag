import { useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type { Conversation, GenerationParams, MessageView, ThinkingEvent } from '@kb/shared';
import { DEFAULT_GENERATION_PARAMS } from '@kb/shared';
import ThinkingTimeline, { type ThinkingRoundView } from '../components/ThinkingTimeline.js';

/**
 * 多轮对话页：会话列表 + 消息流（流式）+ 参数面板 + 停止按钮。
 * thinkingRounds >= 2 时走深度思考（agent）模式，消息流内嵌 ThinkingTimeline。
 * 纯文本渲染（禁止 dangerouslySetInnerHTML），风格对齐 ChatPage/Tailwind。
 * 响应式：会话列表 md:flex（<md 收进抽屉）、参数面板 lg:block（<lg 收进弹出层）。
 */
interface ThinkingState {
  runId: number | null;
  totalRounds: number;
  rounds: ThinkingRoundView[];
  finalDraft: string;
  stopReason: string | null;
  budgetWarning: string | null;
  aborted: { runId: number; completedRounds: number; resumable: boolean } | null;
}

const EMPTY_THINKING: ThinkingState = {
  runId: null,
  totalRounds: 0,
  rounds: [],
  finalDraft: '',
  stopReason: null,
  budgetWarning: null,
  aborted: null,
};

interface ConversationPageProps {
  /** 从历史页跳转过来的目标会话 id（可选） */
  targetConversationId?: number | null;
  onConsumedTarget?: () => void;
  onOpenDocument?: (docId: number) => void;
}

export default function ConversationPage({ targetConversationId, onConsumedTarget, onOpenDocument }: ConversationPageProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [assistantDraft, setAssistantDraft] = useState('');
  const [trimmedNotice, setTrimmedNotice] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useState<GenerationParams>({ ...DEFAULT_GENERATION_PARAMS });
  const [kbEnabled, setKbEnabled] = useState(false);
  const [thinking, setThinking] = useState<ThinkingState>(EMPTY_THINKING);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendLock = useRef(false);
  const createdId = useRef<number | null>(null);
  const draftRef = useRef('');
  const stickToBottom = useRef(true);
  const settingsQueue = useRef<Promise<unknown>>(Promise.resolve());
  const streamAbort = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  // 移动/平板端：会话列表抽屉、参数面板弹出层
  const [listOpen, setListOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);

  const agentMode = params.thinkingRounds >= 2;

  const refreshConversations = async (): Promise<void> => {
    try {
      const res = await api.conversations({ pageSize: 50 });
      setConversations(res.items);
    } catch {
      /* 刷新列表失败不阻断对话 */
    }
  };

  useEffect(() => {
    void refreshConversations();
    return () => { streamAbort.current?.abort(); };
  }, []);

  // 历史页跳转：选中目标会话后消费掉标记，避免重复触发
  useEffect(() => {
    if (targetConversationId) {
      setActiveId(targetConversationId);
      onConsumedTarget?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetConversationId]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      setLoading(false);
      setLoadFailed(false);
      return;
    }
    // 新建会话尚未发出首条消息，无历史可读；避免空结果覆盖 SSE start。
    if (createdId.current === activeId) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setMessages([]);
    setError('');
    setAssistantDraft('');
    setThinking(EMPTY_THINKING);
    void Promise.all([api.conversationMessages(activeId, { limit: 200 }), api.conversation(activeId)])
      .then(([res, detail]) => {
        if (cancelled) return;
        setMessages(res.items);
        setParams(detail.item.params);
        setKbEnabled(detail.item.kbEnabled);
        stickToBottom.current = true;
      })
      .catch(() => {
        if (!cancelled) {
          setError('历史对话加载失败，请重试。');
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const conversation = conversations.find((item) => item.id === activeId);
    if (conversation) {
      setParams(conversation.params);
      setKbEnabled(conversation.kbEnabled);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, historyVersion]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
  }, [messages, assistantDraft, thinking]);

  const ensureConversation = async (): Promise<number | null> => {
    if (activeId) return activeId;
    try {
      const res = await api.createConversation({ params, kbEnabled });
      const conversation = res.item;
      setConversations((prev) => [conversation, ...prev]);
      createdId.current = conversation.id;
      setActiveId(conversation.id);
      return conversation.id;
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '创建会话失败');
      return null;
    }
  };

  const finalizeAssistant = (status: 'done' | 'aborted' | 'failed', content: string, runId: number | null): void => {
    setMessages((msgs) => {
      let lastIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (msgs[i]?.role === 'assistant') {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx < 0) return msgs;
      return msgs.map((message, index) =>
        index === lastIdx
          ? { ...message, status, content: content || message.content, thinkingRunId: runId ?? message.thinkingRunId }
          : message,
      );
    });
  };

  const handleThinkingEvent = (event: ThinkingEvent): void => {
    switch (event.type) {
      case 'run_started':
        setThinking((prev) => ({ ...prev, runId: event.runId, totalRounds: event.totalRounds }));
        break;
      case 'round_started':
        setThinking((prev) => ({
          ...prev,
          rounds: [
            ...prev.rounds,
            { index: event.index, instruction: event.instruction, status: 'running', liveDraft: '' },
          ],
        }));
        break;
      case 'round_delta':
        setThinking((prev) => ({
          ...prev,
          rounds: prev.rounds.map((round) =>
            round.index === event.index && round.status === 'running'
              ? { ...round, liveDraft: round.liveDraft + event.text }
              : round,
          ),
        }));
        break;
      case 'round_done':
        setThinking((prev) => ({
          ...prev,
          rounds: prev.rounds.map((round) =>
            round.index === event.index
              ? { ...round, status: 'done', artifact: event.artifact, liveDraft: event.artifact.draft }
              : round,
          ),
        }));
        break;
      case 'round_failed':
        setThinking((prev) => ({
          ...prev,
          rounds: prev.rounds.map((round) =>
            round.index === event.index
              ? { ...round, status: 'failed', errorMessage: event.error.userMessage }
              : round,
          ),
        }));
        break;
      case 'final_delta':
        setThinking((prev) => ({ ...prev, finalDraft: prev.finalDraft + event.text }));
        break;
      case 'budget_warning':
        setThinking((prev) => ({
          ...prev,
          budgetWarning: `预算耗尽：已消耗 ${event.consumed}，上限 ${event.limit}`,
        }));
        break;
      case 'run_completed':
        setThinking((prev) => ({
          ...prev,
          stopReason: event.stopReason,
          finalDraft: event.run.finalContent || prev.finalDraft,
        }));
        finalizeAssistant(event.run.status === 'completed' ? 'done' : 'failed', event.run.finalContent, event.run.id);
        setAssistantDraft('');
        void refreshConversations();
        break;
      case 'run_aborted':
        setThinking((prev) => ({
          ...prev,
          aborted: { runId: event.runId, completedRounds: event.completedRounds, resumable: event.resumable },
        }));
        finalizeAssistant('aborted', '', event.runId);
        setAssistantDraft('');
        break;
      default:
        break;
    }
  };

  const handleSend = async (): Promise<void> => {
    const content = input.trim();
    if (!content || sendLock.current || loading || loadFailed) return;
    sendLock.current = true;
    setStreaming(true);
    stickToBottom.current = true;
    draftRef.current = '';
    setError('');
    setTrimmedNotice(null);
    setAssistantDraft('');

    try {
      await settingsQueue.current;
      const id = await ensureConversation();
      if (!id) return;
      // 发出请求前确认服务端参数与界面一致；保存失败不继续生成。
      await api.patchConversation(id, { params, kbEnabled });
      setInput('');
      streamAbort.current = new AbortController();
      if (agentMode) {
        setThinking(EMPTY_THINKING);
        await runAgentSend(id, content);
      } else {
        await runChatSend(id, content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败，请重试');
    } finally {
      sendLock.current = false;
      setStreaming(false);
    }
  };

  const failStream = (message: string, code = ''): void => {
    const aborted = code === 'ABORTED' || code === 'LLM_ABORTED';
    setError(aborted ? '' : message);
    setMessages((prev) => prev.map((item) => item.status === 'streaming'
      ? { ...item, content: item.content + draftRef.current, status: aborted ? 'aborted' as const : 'failed' as const } : item));
    setAssistantDraft('');
  };

  const runChatSend = async (id: number, content: string): Promise<void> => {
    try {
      await api.sendMessage(id, { content, mode: 'chat' }, {
        onStart: (payload) => {
          setMessages((prev) => {
            const without = prev.filter(
              (message) => message.id !== payload.userMessage.id && message.id !== payload.assistantMessageId,
            );
            const assistant: MessageView = {
              id: payload.assistantMessageId,
              conversationId: id,
              seq: payload.userMessage.seq + 1,
              role: 'assistant',
              content: '',
              reasoning: null,
              parentId: null,
              branchIndex: 0,
              status: 'streaming',
              thinkingRunId: null,
              citations: [],
              model: null,
              providerId: null,
              tokenIn: 0,
              tokenOut: 0,
              latencyMs: 0,
              error: null,
              createdAt: new Date().toISOString(),
              completedAt: null,
            };
            return [...without, payload.userMessage, assistant];
          });
        },
        onDelta: (text) => { draftRef.current += text; setAssistantDraft(draftRef.current); },
        onTrimmed: (droppedCount) => setTrimmedNotice(`已压缩 ${droppedCount} 条较早消息`),
        onDone: (message) => {
          setMessages((prev) => prev.map((item) => (item.id === message.id ? message : item)));
          setAssistantDraft('');
          void refreshConversations();
        },
        onError: (code, message) => {
          failStream(message || code, code);
        },
      }, streamAbort.current?.signal);
    } catch (err) {
      failStream(err instanceof ApiClientError ? err.message : '连接中断，已保留收到的内容，请重试。');
    }
  };

  const runAgentSend = async (id: number, content: string): Promise<void> => {
    try {
      await api.sendMessage(id, { content, mode: 'agent' }, {
        onStart: (payload) => {
          setMessages((prev) => {
            const without = prev.filter(
              (message) => message.id !== payload.userMessage.id && message.id !== payload.assistantMessageId,
            );
            const assistant: MessageView = {
              id: payload.assistantMessageId,
              conversationId: id,
              seq: payload.userMessage.seq + 1,
              role: 'assistant',
              content: '',
              reasoning: null,
              parentId: null,
              branchIndex: 0,
              status: 'streaming',
              thinkingRunId: null,
              citations: [],
              model: null,
              providerId: null,
              tokenIn: 0,
              tokenOut: 0,
              latencyMs: 0,
              error: null,
              createdAt: new Date().toISOString(),
              completedAt: null,
            };
            return [...without, payload.userMessage, assistant];
          });
        },
        onDelta: () => {
          /* agent 模式用 round_delta，不用 chat 的 content_delta */
        },
        onThinkingEvent: (event) => handleThinkingEvent(event),
        onDone: () => {
          /* agent 模式由 run_completed 收尾 */
        },
        onError: (code, message) => {
          failStream(message || code, code);
        },
      }, streamAbort.current?.signal);
    } catch (err) {
      failStream(err instanceof ApiClientError ? err.message : '发送失败');
    }
  };

  const handleResume = async (): Promise<void> => {
    const runId = thinking.runId;
    if (!runId || sendLock.current) return;
    sendLock.current = true;
    setError('');
    setStreaming(true);
    streamAbort.current = new AbortController();
    try {
      await api.resumeThinkingRun(runId, {
        onThinkingEvent: (event) => handleThinkingEvent(event),
        onError: (code, message) => setError(message || code),
      }, streamAbort.current.signal);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '续跑失败');
    } finally {
      sendLock.current = false;
      setStreaming(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    if (!activeId || !streaming) return;
    try {
      await api.abortConversation(activeId);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '停止失败');
    }
  };

  const handleNew = (): void => {
    if (sendLock.current) return;
    createdId.current = null;
    setActiveId(null);
    setMessages([]);
    setAssistantDraft('');
    setTrimmedNotice(null);
    setError('');
    setThinking(EMPTY_THINKING);
  };

  const handleDelete = async (id: number): Promise<void> => {
    if (sendLock.current || !window.confirm('删除此会话及全部消息？此操作无法撤销。')) return;
    try {
      await api.deleteConversation(id);
      setConversations((prev) => prev.filter((item) => item.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
        setThinking(EMPTY_THINKING);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '删除失败');
    }
  };

  const updateParam = (key: keyof GenerationParams, value: number): void => {
    setParams((prev) => ({ ...prev, [key]: value }));
    if (activeId) settingsQueue.current = settingsQueue.current.then(() =>
      api.patchConversation(activeId, { params: { [key]: value } }),
    ).catch(() => { setError('参数保存失败，请重新设置后再发送。'); });
  };

  const toggleKb = (): void => {
    const next = !kbEnabled;
    setKbEnabled(next);
    if (activeId) settingsQueue.current = settingsQueue.current.then(() =>
      api.patchConversation(activeId, { kbEnabled: next }),
    ).catch(() => { setError('知识库设置保存失败，请重新设置。'); });
  };

  return (
    <div className="conversation-workspace flex gap-4">
      {/* 会话列表（桌面常驻；移动/平板收进抽屉） */}
      <aside className="hidden w-64 shrink-0 flex-col rounded-card border border-line bg-surface shadow-card md:flex">
        <div className="border-b border-line p-3">
          <button
            type="button"
            onClick={handleNew}
            disabled={streaming}
            className="w-full rounded-control bg-primary-600 px-3 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
          >
            新建对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted">暂无对话，点击上方新建</p>
          ) : (
            <ul className="divide-y divide-line">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    disabled={streaming}
                    onClick={() => { createdId.current = null; setActiveId(conversation.id); }}
                    className={`flex-1 truncate text-left text-sm ${
                      activeId === conversation.id ? 'font-medium text-primary-600' : 'text-ink'
                    }`}
                  >
                    {conversation.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(conversation.id)}
                    disabled={streaming}
                    className="text-xs text-muted hover:text-danger-600"
                    title="删除会话"
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* 消息流 + 输入 */}
      <section className="flex min-w-0 flex-1 flex-col rounded-card border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setListOpen(true)}
              className="rounded-control border border-line px-2.5 py-1 text-xs text-ink hover:bg-secondary-100 md:hidden"
            >
              会话
            </button>
            <h2 className="text-base font-medium">多轮对话</h2>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-muted">
              <input type="checkbox" checked={kbEnabled} disabled={streaming || loading} onChange={toggleKb} className="accent-primary-600" />
              挂载知识库
            </label>
            <button
              type="button"
              onClick={() => setParamsOpen(true)}
              className="rounded-control border border-line px-2.5 py-1 text-xs text-ink hover:bg-secondary-100 lg:hidden"
            >
              参数
            </button>
          </div>
        </div>

        <div ref={scrollRef} aria-label="对话消息" aria-busy={loading || streaming}
          onScroll={() => { const el = scrollRef.current; if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
          className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-6">
          {loading ? <p role="status" className="py-8 text-center text-sm text-muted">正在加载历史对话…</p> : null}
          {loadFailed ? <button className="rounded-control border border-line px-3 py-2 text-sm text-ink" onClick={() => setHistoryVersion((v) => v + 1)}>重新加载</button> : null}
          {trimmedNotice ? (
            <div className="rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
              {trimmedNotice}
            </div>
          ) : null}
          {messages.length === 0 && !streaming && !loading && !loadFailed ? (
            <p className="py-8 text-center text-sm text-muted">
              开始一段新对话吧。多轮对话会记住上文，你可以在右侧调节参数。
            </p>
          ) : null}
          {messages.map((message) => {
            const isUser = message.role === 'user';
            const text = message.content + (message.status === 'streaming' ? assistantDraft : '');
            return (
              <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div className="min-w-0 max-w-[92%] sm:max-w-[85%]">
                  <p className={`mb-1.5 text-xs text-muted ${isUser ? 'text-right' : ''}`}>{isUser ? '你' : '知识库助手'}</p>
                  <div
                    className={`message-bubble rounded-card px-4 py-3 text-sm leading-7 ${isUser ? 'message-bubble-user' : ''}`}
                  >
                    {text || (message.status === 'streaming' ? (agentMode ? '深度思考中…' : '思考中…') : '')}
                  </div>
                  {message.status === 'failed' || message.status === 'aborted' ? <p className="mt-1 text-xs text-warning-700">{message.status === 'aborted' ? '已停止生成' : '生成未完成，已保留部分内容'}</p> : null}
                  {!isUser && message.citations.length > 0 ? (
                    <div className="mt-2 space-y-1.5">
                      {message.citations.map((citation, index) => (
                        <div
                          key={`${citation.chunkId}-${index}`}
                          className="rounded-card border border-line bg-surface px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-1.5 text-xs">
                            <span className="font-medium text-ink">{citation.docTitle}</span>
                            {onOpenDocument ? <button type="button" onClick={() => onOpenDocument(citation.docId)} className="text-primary-600 hover:underline">查看原文</button> : null}
                            {citation.sectionPath ? (
                              <span className="text-muted">› {citation.sectionPath}</span>
                            ) : null}
                          </div>
                          <p className="mt-0.5 text-xs leading-relaxed text-muted">{citation.snippet}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          {thinking.rounds.length > 0 || thinking.finalDraft ? (
            <ThinkingTimeline
              totalRounds={thinking.totalRounds}
              rounds={thinking.rounds}
              finalDraft={thinking.finalDraft}
              stopReason={thinking.stopReason}
              budgetWarning={thinking.budgetWarning}
              aborted={thinking.aborted}
              onResume={() => void handleResume()}
            />
          ) : null}

          {error ? (
            <p role="alert" className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-600">{error}</p>
          ) : null}
        </div>

        <div className="border-t border-line p-3">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={2}
            aria-label="消息内容"
            maxLength={20000}
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
            disabled={streaming || loading || loadFailed}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                void handleSend();
              }
            }}
            className="w-full resize-none rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500 disabled:bg-secondary-50"
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted">
              {agentMode ? '深度思考' : '普通对话'} · temperature {params.temperature.toFixed(2)} · maxTokens {params.maxTokens}
            </div>
            <div className="flex gap-2">
              {streaming ? (
                <button
                  type="button"
                  onClick={() => void handleStop()}
                  className="rounded-control border border-danger-300 px-4 py-1.5 text-sm text-danger-600 hover:bg-danger-50"
                >
                  停止
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={streaming || loading || loadFailed || !input.trim()}
                className="rounded-control bg-primary-600 px-5 py-1.5 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {streaming ? '生成中…' : '发送'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 参数面板（桌面常驻；<lg 收进弹出层） */}
      <aside className="hidden w-60 shrink-0 rounded-card border border-line bg-surface p-4 shadow-card lg:block">
        <h3 className="mb-4 text-sm font-medium text-ink">参数面板</h3>
        <div className="space-y-5">
          <ParamSlider
            label="temperature"
            value={params.temperature}
            min={0}
            max={2}
            step={0.1}
            disabled={streaming}
            onChange={(value) => updateParam('temperature', value)}
          />
          <ParamSlider
            label="topP"
            value={params.topP}
            min={0}
            max={1}
            step={0.05}
            disabled={streaming}
            onChange={(value) => updateParam('topP', value)}
          />
          <ParamSlider
            label="maxTokens"
            value={params.maxTokens}
            min={256}
            max={8192}
            step={256}
            disabled={streaming}
            onChange={(value) => updateParam('maxTokens', value)}
          />
          <ParamSlider
            label="thinkingRounds"
            value={params.thinkingRounds}
            min={1}
            max={10}
            step={1}
            disabled={streaming}
            onChange={(value) => updateParam('thinkingRounds', value)}
          />
          <p className="text-xs text-muted">
            {agentMode ? 'thinkingRounds ≥ 2：走深度思考（多轮反思）' : 'thinkingRounds = 1：普通多轮对话'}
          </p>
        </div>
      </aside>

      {/* 移动/平板：会话列表抽屉 */}
      {listOpen ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setListOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-line bg-surface shadow-modal">
            <div className="flex items-center justify-between border-b border-line p-3">
              <span className="text-sm font-medium text-ink">会话列表</span>
              <button
                type="button"
                onClick={() => setListOpen(false)}
                className="text-muted hover:text-ink"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="border-b border-line p-3">
              <button
                type="button"
                onClick={() => {
                  handleNew();
                  setListOpen(false);
                }}
                disabled={streaming}
                className="w-full rounded-control bg-primary-600 px-3 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                新建对话
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {conversations.length === 0 ? (
                <p className="p-4 text-sm text-muted">暂无对话，点击上方新建</p>
              ) : (
                <ul className="divide-y divide-line">
                  {conversations.map((conversation) => (
                    <li key={conversation.id} className="flex items-center gap-2 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => {
                          createdId.current = null;
                          setActiveId(conversation.id);
                          setListOpen(false);
                        }}
                        disabled={streaming}
                        className={`flex-1 truncate text-left text-sm ${
                          activeId === conversation.id ? 'font-medium text-primary-600' : 'text-ink'
                        }`}
                      >
                        {conversation.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(conversation.id)}
                        disabled={streaming}
                        className="text-xs text-muted hover:text-danger-600"
                        title="删除会话"
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* 移动/平板：参数面板弹出层 */}
      {paramsOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setParamsOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 right-0 w-72 overflow-y-auto border-l border-line bg-surface p-4 shadow-modal">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink">参数面板</h3>
              <button
                type="button"
                onClick={() => setParamsOpen(false)}
                className="text-muted hover:text-ink"
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-5">
              <ParamSlider
                label="temperature"
                value={params.temperature}
                min={0}
                max={2}
                step={0.1}
                disabled={streaming}
                onChange={(value) => updateParam('temperature', value)}
              />
              <ParamSlider
                label="topP"
                value={params.topP}
                min={0}
                max={1}
                step={0.05}
                disabled={streaming}
                onChange={(value) => updateParam('topP', value)}
              />
              <ParamSlider
                label="maxTokens"
                value={params.maxTokens}
                min={256}
                max={8192}
                step={256}
                disabled={streaming}
                onChange={(value) => updateParam('maxTokens', value)}
              />
              <ParamSlider
                label="thinkingRounds"
                value={params.thinkingRounds}
                min={1}
                max={10}
                step={1}
                disabled={streaming}
                onChange={(value) => updateParam('thinkingRounds', value)}
              />
              <p className="text-xs text-muted">
                {agentMode ? 'thinkingRounds ≥ 2：走深度思考（多轮反思）' : 'thinkingRounds = 1：普通多轮对话'}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ParamSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}

function ParamSlider({ label, value, min, max, step, disabled, onChange }: ParamSliderProps) {
  return (
    <label className="block text-sm">
      <span className="mb-1 flex items-center justify-between text-muted">
        <span>{label}</span>
        <span className="font-mono text-xs text-muted">{value}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary-600"
      />
    </label>
  );
}
