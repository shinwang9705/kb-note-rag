import { useState } from 'react';
import Icon from './icons.js';

interface GlobalSearchBoxProps {
  onSearch: (keyword: string) => void;
}

/**
 * 全局检索框（受控）：回车或点击按钮 → onSearch(keyword)。
 * 桌面显示完整输入框，移动端收为图标、点击展开内联输入层。
 */
export default function GlobalSearchBox({ onSearch }: GlobalSearchBoxProps) {
  const [keyword, setKeyword] = useState('');
  const [mobileOpen, setMobileOpen] = useState(false);

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const q = keyword.trim();
    if (!q) return;
    onSearch(q);
    setKeyword('');
    setMobileOpen(false);
  };

  return (
    <>
      {/* 桌面完整框 */}
      <form
        onSubmit={submit}
        className="hidden min-w-0 flex-1 items-center gap-2 sm:flex md:max-w-md"
        role="search"
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <Icon name="search" size={16} />
          </span>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="全局检索知识库…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pl-9 pr-3 text-sm text-ink outline-none transition-colors placeholder:text-muted focus:border-primary-500"
          />
        </div>
        <button
          type="submit"
          disabled={!keyword.trim()}
          className="rounded-md bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
        >
          检索
        </button>
      </form>

      {/* 移动端图标 + 内联展开层 */}
      <div className="relative sm:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-secondary-100 hover:text-ink"
          aria-label="检索"
        >
          <Icon name="search" size={20} />
        </button>
        {mobileOpen ? (
          <form
            onSubmit={submit}
            className="absolute right-0 top-full z-40 mt-2 flex w-72 items-center gap-2 rounded-lg border border-line bg-surface p-2 shadow-lg"
            role="search"
          >
            <input
              autoFocus
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="全局检索知识库…"
              className="min-w-0 flex-1 rounded border border-line px-3 py-1.5 text-sm text-ink outline-none focus:border-primary-500"
            />
            <button
              type="submit"
              disabled={!keyword.trim()}
              className="rounded bg-primary-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              检索
            </button>
          </form>
        ) : null}
      </div>
    </>
  );
}
