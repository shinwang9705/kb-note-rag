import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../api/client.js';
import type { Conversation, Document, User } from '@kb/shared';
import Icon from '../components/icons.js';
import type { NavKey } from '../nav.js';

interface DashboardProps {
  user: User;
  onNavigate: (view: NavKey) => void;
  onOpenDocument: (docId: number) => void;
  onOpenConversation: (id: number) => void;
  onStartSearch: (keyword: string) => void;
  onOpenCockpit: () => void;
}

const STATUS_STYLE: Record<Document['status'], string> = {
  pending: 'bg-secondary-100 text-secondary-600',
  processing: 'bg-info-100 text-info-700',
  ready: 'bg-success-100 text-success-700',
  failed: 'bg-danger-100 text-danger-700',
};

const STATUS_LABEL: Record<Document['status'], string> = {
  pending: '等待中',
  processing: '处理中',
  ready: '就绪',
  failed: '失败',
};

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 入场动画包装（stagger 由 delay 控制） */
function Reveal({ delay = 0, children }: { delay?: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.4, delay, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

/**
 * 工作台（默认落地页）：欢迎 + 快捷检索 + 快捷入口（含「驾驶舱」）+ 最近文档/对话。
 * 纯轻量概览，无图表（图表已迁至独立驾驶舱 CockpitPage）。
 */
export default function Dashboard({
  user,
  onNavigate,
  onOpenDocument,
  onOpenConversation,
  onStartSearch,
  onOpenCockpit,
}: DashboardProps) {
  const [recentDocs, setRecentDocs] = useState<Document[]>([]);
  const [recentConversations, setRecentConversations] = useState<Conversation[]>([]);
  const [quickQuery, setQuickQuery] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setError('');
    try {
      const [docs, convs] = await Promise.all([
        api.documents({ limit: 5 }),
        api.conversations({ pageSize: 5 }),
      ]);
      setRecentDocs(docs.items);
      setRecentConversations(convs.items);
    } catch {
      setError('加载工作台概览失败，请稍后重试');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitQuickSearch = (event: React.FormEvent): void => {
    event.preventDefault();
    const q = quickQuery.trim();
    if (!q) return;
    onStartSearch(q);
    setQuickQuery('');
  };

  return (
    <div className="space-y-6">
      {/* 欢迎区 + 快捷检索 */}
      <Reveal delay={0}>
        <section className="rounded-card border border-line bg-surface p-6 shadow-card">
          <h1 className="text-xl font-semibold text-ink">你好，{user.username}</h1>
          <p className="mt-1 text-sm text-muted">这是你的知识库工作台，从这里快速进入检索、上传或提问。</p>
          <form onSubmit={submitQuickSearch} className="mt-4 flex max-w-xl gap-2">
            <div className="relative flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
                <Icon name="search" size={16} />
              </span>
              <input
                value={quickQuery}
                onChange={(e) => setQuickQuery(e.target.value)}
                placeholder="快速检索知识库…"
                className="w-full rounded-control border border-line bg-bg py-2 pl-9 pr-3 text-sm text-ink outline-none placeholder:text-muted focus:border-primary-500"
              />
            </div>
            <button
              type="submit"
              disabled={!quickQuery.trim()}
              className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
            >
              检索
            </button>
          </form>
          {error ? <p className="mt-3 text-sm text-danger-600">{error}</p> : null}
        </section>
      </Reveal>

      {/* 快捷入口（含「打开数据驾驶舱」第 4 卡） */}
      <Reveal delay={0.05}>
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <QuickEntry icon="upload" title="上传文档" desc="批量上传或粘贴文本，构建你的知识库" onClick={() => onNavigate('documents')} />
          <QuickEntry icon="search" title="检索知识库" desc="关键词 + 语义混合检索，快速定位原文" onClick={() => onNavigate('search')} />
          <QuickEntry icon="ask" title="发起提问" desc="统一对话工作区：上下文、模型与引用证据" onClick={() => onNavigate('chat')} />
          <QuickEntry icon="cockpit" title="质量驾驶舱" desc="查看回答质量、知识缺口、任务与索引健康" onClick={onOpenCockpit} />
        </section>
      </Reveal>

      {/* 最近文档 + 最近对话 */}
      <Reveal delay={0.1}>
        <section className="grid gap-6 md:grid-cols-2">
          <div className="rounded-card border border-line bg-surface p-6 shadow-card">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-medium text-ink">最近文档</h2>
              <button type="button" onClick={() => onNavigate('documents')} className="text-sm text-primary-600 hover:underline">
                查看全部
              </button>
            </div>
            {recentDocs.length === 0 ? (
              <p className="text-sm text-muted">还没有文档，先上传一个试试。</p>
            ) : (
              <ul className="divide-y divide-line">
                {recentDocs.map((doc) => (
                  <li key={doc.id} className="flex items-center gap-3 py-2.5">
                    <button type="button" onClick={() => onOpenDocument(doc.id)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm text-ink hover:text-primary-600">{doc.title}</span>
                      <span className="text-xs text-muted">{formatTime(doc.createdAt)}</span>
                    </button>
                    <span className={`shrink-0 rounded-pill px-2 py-0.5 text-xs ${STATUS_STYLE[doc.status]}`}>
                      {STATUS_LABEL[doc.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-card border border-line bg-surface p-6 shadow-card">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-medium text-ink">最近对话</h2>
              <button type="button" onClick={() => onNavigate('chat')} className="text-sm text-primary-600 hover:underline">
                查看全部
              </button>
            </div>
            {recentConversations.length === 0 ? (
              <p className="text-sm text-muted">还没有对话记录。</p>
            ) : (
              <ul className="divide-y divide-line">
                {recentConversations.map((conversation) => (
                  <li key={conversation.id} className="flex items-center gap-3 py-2.5">
                    <button type="button" onClick={() => onOpenConversation(conversation.id)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm text-ink hover:text-primary-600">{conversation.title}</span>
                      <span className="text-xs text-muted">{formatTime(conversation.lastMessageAt || conversation.updatedAt)}</span>
                    </button>
                    <button type="button" onClick={() => onOpenConversation(conversation.id)} className="shrink-0 text-sm text-primary-600 hover:underline">
                      继续
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </Reveal>
    </div>
  );
}

function QuickEntry({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: 'upload' | 'search' | 'ask' | 'cockpit';
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -2 }}
      className="group rounded-card border border-line bg-surface p-5 text-left shadow-card transition-shadow hover:shadow-raised"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600 group-hover:bg-primary-100">
        <Icon name={icon} size={20} />
      </span>
      <h3 className="mt-3 text-sm font-medium text-ink">{title}</h3>
      <p className="mt-1 text-xs text-muted">{desc}</p>
    </motion.button>
  );
}
