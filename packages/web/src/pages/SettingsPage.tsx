import { useEffect, useRef, useState } from 'react';
import { api, ApiClientError } from '../api/client.js';
import type {
  GenerationParams,
  PatchSettingsInput,
  ProviderInfo,
  RagSearchMode,
  RagSettingsPatch,
  RagStatus,
  Settings,
} from '@kb/shared';
import { applyTheme, THEME_IDS, THEME_LABELS, type ThemeId } from '../theme/applyTheme.js';

interface SettingsPageProps {
  /** 首次引导模式：完成向导后回调（App 据此关闭引导模态） */
  onSetupComplete?: () => void;
}

type WizardStep = 1 | 2 | 3 | 4;

const STEP_LABELS = ['选供应商', '填 Key', '连通测试', '完成'] as const;

const THEME_SWATCH: Record<ThemeId, string> = {
  light: '#3b82f6',
  dark: '#818cf8',
  highContrast: '#1e40af',
};

function validateKey(key: string, hint?: string): string | null {
  if (!key.trim()) return '请输入 API Key';
  if (hint && hint.includes('sk-') && !key.trim().startsWith('sk-')) return 'Key 应以 sk- 开头';
  return null;
}

function ParamSlider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
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
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-primary-600"
      />
    </label>
  );
}

const RAG_MODE_OPTIONS: ReadonlyArray<{ value: RagSearchMode; label: string; desc: string }> = [
  { value: 'auto', label: '自动', desc: '按能力自动降级' },
  { value: 'hybrid', label: '混合', desc: '向量 + 关键词' },
  { value: 'keyword', label: '关键词', desc: '仅 FTS 全文' },
  { value: 'vector', label: '向量', desc: '仅语义' },
];

function RagSlider({ label, desc, value, min, max, step, unit, disabled, onChange }: {
  label: string; desc: string; value: number; min: number; max: number; step: number;
  unit?: string; disabled?: boolean; onChange: (v: number) => void;
}) {
  return (
    <div className={disabled ? 'opacity-40' : ''}>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="font-mono text-xs text-muted">
          {value}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <p className="mb-1 text-xs text-muted">{desc}</p>
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
    </div>
  );
}

function RagToggle({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        <p className="text-xs text-muted">{desc}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-primary-600' : 'bg-secondary-300'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[22px]' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

export default function SettingsPage({ onSetupComplete }: SettingsPageProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [step, setStep] = useState<WizardStep>(1);
  const [providerId, setProviderId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrlOverride, setBaseUrlOverride] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [ragStatus, setRagStatus] = useState<RagStatus | null>(null);

  const selected = providers.find((provider) => provider.id === providerId);

  const configuredProviders = providers.filter((provider) => provider.configured);
  const unconfiguredProviders = providers.filter((provider) => !provider.configured);

  /** 编辑已配置供应商：选中并跳到第 2 步（复用 handleSave 覆盖 Key / Base URL） */
  const startEdit = (provider: ProviderInfo): void => {
    setProviderId(provider.id);
    setApiKey('');
    setBaseUrlOverride('');
    setTestResult(null);
    setError('');
    setNotice('');
    setStep(2);
  };

  /** 删除已配置供应商凭证（二次确认后刷新列表与 needsSetup 状态） */
  const handleDeleteProvider = async (provider: ProviderInfo): Promise<void> => {
    const confirmed = window.confirm(`确定删除「${provider.displayName}」的已保存凭证吗？`);
    if (!confirmed) return;
    setError('');
    setNotice('');
    try {
      await api.deleteProviderCredentials(provider.id);
      setNotice(`已删除「${provider.displayName}」的凭证`);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '删除失败');
    }
  };

  const load = async (): Promise<void> => {
    try {
      const [providerRes, settingsRes] = await Promise.all([api.providers(), api.settings()]);
      setProviders(providerRes.items);
      setSettings(settingsRes);
      setProviderId((prev) => {
        if (prev && providerRes.items.some((p) => p.id === prev)) return prev;
        const def = providerRes.items.find((p) => p.isDefault) ?? providerRes.items.find((p) => p.configured) ?? providerRes.items[0];
        return def?.id ?? '';
      });
      void loadRagStatus();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '加载设置失败');
    }
  };

  const loadRagStatus = async (): Promise<void> => {
    try {
      setRagStatus(await api.ragStatus());
    } catch {
      setRagStatus(null);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTest = async (): Promise<void> => {
    const invalid = validateKey(apiKey, selected?.keyFormatHint);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError('');
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.testProvider(providerId, {
        apiKey: apiKey.trim(),
        baseUrlOverride: baseUrlOverride.trim() || undefined,
      });
      setTestResult({ ok: result.ok, error: result.error?.userMessage });
      if (result.ok) setStep(4);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '连通测试失败');
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    setError('');
    setSaving(true);
    try {
      await api.saveProviderCredentials(providerId, {
        apiKey: apiKey.trim(),
        baseUrlOverride: baseUrlOverride.trim() || undefined,
      });
      await api.patchSettings({ wizardCompleted: true });
      setNotice('供应商已配置');
      await load();
      onSetupComplete?.();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveVersion = useRef(0);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const persistSettings = (patch: PatchSettingsInput): Promise<void> => {
    const version = ++saveVersion.current;
    setSettingsSaving(true);
    const save = saveQueue.current.then(async () => {
      try {
        const res = await api.patchSettings(patch);
        if (version === saveVersion.current) { setSettings(res.settings); setError(''); }
      } catch (err) {
        setError(err instanceof ApiClientError ? err.message : '设置保存失败，请重新操作。');
      } finally {
        if (version === saveVersion.current) setSettingsSaving(false);
      }
    });
    saveQueue.current = save;
    return save;
  };

  const updateParam = (key: keyof GenerationParams, value: number): Promise<void> => {
    setSettings((prev) => prev ? { ...prev, generation: { ...prev.generation, [key]: value } } : prev);
    return persistSettings({ generation: { [key]: value } });
  };

  const changeTheme = (themeId: ThemeId): Promise<void> => {
    applyTheme(themeId);
    setSettings((prev) => prev ? { ...prev, ui: { ...prev.ui, themeId } } : prev);
    return persistSettings({ ui: { themeId } });
  };

  const updateRag = (patch: RagSettingsPatch): Promise<void> => persistSettings({ rag: patch });

  const testErrorHint = (message?: string): string => {
    if (!message) return '';
    if (/鉴权|auth|key/i.test(message)) return '请检查 API Key 是否正确';
    if (/网络|network|ECONN|fetch/i.test(message)) return '请检查网络或 Base URL';
    return message;
  };

  return (
    <div className="space-y-6">
      {settingsSaving ? <p role="status" className="text-sm text-muted">正在保存设置…</p> : null}
      {/* 供应商配置向导 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">API 供应商</h2>
          {onSetupComplete ? <span className="text-sm text-muted">首次配置引导</span> : null}
        </div>

        {/* 已配置供应商（首次引导时折叠为一行摘要，不干扰 4 步流程） */}
        {configuredProviders.length > 0 ? (
          <div className="mb-5">
            {onSetupComplete ? (
              <p className="text-sm text-muted">
                已配置：{configuredProviders.map((provider) => provider.displayName).join('、')}
              </p>
            ) : (
              <>
                <h3 className="mb-2 text-sm font-medium text-ink">已配置供应商</h3>
                <ul className="divide-y divide-line rounded-card border border-line">
                  {configuredProviders.map((provider) => (
                    <li key={provider.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-ink">{provider.displayName}</span>
                          {provider.isDefault ? (
                            <span className="rounded-pill bg-primary-50 px-2 py-0.5 text-xs text-primary-700">默认</span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-muted">
                          {provider.maskedKey ?? '已配置'}
                          {provider.health
                            ? ` · 成功率 ${Math.round(provider.health.okRate * 100)}% · P95 ${provider.health.p95Ms}ms`
                            : ''}
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => startEdit(provider)}
                          className="rounded-control border border-primary-200 px-2.5 py-1 text-xs text-primary-600 hover:bg-primary-50"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteProvider(provider)}
                          className="rounded-control border border-danger-200 px-2.5 py-1 text-xs text-danger-600 hover:bg-danger-50"
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : null}

        <ol className="mb-5 flex items-center gap-2">
          {STEP_LABELS.map((label, index) => {
            const number = (index + 1) as WizardStep;
            const active = step === number;
            const done = step > number;
            return (
              <li key={label} className="flex items-center gap-2">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                    done ? 'bg-success-500 text-white' : active ? 'bg-primary-600 text-white' : 'bg-secondary-200 text-muted'
                  }`}
                >
                  {done ? '✓' : number}
                </span>
                <span className={`text-xs ${active ? 'text-ink' : 'text-muted'}`}>{label}</span>
                {number < 4 ? <span className="mx-1 text-muted">—</span> : null}
              </li>
            );
          })}
        </ol>

        {step === 1 ? (
          unconfiguredProviders.length === 0 ? (
            <p className="text-sm text-muted">所有供应商均已配置，可在上方编辑或删除。</p>
          ) : (
            <div>
              <h3 className="mb-2 text-sm font-medium text-ink">未配置供应商</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {unconfiguredProviders.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => {
                      setProviderId(provider.id);
                      setTestResult(null);
                    }}
                    className={`rounded-card border p-4 text-left ${
                      providerId === provider.id ? 'border-primary-500 bg-primary-50' : 'border-line hover:border-secondary-300'
                    }`}
                  >
                    <div className="font-medium text-ink">{provider.displayName}</div>
                    <div className="mt-1 text-xs text-muted">默认模型：{provider.defaultModel}</div>
                    <div className="text-xs text-muted">Key 格式：{provider.keyFormatHint}</div>
                    <a
                      href={provider.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs text-primary-600 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      去获取 Key ↗
                    </a>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : null}

        {step === 2 ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm text-muted">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={selected?.keyFormatHint ?? '粘贴 API Key'}
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-muted">Base URL（可选，私有网关/代理）</label>
              <input
                value={baseUrlOverride}
                onChange={(e) => setBaseUrlOverride(e.target.value)}
                placeholder={selected ? `默认 ${selected.id}` : ''}
                className="w-full rounded-control border border-line px-3 py-2 text-sm outline-none focus:border-primary-500"
              />
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">将对「{selected?.displayName}」发起一次极小连通测试。</p>
            {testing ? <p className="text-sm text-muted">测试中…</p> : null}
            {testResult && !testResult.ok ? (
              <p className="rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-600">
                测试失败：{testErrorHint(testResult.error)} {testResult.error ? `（${testResult.error}）` : ''}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {testResult?.ok ? '✅ 连通测试通过' : '连接已配置'}。点击「保存」完成配置。
            </p>
            {notice ? <p className="rounded-control bg-success-50 px-3 py-2 text-sm text-success-700">{notice}</p> : null}
          </div>
        ) : null}

        {error ? <p className="mt-3 text-sm text-danger-600">{error}</p> : null}

        <div className="mt-5 flex justify-between">
          <button
            type="button"
            disabled={step === 1}
            onClick={() => setStep((Math.max(1, step - 1)) as WizardStep)}
            className="rounded-control border border-line px-4 py-2 text-sm text-ink hover:bg-secondary-100 disabled:opacity-40"
          >
            上一步
          </button>
          <div className="flex gap-2">
            {step === 2 ? (
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testing || !providerId}
                className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {testing ? '测试中…' : '测试连接'}
              </button>
            ) : null}
            {step < 3 ? (
              <button
                type="button"
                disabled={!providerId}
                onClick={() => setStep((step + 1) as WizardStep)}
                className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                下一步
              </button>
            ) : step === 3 ? (
              <button
                type="button"
                onClick={() => setStep(4)}
                disabled={!testResult?.ok}
                className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                下一步
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !providerId || !apiKey.trim()}
                className="rounded-control bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* 模型参数 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h3 className="mb-4 text-lg font-medium">模型参数</h3>
        {settings ? (
          <div className="space-y-5">
            <ParamSlider label="temperature" value={settings.generation.temperature} min={0} max={2} step={0.1} onChange={(v) => void updateParam('temperature', v)} />
            <ParamSlider label="topP" value={settings.generation.topP} min={0} max={1} step={0.05} onChange={(v) => void updateParam('topP', v)} />
            <ParamSlider label="maxTokens" value={settings.generation.maxTokens} min={256} max={8192} step={256} onChange={(v) => void updateParam('maxTokens', v)} />
            <ParamSlider label="thinkingRounds" value={settings.generation.thinkingRounds} min={1} max={10} step={1} onChange={(v) => void updateParam('thinkingRounds', v)} />
          </div>
        ) : (
          <p className="text-sm text-muted">加载中…</p>
        )}
      </section>

      {/* 主题选择 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h3 className="mb-4 text-lg font-medium">主题</h3>
        <div className="grid grid-cols-3 gap-3">
          {THEME_IDS.map((themeId) => (
            <button
              key={themeId}
              type="button"
              onClick={() => void changeTheme(themeId)}
              className={`rounded-card border p-3 text-left ${
                settings?.ui?.themeId === themeId ? 'border-primary-500 bg-primary-50' : 'border-line hover:border-secondary-300'
              }`}
            >
              <span className="mb-2 block h-6 w-full rounded" style={{ backgroundColor: THEME_SWATCH[themeId] }} />
              <span className="text-sm text-ink">{THEME_LABELS[themeId]}</span>
            </button>
          ))}
        </div>
      </section>

      {/* RAG 设置（运行级参数，改即保存） */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h3 className="mb-4 text-lg font-medium">RAG 设置</h3>
        {settings ? (
          <div className="space-y-6">
            {/* 检索 */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted">检索</h4>
              <RagSlider
                label="topK"
                desc="召回候选数（单通道）"
                value={settings.rag.search.topK}
                min={1}
                max={100}
                step={1}
                unit="条"
                onChange={(v) => void updateRag({ search: { topK: v } })}
              />
              <RagSlider
                label="finalK"
                desc="最终返回条数"
                value={settings.rag.search.finalK}
                min={1}
                max={50}
                step={1}
                unit="条"
                onChange={(v) => void updateRag({ search: { finalK: v } })}
              />
              <div>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-sm font-medium text-ink">defaultMode</span>
                  <span className="font-mono text-xs text-muted">{settings.rag.search.defaultMode}</span>
                </div>
                <p className="mb-2 text-xs text-muted">默认检索模式（请求未显式指定时）</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {RAG_MODE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => void updateRag({ search: { defaultMode: option.value } })}
                      className={`rounded-control border p-2 text-left ${
                        settings.rag.search.defaultMode === option.value
                          ? 'border-primary-500 bg-primary-50'
                          : 'border-line hover:border-secondary-300'
                      }`}
                    >
                      <div className="text-sm text-ink">{option.label}</div>
                      <div className="text-xs text-muted">{option.desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 上下文 */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted">上下文</h4>
              <RagSlider
                label="context.topK"
                desc="进生成片段数（rerank 不可用时的 fallback）"
                value={settings.rag.context.topK}
                min={1}
                max={50}
                step={1}
                unit="条"
                onChange={(v) => void updateRag({ context: { topK: v } })}
              />
            </div>

            {/* 精排 Rerank */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted">精排 Rerank</h4>
              <RagToggle
                label="enabled"
                desc="启用精排（需 provider 可用才真正生效）"
                checked={settings.rag.rerank.enabled}
                onChange={(v) => void updateRag({ rerank: { enabled: v } })}
              />
              <RagSlider
                label="topN"
                desc="喂给 rerank 的候选数"
                value={settings.rag.rerank.topN}
                min={1}
                max={100}
                step={1}
                unit="条"
                disabled={!settings.rag.rerank.enabled}
                onChange={(v) => void updateRag({ rerank: { topN: v } })}
              />
              <RagSlider
                label="topK"
                desc="重排后进生成条数"
                value={settings.rag.rerank.topK}
                min={1}
                max={50}
                step={1}
                unit="条"
                disabled={!settings.rag.rerank.enabled}
                onChange={(v) => void updateRag({ rerank: { topK: v } })}
              />
            </div>

            {/* 置信度阈值 */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium text-muted">置信度阈值</h4>
              <RagSlider
                label="groundedScore"
                desc="top1 相关度 ≥ 此值判为有据"
                value={settings.rag.confidence.groundedScore}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => void updateRag({ confidence: { groundedScore: v } })}
              />
              <RagSlider
                label="partialScore"
                desc="≥ 此值判为部分有据（低于 groundedScore）"
                value={settings.rag.confidence.partialScore}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => void updateRag({ confidence: { partialScore: v } })}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">加载中…</p>
        )}
      </section>

      {/* RAG 能力状态卡 */}
      <section className="rounded-card border border-line bg-surface p-6 shadow-card">
        <h3 className="mb-4 text-lg font-medium">RAG 能力状态</h3>
        {ragStatus ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-control border border-line p-3">
                <div className="text-xs text-muted">向量化 Embedding</div>
                <div className="mt-1 text-sm text-ink">
                  {ragStatus.embedding.provider} · {ragStatus.embedding.model} · dim {ragStatus.embedding.dim}
                </div>
                <span
                  className={`mt-1 inline-block rounded-pill px-2 py-0.5 text-xs ${
                    ragStatus.embedding.available ? 'bg-success-50 text-success-700' : 'bg-secondary-200 text-muted'
                  }`}
                >
                  {ragStatus.embedding.available ? '可用' : '不可用'}
                </span>
              </div>
              <div className="rounded-control border border-line p-3">
                <div className="text-xs text-muted">精排 Rerank</div>
                <div className="mt-1 text-sm text-ink">
                  {ragStatus.rerankProvider.provider} · {ragStatus.rerankProvider.model}
                </div>
                <span
                  className={`mt-1 inline-block rounded-pill px-2 py-0.5 text-xs ${
                    ragStatus.rerankProvider.available ? 'bg-success-50 text-success-700' : 'bg-secondary-200 text-muted'
                  }`}
                >
                  {ragStatus.rerankProvider.available ? '可用' : '不可用'}
                </span>
              </div>
              <div className="rounded-control border border-line p-3">
                <div className="text-xs text-muted">语义向量库 sqlite-vec</div>
                <span
                  className={`mt-1 inline-block rounded-pill px-2 py-0.5 text-xs ${
                    ragStatus.vecAvailable ? 'bg-success-50 text-success-700' : 'bg-warning-50 text-warning-700'
                  }`}
                >
                  {ragStatus.vecAvailable ? '已装载' : '未装载'}
                </span>
              </div>
              <div className="rounded-control border border-line p-3">
                <div className="text-xs text-muted">分块参数</div>
                <div className="mt-1 text-sm text-ink">
                  size {ragStatus.chunk.size} · overlap {ragStatus.chunk.overlap}
                </div>
              </div>
            </div>
            {ragStatus.structuralHint.length > 0 ? (
              <ul className="space-y-1 rounded-control bg-warning-50 px-3 py-2">
                {ragStatus.structuralHint.map((hint) => (
                  <li key={hint} className="text-xs text-warning-700">⚠ {hint}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted">加载中…</p>
        )}
      </section>
    </div>
  );
}
