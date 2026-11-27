import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Circle, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { usePageTitle } from '@/hooks/use-ui';
import { useProjectStore } from '@/store/project.store';
import { selectCanManageProjects, useAuthStore } from '@/store/auth.store';
import { apiGet, apiPost, toErrorMessage } from '@/lib/api';
import { useI18n, type TranslationKey } from '@/i18n';

interface OnboardingStep {
  key: 'brand' | 'products' | 'playbook' | 'mailbox' | 'team' | 'ai';
  done: boolean;
  href: string;
  optional?: boolean;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
}
interface OnboardingStatus {
  projectId: string;
  projectName: string;
  completedAt?: string;
  ready: boolean;
  completed: boolean;
  steps: OnboardingStep[];
  doneCount: number;
  totalCount: number;
}

const STEP_TITLE_KEY: Record<OnboardingStep['key'], TranslationKey> = {
  brand: 'onboarding.step.brand',
  products: 'onboarding.step.products',
  playbook: 'onboarding.step.playbook',
  mailbox: 'onboarding.step.mailbox',
  team: 'onboarding.step.team',
  ai: 'onboarding.step.ai',
};
const STEP_DESC_KEY: Record<OnboardingStep['key'], TranslationKey> = {
  brand: 'onboarding.step.brandDesc',
  products: 'onboarding.step.productsDesc',
  playbook: 'onboarding.step.playbookDesc',
  mailbox: 'onboarding.step.mailboxDesc',
  team: 'onboarding.step.teamDesc',
  ai: 'onboarding.step.aiDesc',
};

export function OnboardingPage(): React.JSX.Element {
  const { t, language } = useI18n();
  usePageTitle(t('onboarding.title'));
  const navigate = useNavigate();
  const activeProject = useProjectStore((state) => state.activeProject);
  const canManage = useAuthStore(selectCanManageProjects);
  const [status, setStatus] = React.useState<OnboardingStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [completing, setCompleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await apiGet<OnboardingStatus>('/projects/onboarding'));
    } catch (error) {
      toast.error(t('errors.generic'), { description: toErrorMessage(error) });
    } finally { setLoading(false); }
  }, [t]);

  React.useEffect(() => { void load(); }, [load, activeProject?.id]);

  const complete = async () => {
    setCompleting(true);
    try {
      setStatus(await apiPost<OnboardingStatus>('/projects/onboarding/complete'));
      toast.success(t('onboarding.completed'));
    } catch (error) {
      toast.error(t('errors.generic'), { description: toErrorMessage(error) });
    } finally { setCompleting(false); }
  };

  if (loading || !status) {
    return <div className="workspace-page"><PageHeader title={t('onboarding.title')} description={t('onboarding.subtitle')} />
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('common.loading')}</div></div>;
  }

  return (
    <div className="workspace-page">
      <PageHeader title={t('onboarding.title')} description={t('onboarding.subtitle')}
        actions={status.completed ? undefined : (
          <Button size="sm" loading={completing} disabled={!canManage || !status.ready} onClick={() => void complete()}>
            <Check className="h-4 w-4" aria-hidden />{completing ? t('onboarding.completing') : t('onboarding.complete')}
          </Button>
        )} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_21rem] xl:items-start">
        <Card className="overflow-hidden">
          <CardHeader className="hero-wash border-b border-border/80 pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-primary" aria-hidden />
                {status.projectName} · 初始化清单
              </CardTitle>
              <span className="chip chip-mint font-semibold tabular-nums">
                {status.doneCount} / {status.totalCount}
              </span>
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <span className="text-3xl font-bold tabular-nums tracking-[-0.03em] text-foreground">
                {status.doneCount} <span className="text-lg font-medium text-muted-foreground">/ {status.totalCount}</span>
              </span>
              <span className="text-xs text-muted-foreground">{t('onboarding.progress', { done: status.doneCount, total: status.totalCount })}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={status.totalCount} aria-valuenow={status.doneCount}>
              <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${status.totalCount ? (status.doneCount / status.totalCount) * 100 : 0}%` }} />
            </div>
            {status.completed ? (
              <p className="mt-2.5 text-xs font-medium text-primary">
                {t('onboarding.completed')}{status.completedAt ? ` · ${t('onboarding.completedAt', { date: new Date(status.completedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US') })}` : ''}
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2.5 pt-4">
            {status.steps.map((step, index) => {
              const title = t(STEP_TITLE_KEY[step.key]) || step.title[language];
              const description = t(STEP_DESC_KEY[step.key]) || step.description[language];
              return (
                <div key={step.key} className="flex flex-col gap-3 rounded-xl border border-border/85 bg-surface/50 p-3.5 transition-colors hover:border-primary/30 sm:flex-row sm:items-center">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold ${step.done ? 'bg-primary-soft text-primary' : 'bg-muted text-muted-foreground'}`}>
                    {step.done ? <Check className="h-4 w-4" aria-hidden /> : index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-[0.875rem] font-semibold text-foreground">
                      {title}
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${step.optional ? 'bg-muted text-muted-foreground' : 'bg-primary-soft text-primary'}`}>
                        {step.optional ? t('onboarding.optional') : t('onboarding.required')}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`chip ${step.done ? 'chip-mint' : 'chip-muted'}`}>
                      {step.done ? <Check className="h-3 w-3" aria-hidden /> : <Circle className="h-3 w-3" aria-hidden />}
                      {step.done ? t('common.done') : t('common.pending')}
                    </span>
                    {!step.done ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => navigate(step.href)}>
                        {t('onboarding.go')}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {!status.completed && !status.ready ? <p className="pt-1 text-xs text-muted-foreground">{t('onboarding.notReady')}</p> : null}
            {!canManage ? <p className="pt-1 text-xs text-muted-foreground">{t('errors.forbidden')}</p> : null}
          </CardContent>
        </Card>

        <Card className="p-5">
          <h2 className="section-title">{status.ready ? '准备就绪' : '初始化指引'}</h2>
          <div className="callout-sage mt-3">
            {status.ready
              ? '所有必填配置均已完成，请在正式发送前确认邮箱与发送规则。'
              : '依次完成左侧必填项后，即可启用当前项目的完整外贸开发与 AI 工作流。'}
          </div>
          <div className="mt-4 space-y-2">
            {[
              { title: '进入今日工作', desc: '查看待办任务、跟进客户与业务动态', to: '/' },
              { title: '项目知识库', desc: '管理公司介绍、产品资料与对外口径', to: '/knowledge' },
              { title: '发送合规设置', desc: '核对每日额度、域名认证与退订名单', to: '/mail-compliance' },
            ].map((link) => (
              <button
                key={link.to}
                type="button"
                onClick={() => navigate(link.to)}
                className="flex w-full items-center justify-between gap-2 rounded-xl border border-border/80 bg-surface/60 p-3 text-left transition-colors hover:border-primary/35 hover:bg-primary-soft/35"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">{link.title}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{link.desc}</p>
                </div>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
              </button>
            ))}
          </div>
          <Button type="button" className="mt-4 w-full" onClick={() => navigate('/')}>
            进入工作空间 <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </Card>
      </div>
    </div>
  );
}
