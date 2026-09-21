import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './theme/tokens.css';
import './index.css';
import { applyTheme, storedThemeId } from './theme/applyTheme.js';

// 启动即应用主题（localStorage 兜底；登录后 App 会用 settings.ui.themeId 覆盖）
applyTheme(storedThemeId());

const container = document.getElementById('root');
if (!container) {
  throw new Error('未找到挂载节点 #root');
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
