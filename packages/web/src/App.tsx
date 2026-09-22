import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { api, clearToken, getCachedUser, getToken, setCachedUser, setToken, ApiClientError } from './api/client.js';
import type { User } from '@kb/shared';
import AppShell from './components/AppShell.js';
import type { ModeInfo } from './components/ModeBanner.js';
import type { NavKey } from './nav.js';
import LoginPage from './pages/LoginPage.js';
import RegisterPage from './pages/RegisterPage.js';
import ConversationHub from './pages/ConversationHub.js';
import SharePage from './pages/SharePage.js';
import { applyTheme } from './theme/applyTheme.js';

const HomePage = lazy(() => import('./pages/HomePage.js'));
const DocumentsPage = lazy(() => import('./pages/DocumentsPage.js'));
const SearchPage = lazy(() => import('./pages/SearchPage.js'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.js'));
const AdminPage = lazy(() => import('./pages/AdminPage.js'));
const DocumentReaderPage = lazy(() => import('./pages/DocumentReaderPage.js'));
const UsagePage = lazy(() => import('./pages/UsagePage.js'));
const Dashboard = lazy(() => import('./pages/Dashboard.js'));
const CockpitPage = lazy(() => import('./pages/CockpitPage.js'));

const NAV_KEYS = new Set<NavKey>(['dashboard', 'libraries', 'documents', 'search', 'chat', 'usage', 'cockpit', 'profile', 'settings', 'admin']);

function navFromHash(): NavKey {
  const key = window.location.hash.replace(/^#\/?/, '').split('/')[0] as NavKey;
  return NAV_KEYS.has(key) ? key : 'chat';
}

type View = 'login' | 'register' | 'app';

interface ReaderState {
  docId: number;
  chunk?: number;
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => getCachedUser());
  const [view, setView] = useState<View>(() => (getToken() ? 'app' : 'login'));
  const [activeView, setActiveView] = useState<NavKey>(() => navFromHash());
  const [llmEnabled, setLlmEnabled] = useState<boolean | null>(null);
  const [needsSetup, setNeedsSetup] = useState<boolean>(false);
  const [showWizard, setShowWizard] = useState<boolean>(false);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [searchDocId, setSearchDocId] = useState<number | ''>('');
  const [searchKeyword, setSearchKeyword] = useState<string>('');
  const [targetConversationId, setTargetConversationId] = useState<number | null>(null);
  const [modeInfo, setModeInfo] = useState<ModeInfo | null>(null);

  // 已有 token 时向后端确认一次，过期则回到登录页
  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((res) => {
        setUser(res.user);
        setCachedUser(res.user);
        setView('app');
      })
      .catch((error) => {
        if (!(error instanceof ApiClientError) || (error.status !== 401 && error.status !== 403)) return;
        clearToken();
        setUser(null);
        setView('login');
      });
  }, []);

  useEffect(() => {
    const syncFromUrl = (): void => {
      if (!window.location.hash.startsWith('#/share/')) setActiveView(navFromHash());
    };
    window.addEventListener('hashchange', syncFromUrl);
    return () => window.removeEventListener('hashchange', syncFromUrl);
  }, []);

  // 登录后读取 meta：llmEnabled（问答显隐）+ needsSetup（首次引导）+ 检索模式 + 主题初始化
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .meta()
      .then((meta) => {
        if (cancelled) return;
        setLlmEnabled(meta.llmEnabled);
        setNeedsSetup(meta.needsSetup === true);
        setShowWizard(meta.needsSetup === true);
        setModeInfo({
          searchMode: meta.searchMode,
          embeddingProvider: meta.embeddingProvider,
          vecAvailable: meta.vecAvailable,
        });
      })
      .catch(() => {
        if (!cancelled) setLlmEnabled(false);
      });
    api
      .settings()
      .then((settings) => {
        if (!cancelled && settings.ui?.themeId) applyTheme(settings.ui.themeId);
      })
      .catch(() => {
        /* 主题读取失败走 localStorage 兜底 */
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSetupComplete = (): void => {
    setShowWizard(false);
    setNeedsSetup(false);
    void api
      .meta()
      .then((meta) => {
        setLlmEnabled(meta.llmEnabled);
        setNeedsSetup(meta.needsSetup === true);
        setModeInfo({
          searchMode: meta.searchMode,
          embeddingProvider: meta.embeddingProvider,
          vecAvailable: meta.vecAvailable,
        });
      })
      .catch(() => {
        /* 忽略 */
      });
  };

  const handleAuthed = (payload: { user: User; token: string }): void => {
    setToken(payload.token);
    setCachedUser(payload.user);
    setUser(payload.user);
    setView('app');
    setActiveView('chat');
    window.location.hash = '/chat';
  };

  const handleLogout = async (): Promise<void> => {
    try {
      await api.logout();
    } catch {
      // 即使网络不可用，也必须清理本机登录状态。
    }
    clearToken();
    setUser(null);
    setReader(null);
    setTargetConversationId(null);
    setShowWizard(false);
    setView('login');
  };

  // ---- 跨模块导航回调（唯一导航状态源） ----

  /** 侧栏/顶栏/抽屉导航：进入检索页时清空旧范围与关键词，得到全新检索页 */
  const handleNavigate = (view: NavKey): void => {
    if (view === 'search') {
      setSearchKeyword('');
      setSearchDocId('');
    }
    setActiveView(view);
    if (window.location.hash !== `#/${view}`) window.location.hash = `/${view}`;
  };

  /** 全局检索 / 工作台快捷检索：带词跳检索页并自动检索 */
  const handleSearch = (keyword: string): void => {
    setSearchKeyword(keyword.trim());
    setSearchDocId('');
    setActiveView('search');
    window.location.hash = '/search';
  };

  /** 打开原文（覆盖层），可带初始定位 chunk */
  const handleOpenDocument = (docId: number, chunk?: number): void => {
    setReader({ docId, chunk });
  };

  /** 原文 → 本文档内检索 */
  const handleSearchInDoc = (docId: number): void => {
    setReader(null);
    setSearchDocId(docId);
    setSearchKeyword('');
    setActiveView('search');
    window.location.hash = '/search';
  };

  /** 工作台「继续对话」等外部跳转：落到对话工作区并携带目标会话 id */
  const handleOpenConversation = (id: number): void => {
    setTargetConversationId(id);
    setActiveView('chat');
    window.location.hash = '/chat';
  };

  /** 进入驾驶舱（AppShell 之外的全屏大屏视图） */
  const handleOpenCockpit = (): void => {
    setActiveView('cockpit');
    window.location.hash = '/cockpit';
  };

  /** 退出驾驶舱：返回工作台 */
  const handleExitCockpit = (): void => {
    setActiveView('dashboard');
    window.location.hash = '/dashboard';
  };

  // 公开分享落地页：hash 前缀 #/share/ 覆盖登录态，公开访问
  if (window.location.hash.startsWith('#/share/')) {
    return <SharePage />;
  }

  if (view === 'register') {
    return <RegisterPage onBack={() => setView('login')} onAuthed={handleAuthed} />;
  }
  if (view === 'login' || !user) {
    return <LoginPage onGoRegister={() => setView('register')} onAuthed={handleAuthed} />;
  }

  // 驾驶舱：AppShell 之外的全屏大屏分支（与 DocumentReaderPage 覆盖层同构的渲染策略）
  if (activeView === 'cockpit') {
    return <Suspense fallback={<PageLoading />}><CockpitPage user={user} onExit={handleExitCockpit} /></Suspense>;
  }

  const renderPage = (): React.ReactNode => {
    switch (activeView) {
      case 'dashboard':
        return (
          <Dashboard
            user={user}
            onNavigate={handleNavigate}
            onOpenDocument={handleOpenDocument}
            onOpenConversation={handleOpenConversation}
            onStartSearch={handleSearch}
            onOpenCockpit={handleOpenCockpit}
          />
        );
      case 'libraries':
        return <HomePage />;
      case 'documents':
        return <DocumentsPage onOpenDocument={(docId) => handleOpenDocument(docId)} />;
      case 'search':
        return (
          <SearchPage
            docId={searchDocId}
            initialKeyword={searchKeyword}
            onOpenDocument={(docId, chunk) => handleOpenDocument(docId, chunk)}
          />
        );
      case 'chat':
        return (
          <ConversationHub
            llmEnabled={llmEnabled}
            targetConversationId={targetConversationId}
            onConsumedTarget={() => setTargetConversationId(null)}
            onOpenDocument={(docId) => handleOpenDocument(docId)}
          />
        );
      case 'usage':
        return <UsagePage user={user} />;
      case 'profile':
        return <ProfilePage user={user} />;
      case 'settings':
        return <SettingsPage />;
      case 'admin':
        return <AdminPage />;
      default:
        return null;
    }
  };

  return (
    <>
      <AppShell
        user={user}
        activeView={activeView}
        llmEnabled={llmEnabled}
        searchMode={modeInfo}
        onNavigate={handleNavigate}
        onSearch={handleSearch}
        onOpenCockpit={handleOpenCockpit}
        onLogout={() => void handleLogout()}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={activeView}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            <Suspense fallback={<PageLoading />}>{renderPage()}</Suspense>
          </motion.div>
        </AnimatePresence>
      </AppShell>

      {/* 原文阅读覆盖层（在 AppShell 之外，全屏） */}
      {reader ? (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-bg">
          <div className="mx-auto max-w-5xl p-4 sm:p-8">
            <Suspense fallback={<PageLoading />}><DocumentReaderPage
              docId={reader.docId}
              initialChunk={reader.chunk}
              onBack={() => {
                setReader(null);
              }}
              onSearchInDoc={(docId) => handleSearchInDoc(docId)}
            /></Suspense>
          </div>
        </div>
      ) : null}

      {/* 首次引导：无任何可用供应商时强制弹出配置向导 */}
      {showWizard ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-6">
          <div className="mt-10 w-full max-w-3xl rounded-lg bg-surface p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-semibold text-ink">欢迎使用 kb-note，先完成 API 配置</h2>
              {(
                <button
                  type="button"
                  onClick={() => setShowWizard(false)}
                  className="rounded border border-line px-3 py-1.5 text-sm text-muted hover:bg-secondary-100"
                >
                  跳过
                </button>
              )}
            </div>
            <Suspense fallback={<PageLoading />}><SettingsPage onSetupComplete={handleSetupComplete} /></Suspense>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PageLoading() {
  return <div className="flex min-h-48 items-center justify-center text-sm text-muted">正在加载工作区…</div>;
}
