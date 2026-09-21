/** @type {import('tailwindcss').Config} */
export default {
  // 无论从 monorepo 根目录还是 web 启动，都扫描同一套源码。
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  theme: {
    // 4 档响应式断点（移动优先，min-width）：
    // base=移动(<768) / sm=平板(≥768) / md=桌面(≥1280) / lg=大屏(≥1920) / xl=超大屏(≥2560 预留)
    screens: {
      sm: '768px',
      md: '1280px',
      lg: '1920px',
      xl: '2560px',
    },
    extend: {
      colors: {
        // 品牌色系映射到 CSS 变量（applyTheme 切换主题时自动变色）
        brand: {
          50: 'rgb(var(--color-brand-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-brand-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-brand-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-brand-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-brand-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-brand-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-brand-700-rgb) / <alpha-value>)',
        },
        // primary = brand 别名（同一批变量，不新增 JSON）
        primary: {
          50: 'rgb(var(--color-brand-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-brand-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-brand-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-brand-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-brand-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-brand-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-brand-700-rgb) / <alpha-value>)',
        },
        secondary: {
          50: 'rgb(var(--color-secondary-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-secondary-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-secondary-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-secondary-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-secondary-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-secondary-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-secondary-700-rgb) / <alpha-value>)',
        },
        success: {
          50: 'rgb(var(--color-success-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-success-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-success-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-success-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-success-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-success-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-success-700-rgb) / <alpha-value>)',
        },
        warning: {
          50: 'rgb(var(--color-warning-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-warning-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-warning-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-warning-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-warning-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-warning-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-warning-700-rgb) / <alpha-value>)',
        },
        danger: {
          50: 'rgb(var(--color-danger-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-danger-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-danger-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-danger-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-danger-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-danger-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-danger-700-rgb) / <alpha-value>)',
        },
        info: {
          50: 'rgb(var(--color-info-50-rgb) / <alpha-value>)',
          100: 'rgb(var(--color-info-100-rgb) / <alpha-value>)',
          200: 'rgb(var(--color-info-200-rgb) / <alpha-value>)',
          300: 'rgb(var(--color-info-300-rgb) / <alpha-value>)',
          500: 'rgb(var(--color-info-500-rgb) / <alpha-value>)',
          600: 'rgb(var(--color-info-600-rgb) / <alpha-value>)',
          700: 'rgb(var(--color-info-700-rgb) / <alpha-value>)',
        },
        // 既有中性 / 主题 token
        surface: 'rgb(var(--color-surface-rgb) / <alpha-value>)',
        bg: 'rgb(var(--color-bg-rgb) / <alpha-value>)',
        ink: 'rgb(var(--color-text-rgb) / <alpha-value>)',
        muted: 'rgb(var(--color-text-muted-rgb) / <alpha-value>)',
        line: 'rgb(var(--color-border-rgb) / <alpha-value>)',
        accent: 'rgb(var(--color-accent-rgb) / <alpha-value>)',
      },
      borderRadius: {
        control: 'var(--radius-control)',
        card: 'var(--radius-card)',
        modal: 'var(--radius-modal)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        raised: 'var(--shadow-raised)',
        modal: 'var(--shadow-modal)',
      },
    },
  },
  plugins: [],
};
