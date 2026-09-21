/**
 * 主题运行时应用：读 JSON token -> 注入 :root CSS 变量 + 设 data-theme。
 * 三套内置主题打包进前端产物；改主题 = 改 JSON，不改代码。
 */
import light from './themes/light.json';
import dark from './themes/dark.json';
import highContrast from './themes/highContrast.json';

export const THEME_IDS = ['light', 'dark', 'highContrast'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_LABELS: Record<ThemeId, string> = {
  light: '浅色',
  dark: '深色',
  highContrast: '高对比',
};

const THEMES: Record<ThemeId, Record<string, string>> = {
  light: light as Record<string, string>,
  dark: dark as Record<string, string>,
  highContrast: highContrast as Record<string, string>,
};

function normalize(themeId: string | null | undefined): ThemeId {
  return (THEME_IDS as readonly string[]).includes(themeId ?? '') ? (themeId as ThemeId) : 'light';
}

/** localStorage 兜底 key（业务数据不落 localStorage，仅 UI 偏好） */
const STORAGE_KEY = 'kb.theme';

export function storedThemeId(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'light';
  } catch {
    return 'light';
  }
}

/** 应用主题：注入 CSS 变量 + data-theme + localStorage 兜底 */
export function applyTheme(themeId: string | null | undefined): void {
  const id = normalize(themeId);
  const theme = THEMES[id];
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme)) {
    root.style.setProperty(`--${key}`, value);
    // Tailwind 的 /10、/50 等透明度修饰需要 RGB 通道，不能直接拼接 hex 变量。
    if (key.startsWith('color-') && /^#[\da-f]{6}$/i.test(value)) {
      const rgb = [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16)).join(' ');
      root.style.setProperty(`--${key}-rgb`, rgb);
    }
  }
  root.dataset.theme = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
