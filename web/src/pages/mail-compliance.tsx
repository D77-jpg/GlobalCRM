import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Gauge,
  Globe,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { usePageTitle } from '@/hooks/use-ui';
import { selectIsAdmin, useAuthStore } from '@/store/auth.store';
import { apiDelete, apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { useI18n, type TranslationKey } from '@/i18n';

type SuppressionReason = 'unsubscribe' | 'hard_bounce' | 'complaint' | 'spam' | 'manual';
interface Suppression {
  _id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  scopeKey: string;
  note?: string;
  createdAt: string;
}
interface Settings {
  warmupEnabled: boolean;
  warmupStartedAt?: string;
  warmupStartLimit: number;
  warmupDailyIncrement: number;
  warmupMaxLimit: number;
  dailySendLimit: number;
  trackingEnabled: boolean;
}
interface DomainCheckItem {
  status: 'ok' | 'missing' | 'warning' | 'error';
  records: string[];
  message: string;
}
interface DomainHealth {
  domain: string;
  selector: string;
  checkedAt: string;
  spf: DomainCheckItem;
  dkim: DomainCheckItem;
  dmarc: DomainCheckItem;
  overall: 'ok' | 'warning' | 'error';
}
interface Overview {
  settings: Settings;
  suppressionCount: number;
  mailFrom?: string;
  domain?: string;
  domainHealth: DomainHealth | null;
  effectiveDailyLimit: number;
}

const REASON_KEYS: Record<SuppressionReason, TranslationKey> = {
  unsubscribe: 'compliance.reason.unsubscribe',
  hard_bounce: 'compliance.reason.hard_bounce',
  complaint: 'compliance.reason.complaint',
  spam: 'compliance.reason.spam',
  manual: 'compliance.reason.manual',
};
const EMPTY_ADD = { email: '', reason: 'manual' as SuppressionReason, note: '', global: false };

type ComplianceSection = 'all' | 'suppression' | 'dns' | 'rules';

function StatusBadge({ status }: { status: DomainCheckItem['status'] }): React.JSX.Element {
  const { t } = useI18n();
  const config = {
    ok: {
      label: t('compliance.ok'),
      cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300',
      icon: CheckCircle2,
    },
    missing: {
      label: t('compliance.missing'),
      cls: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300',
      icon: AlertTriangle,
    },
    warning: {
      label: t('compliance.warning'),
      cls: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300',
      icon: AlertTriangle,
    },
    error: {
      label: t('compliance.error'),
      cls: 'border-red-200 bg-red-50 text-red-700 dark:border-red-400/20 dark:bg-red-400/10 dark:text-red-300',
      icon: XCircle,
    },
  }[status];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={config.cls}>
      <Icon className="mr-1 h-3 w-3" aria-hidden />
      {config.label}
    </Badge>
  );
}

export function MailCompliancePage(): React.JSX.Element {
  const { t } = useI18n();
  const isAdmin = useAuthStore(selectIsAdmin);
  usePageTitle(t('compliance.title'));
  const [section, setSection] = React.useState<ComplianceSection>('all');
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [suppressions, setSuppressions] = React.useState<Suppression[]>([]);
  const [search, setSearch] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [removeTarget, setRemoveTarget] = React.useState<Suppression | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addForm, setAddForm] = React.useState(EMPTY_ADD);
  const [addSaving, setAddSaving] = React.useState(false);
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [settingsSaving, setSettingsSaving] = React.useState(false);
  const [domain, setDomain] = React.useState('');
  const [selector, setSelector] = React.useState('default');
  const [checking, setChecking] = React.useState(false);
  const [domainHealth, setDomainHealth] = React.useState<DomainHealth | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextOverview, list] = await Promise.all([
        apiGet<Overview>('/mail-compliance/overview'),
        apiGet<{ items: Suppression[] }>(
          `/mail-compliance/suppressions?limit=100${
            search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''
          }`,
        ),
      ]);
      setOverview(nextOverview);
      setSettings(nextOverview.settings);
      setDomainHealth(nextOverview.domainHealth);
      setDomain((current) => current || nextOverview.domain || nextOverview.domainHealth?.domain || '');
      setSuppressions(list.items);
      setLoadError('');
    } catch (error) {
      const msg = toErrorMessage(error, '加载发信合规配置失败');
      setLoadError(msg);
      toast.error('加载发信合规配置失败', { description: msg });
    } finally {
      setLoading(false);
    }
  }, [search]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const addSuppression = async () => {
    if (!addForm.email.trim()) return;
    setAddSaving(true);
    try {
      await apiPost('/mail-compliance/suppressions', addForm);
      toast.success(t('compliance.added'));
      setAddOpen(false);
      setAddForm(EMPTY_ADD);
      await load();
    } catch (error) {
      toast.error('加入不再发送名单失败', { description: toErrorMessage(error) });
    } finally {
      setAddSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    try {
      await apiDelete(`/mail-compliance/suppressions/${removeTarget._id}`);
      setSuppressions((items) => items.filter((item) => item._id !== removeTarget._id));
      toast.success(`已将 ${removeTarget.email} 移出不再发送名单`);
      setRemoveTarget(null);
    } catch (error) {
      toast.error('移出不再发送名单失败', { description: toErrorMessage(error) });
    }
  };

  const saveSettings = async () => {
    if (!settings) return;
    setSettingsSaving(true);
    try {
      const saved = await apiPut<Settings>('/mail-compliance/settings', settings);
      setSettings(saved);
      setOverview((current) => (current ? { ...current, settings: saved } : current));
      toast.success(t('compliance.settingsSaved'));
    } catch (error) {
      toast.error('保存发送策略失败', { description: toErrorMessage(error) });
    } finally {
      setSettingsSaving(false);
    }
  };

  const checkDns = async () => {
    setChecking(true);
    try {
      const result = await apiGet<DomainHealth>(
        `/mail-compliance/domain-health?domain=${encodeURIComponent(domain)}&selector=${encodeURIComponent(selector)}`,
      );
      setDomainHealth(result);
    } catch (error) {
      toast.error('域名认证检查失败', { description: toErrorMessage(error) });
    } finally {
      setChecking(false);
    }
  };

  const showSuppression = section === 'all' || section === 'suppression';
  const showDns = section === 'all' || section === 'dns';
  const showRules = section === 'all' || section === 'rules';

  return (
    <div className="workspace-page">
      <PageHeader
        title={t('compliance.title')}
        description={t('compliance.subtitle')}
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            {t('compliance.refresh')}
          </Button>
        }
      />

      {/* 4 维合规运行指标卡 */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground">
            <ShieldAlert className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">抑制名单拦截</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-foreground">
              {overview?.suppressionCount ?? suppressions.length}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">退订 / 退信 / 投诉自动拦截</p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground">
            <Gauge className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">{t('compliance.currentCap')}</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-foreground">
              {overview?.effectiveDailyLimit ?? settings?.dailySendLimit ?? '—'}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {settings?.warmupEnabled ? '已启用渐进预热递增' : '按项目固定日上限控制'}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground">
            <Globe className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">域名 DNS 认证</p>
            <p className="mt-1 truncate text-sm font-bold text-foreground">
              {domainHealth ? domainHealth.domain : domain || '待检测'}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {domainHealth
                ? domainHealth.overall === 'ok'
                  ? 'SPF / DKIM / DMARC 正常'
                  : '存在待完善解析项'
                : '点击右侧按钮实时检测'}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">打开与点击追踪</p>
            <p className="mt-1 text-base font-bold text-foreground">
              {settings?.trackingEnabled ? '已启用' : '已关闭'}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">内置退订头与合规留痕</p>
          </div>
        </div>
      </div>

      {/* 模块切换栏 */}
      <nav aria-label="邮件合规模块切换" className="flex flex-wrap items-center gap-5 border-b border-border">
        {(
          [
            ['all', '全部配置'],
            ['suppression', '不再发送名单'],
            ['dns', '域名认证检测'],
            ['rules', '发送规则与预热'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            className={`-mb-px inline-flex h-10 items-center border-b-2 px-1 text-[0.8125rem] font-medium transition-colors ${
              section === key
                ? 'border-foreground font-semibold text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {loading && !overview ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : null}

      {showSuppression || showDns ? (
        <div
          className={`grid gap-4 ${
            showSuppression && showDns ? 'lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start' : ''
          }`}
        >
          {showSuppression ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-[0.9375rem]">
                  <ShieldAlert className="h-4 w-4 text-foreground" aria-hidden />
                  {t('compliance.suppressionTitle')}
                </CardTitle>
                <CardDescription>{t('compliance.suppressionDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('compliance.searchPlaceholder')}
                    className="max-w-[18rem]"
                  />
                  <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
                    <Plus className="h-4 w-4" aria-hidden />
                    {t('compliance.addSuppression')}
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-surface text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5 font-semibold">{t('compliance.email')}</th>
                        <th className="px-3 py-2.5 font-semibold">{t('compliance.reason')}</th>
                        <th className="px-3 py-2.5 font-semibold">{t('compliance.scope')}</th>
                        <th className="px-3 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {suppressions.map((row) => (
                        <tr
                          key={row._id}
                          className="border-t border-border/75 transition-colors hover:bg-surface/60"
                        >
                          <td className="max-w-[15rem] truncate px-3 py-2.5 font-medium" title={row.email}>
                            {row.email}
                          </td>
                          <td className="px-3 py-2.5">
                            <Badge
                              variant={
                                row.reason === 'hard_bounce' || row.reason === 'complaint' || row.reason === 'spam'
                                  ? 'warning'
                                  : 'outline'
                              }
                            >
                              {t(REASON_KEYS[row.reason])}
                            </Badge>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">
                            {row.scopeKey === 'global' ? t('compliance.globalScope') : t('compliance.projectScope')}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            {row.scopeKey === 'global' && !isAdmin ? null : (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t('compliance.remove')}
                                onClick={() => setRemoveTarget(row)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {!suppressions.length ? (
                        <tr>
                          <td colSpan={4} className="px-3 py-10 text-center text-muted-foreground">
                            {loading ? t('common.loading') : t('compliance.empty')}
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground">{t('compliance.unsubscribeNote')}</p>
              </CardContent>
            </Card>
          ) : null}

          {showDns ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-[0.9375rem]">
                  <ShieldCheck className="h-4 w-4 text-foreground" aria-hidden />
                  {t('compliance.domainTitle')}
                </CardTitle>
                <CardDescription>{t('compliance.domainDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3.5">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                  <div>
                    <Label htmlFor="compliance-domain">{t('compliance.domain')}</Label>
                    <Input
                      id="compliance-domain"
                      className="mt-1.5"
                      value={domain}
                      onChange={(event) => setDomain(event.target.value)}
                      placeholder="example.com"
                    />
                  </div>
                  <div>
                    <Label htmlFor="compliance-selector">{t('compliance.selector')}</Label>
                    <Input
                      id="compliance-selector"
                      className="mt-1.5 w-28"
                      value={selector}
                      onChange={(event) => setSelector(event.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    loading={checking}
                    disabled={!domain.trim()}
                    onClick={() => void checkDns()}
                  >
                    {t('compliance.check')}
                  </Button>
                </div>
                {domainHealth ? (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between rounded-lg border border-border/80 bg-surface px-3 py-2 text-xs">
                      <span className="font-semibold text-foreground">{domainHealth.domain}</span>
                      <StatusBadge
                        status={
                          domainHealth.overall === 'ok'
                            ? 'ok'
                            : domainHealth.overall === 'error'
                              ? 'error'
                              : 'warning'
                        }
                      />
                    </div>
                    {(
                      [
                        ['spf', t('compliance.spf')],
                        ['dkim', t('compliance.dkim')],
                        ['dmarc', t('compliance.dmarc')],
                      ] as const
                    ).map(([key, label]) => {
                      const item = domainHealth[key];
                      return (
                        <div key={key} className="rounded-xl border border-border/80 bg-surface/50 p-3 text-xs">
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-foreground">{label}</span>
                            <StatusBadge status={item.status} />
                          </div>
                          <p className="mt-1 text-muted-foreground">{item.message}</p>
                          {item.records.length ? (
                            <code className="mt-1.5 block break-all rounded-md border border-border/60 bg-card px-2 py-1.5 text-[10.5px]">
                              {item.records.join('\n')}
                            </code>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="callout-sage">
                    仅展示真实 DNS 检测结果，不会将未检测状态标记为通过。点击「{t('compliance.check')}」立即验证。
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {showRules ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4 text-foreground" aria-hidden />
              {t('compliance.warmupTitle')}
            </CardTitle>
            <CardDescription>{t('compliance.warmupDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {settings ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/40 p-3 text-sm sm:col-span-2 lg:col-span-1">
                  <span>{t('compliance.warmupEnabled')}</span>
                  <Switch
                    checked={settings.warmupEnabled}
                    onCheckedChange={(checked) => setSettings({ ...settings, warmupEnabled: checked })}
                    aria-label={t('compliance.warmupEnabled')}
                  />
                </label>
                <div>
                  <Label htmlFor="warmup-start">{t('compliance.warmupStart')}</Label>
                  <Input
                    id="warmup-start"
                    type="number"
                    min={1}
                    className="mt-1.5"
                    value={settings.warmupStartLimit}
                    onChange={(event) => setSettings({ ...settings, warmupStartLimit: Number(event.target.value) })}
                  />
                </div>
                <div>
                  <Label htmlFor="warmup-increment">{t('compliance.warmupIncrement')}</Label>
                  <Input
                    id="warmup-increment"
                    type="number"
                    min={1}
                    className="mt-1.5"
                    value={settings.warmupDailyIncrement}
                    onChange={(event) =>
                      setSettings({ ...settings, warmupDailyIncrement: Number(event.target.value) })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="warmup-max">{t('compliance.warmupMax')}</Label>
                  <Input
                    id="warmup-max"
                    type="number"
                    min={1}
                    className="mt-1.5"
                    value={settings.warmupMaxLimit}
                    onChange={(event) => setSettings({ ...settings, warmupMaxLimit: Number(event.target.value) })}
                  />
                </div>
                <div>
                  <Label htmlFor="project-daily-limit">{t('compliance.dailyLimit')}</Label>
                  <Input
                    id="project-daily-limit"
                    type="number"
                    min={1}
                    className="mt-1.5"
                    value={settings.dailySendLimit}
                    onChange={(event) => setSettings({ ...settings, dailySendLimit: Number(event.target.value) })}
                  />
                </div>
                <label className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/40 p-3 text-sm sm:col-span-2">
                  <span>
                    <span className="block font-medium">{t('compliance.trackingEnabled')}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t('compliance.trackingDesc')}
                    </span>
                  </span>
                  <Switch
                    checked={settings.trackingEnabled}
                    onCheckedChange={(checked) => setSettings({ ...settings, trackingEnabled: checked })}
                    aria-label={t('compliance.trackingEnabled')}
                  />
                </label>
                <div className="flex items-end lg:col-span-5">
                  <Button type="button" size="sm" loading={settingsSaving} onClick={() => void saveSettings()}>
                    {t('common.save')}
                  </Button>
                </div>
                {settings.trackingEnabled ? (
                  <p className="text-xs text-muted-foreground lg:col-span-5">{t('compliance.trackingNotice')}</p>
                ) : null}
                {overview ? (
                  <p className="text-xs text-muted-foreground lg:col-span-5">
                    {t('compliance.currentCap')}:{' '}
                    <strong className="font-semibold tabular-nums text-foreground">
                      {overview.effectiveDailyLimit}
                    </strong>
                  </p>
                ) : null}
              </div>
            ) : loadError ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                <span>{loadError}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
                  重试
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(next) => {
          if (!next) setRemoveTarget(null);
        }}
        title="确认移出不再发送名单？"
        description={
          removeTarget
            ? `移出 ${removeTarget.email} 后，系统将不再自动拦截向该邮箱发信。请确认对方已同意重新接收邮件。`
            : ''
        }
        confirmText="确认移出"
        variant="destructive"
        onConfirm={confirmRemove}
      />

      <Dialog open={addOpen} onOpenChange={(next) => !addSaving && setAddOpen(next)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('compliance.addSuppression')}</DialogTitle>
            <DialogDescription>{t('compliance.suppressionDesc')}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div>
              <Label htmlFor="suppression-email">{t('compliance.email')}</Label>
              <Input
                id="suppression-email"
                type="email"
                className="mt-1.5"
                value={addForm.email}
                onChange={(event) => setAddForm({ ...addForm, email: event.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="suppression-reason">{t('compliance.reason')}</Label>
              <select
                id="suppression-reason"
                className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm"
                value={addForm.reason}
                onChange={(event) => setAddForm({ ...addForm, reason: event.target.value as SuppressionReason })}
              >
                {Object.entries(REASON_KEYS).map(([value, key]) => (
                  <option key={value} value={value}>
                    {t(key)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="suppression-note">{t('compliance.note')}</Label>
              <Input
                id="suppression-note"
                className="mt-1.5"
                value={addForm.note}
                onChange={(event) => setAddForm({ ...addForm, note: event.target.value })}
              />
            </div>
            {isAdmin ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={addForm.global}
                  onChange={(event) => setAddForm({ ...addForm, global: event.target.checked })}
                />
                {t('compliance.globalScope')}
              </label>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAddOpen(false)} disabled={addSaving}>
              {t('common.cancel')}
            </Button>
            <Button type="button" loading={addSaving} disabled={!addForm.email.trim()} onClick={() => void addSuppression()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
