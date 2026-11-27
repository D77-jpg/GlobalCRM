/**
 * 登录页 — Gallery White & Charcoal 现代商务双栏架构
 * ------------------------------------------------------------------
 * 微暖画廊白与深炭黑极简分栏：左侧建筑感网格画布与真实核心工作流概览，
 * 右侧纯净高对比度认证工作区。100% 保留密码登录、记住用户名、邮箱 OTP 两步验证、
 * 忘记密码弹窗、语言/深浅色切换及公开合规入口。
 */
import * as React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Layers,
  LockKeyhole,
  Mail,
  MailCheck,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label, FieldMessage } from '@/components/ui/label';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { LanguageToggle } from '@/components/layout/language-toggle';
import { useI18n } from '@/i18n';
import { ForgotPasswordDialog } from '@/components/auth/forgot-password-dialog';
import { loginSchema, type LoginFormValues } from '@/lib/validators';
import { useAuthStore } from '@/store/auth.store';
import { selectDeploymentFeatures, useMetaStore } from '@/store/meta.store';
import { usePageTitle } from '@/hooks/use-ui';
import { ROUTES } from '@/constants';
import { PRODUCT_NAME_UPPER, PRODUCT_TAGLINE_EN } from '@/constants/brand';
import { readStorage, writeStorage } from '@/lib/utils';

const REMEMBER_KEY = 'cdlm-remembered-username';

function LoginMark(): React.JSX.Element {
  return (
    <span className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
      <svg viewBox="0 0 28 28" fill="none" className="h-4.5 w-4.5" aria-hidden>
        <path
          d="M14 5a9 9 0 1 0 9 9h-7.2"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="14" cy="14" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}

function BrandLockup(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 text-foreground">
      <LoginMark />
      <div className="min-w-0">
        <p className="text-[14px] font-bold leading-4 tracking-[0.04em]">{PRODUCT_NAME_UPPER}</p>
        <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{PRODUCT_TAGLINE_EN}</p>
      </div>
    </div>
  );
}

const CAPABILITY_ROWS_ZH = [
  {
    code: '01',
    title: '客户发现与海关贸易情报',
    desc: '多维检索目标市场采购商，AI 评估匹配度并沉淀项目独立线索池',
    tag: '三栏研究工作台',
  },
  {
    code: '02',
    title: '三栏邮件中心与全渠道副驾驶',
    desc: '联动项目知识库与对外口径红线，一键起草多版专业商务回复',
    tag: '口径实时核验',
  },
  {
    code: '03',
    title: '阶梯核价、RFQ 与自动开发流水线',
    desc: '衔接产品规格阶梯价、非标核价审批及 0 / 3 / 7 天多轮跟进节奏',
    tag: '人工审核护栏',
  },
];

const CAPABILITY_ROWS_EN = [
  {
    code: '01',
    title: 'Prospect Discovery & Trade Intelligence',
    desc: 'Identify global buyers with customs records and AI match scoring in an isolated pool.',
    tag: '3-Pane Research',
  },
  {
    code: '02',
    title: 'Omnichannel & Mail AI Copilot',
    desc: 'Draft multi-version replies grounded in approved project knowledge and policy guardrails.',
    tag: 'Guardrail Verified',
  },
  {
    code: '03',
    title: 'Tiered Quotations, RFQ & Auto-Outreach',
    desc: 'Connect SKU price tiers, custom RFQ approvals, and 0/3/7-day multi-touch sequences.',
    tag: 'Human-in-the-Loop',
  },
];

export function LoginPage(): React.JSX.Element {
  const { t, language } = useI18n();
  usePageTitle(t('auth.login'));
  const navigate = useNavigate();
  const location = useLocation();

  const login = useAuthStore((state) => state.login);
  const loggingIn = useAuthStore((state) => state.loggingIn);
  const loginError = useAuthStore((state) => state.loginError);
  const twoFactorChallenge = useAuthStore((state) => state.twoFactorChallenge);
  const verifyingTwoFactor = useAuthStore((state) => state.verifyingTwoFactor);
  const twoFactorError = useAuthStore((state) => state.twoFactorError);
  const verifyTwoFactor = useAuthStore((state) => state.verifyTwoFactor);
  const clearTwoFactor = useAuthStore((state) => state.clearTwoFactor);
  const status = useAuthStore((state) => state.status);
  const fetchMeta = useMetaStore((state) => state.fetchMeta);
  const features = useMetaStore(selectDeploymentFeatures);

  React.useEffect(() => {
    void fetchMeta();
  }, [fetchMeta]);

  const [showPassword, setShowPassword] = React.useState(false);
  const [otp, setOtp] = React.useState('');
  const [otpError, setOtpError] = React.useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = React.useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: readStorage<string>(REMEMBER_KEY, ''),
      password: '',
      remember: Boolean(readStorage<string>(REMEMBER_KEY, '')),
    },
    mode: 'onBlur',
  });

  const from = React.useMemo(() => {
    const state = location.state as { from?: string } | null;
    return state?.from ?? ROUTES.dashboard;
  }, [location.state]);

  React.useEffect(() => {
    if (status === 'authenticated') navigate(from, { replace: true });
  }, [status, navigate, from]);

  const onSubmit = React.useCallback(
    async (values: LoginFormValues) => {
      clearErrors();
      setOtpError(null);
      const result = await login(values.username, values.password);
      if (result === 'failed') {
        setError('password', { message: '用户名或密码不正确' });
        return;
      }

      if (values.remember) writeStorage(REMEMBER_KEY, values.username);
      else writeStorage(REMEMBER_KEY, '');

      if (result === 'twoFactor') {
        setOtp('');
        toast.info('验证码已发送', { description: '请查看账号绑定邮箱中的 6 位验证码' });
        return;
      }

      await fetchMeta({ force: true });
      toast.success('登录成功', { description: '欢迎回来' });
      navigate(from, { replace: true });
    },
    [login, setError, clearErrors, fetchMeta, navigate, from],
  );

  const onVerify = React.useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (otp.length !== 6) {
        setOtpError('请输入 6 位数字验证码');
        return;
      }
      setOtpError(null);
      const ok = await verifyTwoFactor(otp);
      if (!ok) return;
      await fetchMeta({ force: true });
      toast.success('登录成功', { description: '双重验证已通过' });
      navigate(from, { replace: true });
    },
    [otp, verifyTwoFactor, fetchMeta, navigate, from],
  );

  const handleBackToPassword = (): void => {
    setOtp('');
    setOtpError(null);
    clearTwoFactor();
  };

  const remember = watch('remember');
  const capabilityRows = language === 'zh' ? CAPABILITY_ROWS_ZH : CAPABILITY_ROWS_EN;

  return (
    <div className="login-page grid min-h-screen w-full grid-cols-1 bg-background text-foreground lg:grid-cols-[1.08fr_0.92fr]">
      {/* Left Architectural Gallery Showcase */}
      <section
        aria-label="产品介绍"
        className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-sidebar p-10 xl:p-14 lg:flex"
      >
        {/* Subtle 28px architectural grid hairline pattern */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.38] dark:opacity-[0.18]"
          style={{
            backgroundImage:
              'linear-gradient(to right, hsl(var(--border)) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border)) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
            maskImage: 'radial-gradient(ellipse 85% 80% at 35% 45%, #000 35%, transparent 100%)',
            WebkitMaskImage: 'radial-gradient(ellipse 85% 80% at 35% 45%, #000 35%, transparent 100%)',
          }}
        />

        <div className="relative z-10">
          <BrandLockup />
        </div>

        <div className="relative z-10 my-auto max-w-[580px] py-8">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-mono text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground shadow-sm">
            <Sparkles className="h-3 w-3 text-foreground" aria-hidden />
            AI-NATIVE B2B TRADE WORKSPACE
          </span>

          <h1 className="mt-5 text-[clamp(2.15rem,3vw,3rem)] font-semibold leading-[1.14] tracking-[-0.035em] text-foreground">
            {language === 'zh' ? (
              <>
                面向现代外贸团队的
                <br />
                <span className="text-muted-foreground">智能客户与成交工作台。</span>
              </>
            ) : (
              <>
                The intelligent workspace
                <br />
                <span className="text-muted-foreground">for global B2B trade.</span>
              </>
            )}
          </h1>

          <p className="mt-4 max-w-[500px] text-[14px] leading-relaxed text-muted-foreground">
            {language === 'zh'
              ? '将客户发现、三栏邮件与全渠道沟通、阶梯核价及多轮自动开发收敛于同一套高密度工作空间。各品牌项目上下文严格隔离，每一封对外沟通均可核验。'
              : 'Unify prospect research, 3-pane mail & omnichannel copilot, tiered quotations, and multi-touch outreach inside a strictly isolated multi-brand workspace.'}
          </p>

          {/* Architectural Capability Preview Frame */}
          <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card shadow-card">
            <div className="flex items-center justify-between border-b border-border bg-surface/80 px-4 py-2.5">
              <div className="flex items-center gap-1.5" aria-hidden>
                <span className="h-2 w-2 rounded-full bg-border" />
                <span className="h-2 w-2 rounded-full bg-border" />
                <span className="h-2 w-2 rounded-full bg-border" />
              </div>
              <span className="font-mono text-[10.5px] text-muted-foreground">
                GLOBALCRM · WORKSPACE ARCHITECTURE
              </span>
              <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-foreground">
                <Layers className="h-3 w-3" aria-hidden />
                {language === 'zh' ? '项目隔离' : 'Isolated'}
              </span>
            </div>

            <div className="divide-y divide-border">
              {capabilityRows.map((row) => (
                <div key={row.code} className="flex items-start justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-surface/50">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-muted-foreground">
                      {row.code}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold leading-snug text-foreground">{row.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{row.desc}</p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-md border border-border bg-surface px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                    {row.tag}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="relative z-10 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-foreground" aria-hidden />
            {language === 'zh' ? '多项目品牌严格隔离' : 'Multi-project brand isolation'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-foreground" aria-hidden />
            {language === 'zh' ? '对外口径与合规发信护栏' : 'Policy & compliance guardrails'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-foreground" aria-hidden />
            {language === 'zh' ? 'HttpOnly 加密会话与双重验证' : 'HttpOnly session & 2FA'}
          </span>
        </div>
      </section>

      {/* Right Crisp Authentication Column */}
      <main className="flex min-h-screen flex-col justify-between bg-card px-6 py-6 sm:px-10 lg:px-14 lg:py-8">
        <header className="flex items-center justify-between">
          <div className="lg:invisible">
            <BrandLockup />
          </div>
          <div className="flex items-center gap-1.5">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </header>

        <section className="mx-auto my-auto w-full max-w-[380px] py-8" aria-label="登录">
          <div>
            <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {twoFactorChallenge ? 'TWO-FACTOR VERIFICATION' : 'SIGN IN TO WORKSPACE'}
            </p>
            <h2 className="mt-2 text-[1.75rem] font-semibold leading-tight tracking-[-0.032em] text-foreground">
              {twoFactorChallenge ? t('auth.twoFactor') : t('auth.welcome')}
            </h2>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
              {twoFactorChallenge
                ? `${t('auth.twoFactorHint')} · ${twoFactorChallenge.emailHint}`
                : t('auth.subtitle')}
            </p>
          </div>

          {twoFactorChallenge ? (
            <form className="mt-7 space-y-4" noValidate onSubmit={(event) => void onVerify(event)}>
              {twoFactorError || otpError ? (
                <div role="alert" className="flex gap-2.5 rounded-lg border border-rose/25 bg-rose-soft px-3.5 py-2.5 text-xs leading-5 text-rose">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <div>
                    <p className="font-medium">验证失败</p>
                    <p className="mt-0.5 opacity-90">{otpError || twoFactorError}</p>
                  </div>
                </div>
              ) : null}

              <div>
                <Label htmlFor="login-otp">{t('auth.twoFactor')}</Label>
                <div className="relative mt-1.5">
                  <MailCheck className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="login-otp"
                    className="h-11 rounded-lg pl-10 pr-4 text-center font-mono text-lg tracking-[0.42em]"
                    placeholder="000000"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    value={otp}
                    onChange={(event) => {
                      setOtp(event.target.value.replace(/\D/g, '').slice(0, 6));
                      setOtpError(null);
                    }}
                  />
                </div>
                <FieldMessage hint={t('auth.twoFactorHint')} className="pl-0.5" />
              </div>

              <Button
                type="submit"
                className="login-submit h-10 w-full rounded-lg text-sm font-medium"
                loading={verifyingTwoFactor}
                disabled={verifyingTwoFactor || otp.length !== 6}
              >
                {verifyingTwoFactor ? t('common.loading') : (
                  <>
                    {t('auth.verify')}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </>
                )}
              </Button>

              <button
                type="button"
                onClick={handleBackToPassword}
                className="w-full text-center text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
              >
                {t('auth.backLogin')}
              </button>
            </form>
          ) : (
            <form
              className="mt-7 space-y-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void handleSubmit(onSubmit)();
              }}
            >
              {loginError ? (
                <div role="alert" className="flex gap-2.5 rounded-lg border border-rose/25 bg-rose-soft px-3.5 py-2.5 text-xs leading-5 text-rose">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <div>
                    <p className="font-medium">登录失败</p>
                    <p className="mt-0.5 opacity-90">{loginError}</p>
                  </div>
                </div>
              ) : null}

              <div>
                <Label htmlFor="login-username" className="mb-1.5 block text-xs font-medium text-foreground">
                  {t('auth.username')}
                </Label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="login-username"
                    className="h-10 rounded-lg bg-background/60 pl-9 pr-3.5 text-sm"
                    placeholder={t('auth.username')}
                    autoComplete="username"
                    autoFocus
                    invalid={Boolean(errors.username)}
                    {...register('username')}
                  />
                </div>
                <FieldMessage error={errors.username?.message} className="pl-0.5" />
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <Label htmlFor="login-password" className="text-xs font-medium text-foreground">
                    {t('auth.password')}
                  </Label>
                  <button
                    type="button"
                    onClick={() => setForgotOpen(true)}
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                  >
                    {t('auth.forgot')}
                  </button>
                </div>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    className="h-10 rounded-lg bg-background/60 pl-9 pr-10 text-sm"
                    placeholder={t('auth.password')}
                    autoComplete="current-password"
                    invalid={Boolean(errors.password)}
                    {...register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((visible) => !visible)}
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                    aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </button>
                </div>
                <FieldMessage error={errors.password?.message} className="pl-0.5" />
              </div>

              <div className="flex items-center justify-between pt-0.5">
                <label htmlFor="login-remember" className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox
                    id="login-remember"
                    checked={Boolean(remember)}
                    onCheckedChange={(checked) => setValue('remember', checked === true)}
                  />
                  {language === 'zh' ? '记住用户名' : 'Remember username'}
                </label>
              </div>

              <Button
                type="submit"
                className="login-submit mt-1 h-10 w-full rounded-lg text-sm font-medium"
                loading={loggingIn}
                disabled={loggingIn}
              >
                {loggingIn ? t('auth.loggingIn') : (
                  <>
                    {t('auth.login')}
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </>
                )}
              </Button>
            </form>
          )}

          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" aria-hidden />
            <span className="text-[11px] text-muted-foreground">{language === 'zh' ? '或' : 'or'}</span>
            <span className="h-px flex-1 bg-border" aria-hidden />
          </div>

          <button
            type="button"
            onClick={() => toast.info(language === 'zh' ? '请联系系统管理员开通账号' : 'Contact your system administrator to request an account')}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface text-xs font-medium text-foreground transition-colors hover:border-foreground/25 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            {language === 'zh' ? '联系管理员开通账号' : 'Request an account'}
          </button>
        </section>

        <footer className="space-y-2 text-center">
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-foreground/75" aria-hidden />
            {language === 'zh' ? '仅限授权成员使用 · 登录信息加密传输' : 'Authorized personnel only · Encrypted session'}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {features.publicPricing ? (
              <>
                <Link className="hover:text-foreground" to={ROUTES.pricing}>{language === 'zh' ? '价格与套餐' : 'Pricing'}</Link>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <Link className="hover:text-foreground" to={ROUTES.help}>{language === 'zh' ? '帮助中心' : 'Help center'}</Link>
            <span aria-hidden>·</span>
            <Link className="hover:text-foreground" to={`${ROUTES.legal}/terms`}>{language === 'zh' ? '服务条款' : 'Terms'}</Link>
            <span aria-hidden>·</span>
            <Link className="hover:text-foreground" to={`${ROUTES.legal}/privacy`}>{language === 'zh' ? '隐私政策' : 'Privacy'}</Link>
          </div>
        </footer>
      </main>

      <ForgotPasswordDialog open={forgotOpen} onOpenChange={setForgotOpen} />
    </div>
  );
}
