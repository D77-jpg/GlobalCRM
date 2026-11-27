/**
 * 登录页 — Atelier Trade 高端外贸品牌入口
 * ------------------------------------------------------------------
 * 温润象牙白与深森林绿视觉语言，完整保留密码登录、记住用户名、
 * 邮箱两步验证 OTP、忘记密码弹窗、语言/主题切换与公开合规链接。
 */
import * as React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  FileText,
  Factory,
  Handshake,
  Inbox,
  LockKeyhole,
  Mail,
  MailCheck,
  ShieldCheck,
  Truck,
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

const FLOW_STEPS: Array<{
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  en: string;
}> = [
  { icon: Inbox, label: '询盘', en: 'Inquiry' },
  { icon: FileText, label: '报价', en: 'Quotation' },
  { icon: Handshake, label: '订单', en: 'Order' },
  { icon: Factory, label: '生产', en: 'Production' },
  { icon: Truck, label: '出货', en: 'Shipping' },
];

function LoginMark(): React.JSX.Element {
  return (
    <span className="brand-mark flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white">
      <svg viewBox="0 0 28 28" fill="none" className="h-6 w-6" aria-hidden>
        <path
          d="M14 4.5a9.5 9.5 0 1 0 9.5 9.5H15.5"
          stroke="#E8D7A8"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="14" cy="14" r="2.2" fill="currentColor" />
      </svg>
    </span>
  );
}

function BrandLockup(): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 text-foreground">
      <LoginMark />
      <div className="min-w-0">
        <p className="text-[15px] font-bold leading-5 tracking-[0.04em]">{PRODUCT_NAME_UPPER}</p>
        <p className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground">{PRODUCT_TAGLINE_EN}</p>
      </div>
    </div>
  );
}

function FlowStep({
  icon: Icon,
  label,
  en,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  en: string;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col items-center text-center">
      <span className="flex h-[58px] w-[58px] items-center justify-center rounded-2xl border border-primary/15 bg-card/95 text-primary shadow-card backdrop-blur-md">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="mt-2.5 text-[13.5px] font-semibold leading-4 text-foreground">{label}</span>
      <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{en}</span>
    </div>
  );
}

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

  return (
    <div className="login-page relative min-h-screen overflow-hidden bg-background text-foreground">
      <img
        src="/login/export-logistics.jpg"
        alt=""
        className="absolute inset-0 h-full w-full object-cover object-center opacity-25 dark:opacity-15"
      />
      {/* Warm ivory & forest-emerald architectural atmosphere */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_90%_at_12%_18%,hsl(45_28%_96%_/_0.96)_0%,hsl(45_22%_95%_/_0.88)_55%,hsl(148_30%_20%_/_0.12)_100%)] dark:bg-[radial-gradient(70%_90%_at_12%_18%,hsl(150_14%_7%_/_0.95)_0%,hsl(150_12%_8%_/_0.88)_60%,hsl(148_36%_18%_/_0.35)_100%)]" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background/85 to-transparent" />

      <header className="absolute inset-x-0 top-0 z-20">
        <div className="mx-auto flex h-[84px] max-w-[1560px] items-center justify-between px-5 sm:px-8 lg:px-12 xl:px-20">
          <BrandLockup />
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto grid min-h-screen w-full max-w-[1560px] grid-cols-1 items-center gap-10 px-5 pb-12 pt-28 sm:px-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-14 lg:px-12 lg:pb-16 lg:pt-24 xl:grid-cols-[minmax(0,1fr)_496px] xl:px-20">
        <section className="hidden min-w-0 lg:block" aria-label="产品介绍">
          <div className="max-w-[700px]">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary-soft/80 px-3 py-1 text-[11px] font-semibold tracking-[0.18em] text-primary">
              FROM INQUIRY TO GLOBAL GROWTH
            </span>
            <h1 className="mt-6 text-[clamp(2.85rem,4.1vw,4.35rem)] font-semibold leading-[1.04] tracking-[-0.045em] text-foreground">
              Simplify
              <br />
              Your Export Business.
              <br />
              <span className="text-primary">All in One CRM.</span>
            </h1>
            <p className="mt-6 max-w-[560px] text-[15px] leading-7 text-muted-foreground">
              {language === 'zh'
                ? '从客户发现、智能开发、邮件与全渠道沟通，到精准报价与订单交付——在高度隔离的多品牌外贸工作台中，以 AI 副驾驶驱动每一次专业成交。'
                : 'From prospecting and automated outreach to omnichannel communication, quotations, and fulfillment — orchestrate every global trade milestone in one project-isolated workspace.'}
            </p>

            <div className="mt-10 flex max-w-[640px] items-start justify-between gap-2 xl:mt-12">
              {FLOW_STEPS.map((step, index) => (
                <React.Fragment key={step.en}>
                  <FlowStep {...step} />
                  {index < FLOW_STEPS.length - 1 ? (
                    <ArrowRight className="mt-5 h-4 w-4 shrink-0 text-primary/45" aria-hidden />
                  ) : null}
                </React.Fragment>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[31rem] lg:mx-0 lg:justify-self-end" aria-label="登录">
          <div className="rounded-[1.5rem] border border-border bg-card/95 p-6 text-card-foreground shadow-[0_28px_72px_-32px_hsl(150_24%_12%_/_0.22),0_2px_10px_hsl(150_20%_12%_/_0.05)] backdrop-blur-xl sm:p-9">
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.2em] text-primary">
                {twoFactorChallenge ? 'TWO-FACTOR VERIFICATION' : 'WELCOME BACK'}
              </p>
              <h2 className="mt-2 text-[2rem] font-semibold leading-tight tracking-[-0.035em] text-foreground">
                {twoFactorChallenge ? t('auth.twoFactor') : t('auth.welcome')}
              </h2>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {twoFactorChallenge
                  ? `${t('auth.twoFactorHint')} · ${twoFactorChallenge.emailHint}`
                  : t('auth.subtitle')}
              </p>
            </div>

            {twoFactorChallenge ? (
              <form className="mt-7 space-y-5" noValidate onSubmit={(event) => void onVerify(event)}>
                {twoFactorError || otpError ? (
                  <div role="alert" className="flex gap-2.5 rounded-xl border border-rose/25 bg-rose-soft px-3.5 py-3 text-sm leading-5 text-rose">
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
                    <MailCheck className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="login-otp"
                      className="h-[50px] rounded-xl pl-12 pr-4 text-center text-[20px] tracking-[0.45em]"
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
                  <FieldMessage hint={t('auth.twoFactorHint')} className="pl-1" />
                </div>

                <Button type="submit" className="login-submit h-[50px] w-full rounded-xl text-[15px] font-semibold" size="lg" loading={verifyingTwoFactor} disabled={verifyingTwoFactor || otp.length !== 6}>
                  {verifyingTwoFactor ? t('common.loading') : (
                    <>
                      {t('auth.verify')}
                      <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
                    </>
                  )}
                </Button>

                <button
                  type="button"
                  onClick={handleBackToPassword}
                  className="w-full text-center text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
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
                  <div role="alert" className="flex gap-2.5 rounded-xl border border-rose/25 bg-rose-soft px-3.5 py-3 text-sm leading-5 text-rose">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    <div>
                      <p className="font-medium">登录失败</p>
                      <p className="mt-0.5 opacity-90">{loginError}</p>
                    </div>
                  </div>
                ) : null}

                <div>
                  <Label htmlFor="login-username" className="sr-only">
                    {t('auth.username')}
                  </Label>
                  <div className="relative">
                    <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="login-username"
                      className="h-[48px] rounded-xl pl-11 pr-4 text-[14.5px]"
                      placeholder={t('auth.username')}
                      autoComplete="username"
                      autoFocus
                      invalid={Boolean(errors.username)}
                      {...register('username')}
                    />
                  </div>
                  <FieldMessage error={errors.username?.message} className="pl-1" />
                </div>

                <div>
                  <Label htmlFor="login-password" className="sr-only">
                    {t('auth.password')}
                  </Label>
                  <div className="relative">
                    <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      className="h-[48px] rounded-xl pl-11 pr-11 text-[14.5px]"
                      placeholder={t('auth.password')}
                      autoComplete="current-password"
                      invalid={Boolean(errors.password)}
                      {...register('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    >
                      {showPassword ? <EyeOff className="h-[18px] w-[18px]" aria-hidden /> : <Eye className="h-[18px] w-[18px]" aria-hidden />}
                    </button>
                  </div>
                  <FieldMessage error={errors.password?.message} className="pl-1" />
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <label htmlFor="login-remember" className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground">
                    <Checkbox
                      id="login-remember"
                      checked={Boolean(remember)}
                      onCheckedChange={(checked) => setValue('remember', checked === true)}
                    />
                    {language === 'zh' ? '记住用户名' : 'Remember username'}
                  </label>
                  <button
                    type="button"
                    onClick={() => setForgotOpen(true)}
                    className="text-[13px] font-medium text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                  >
                    {t('auth.forgot')}
                  </button>
                </div>

                <Button type="submit" className="login-submit mt-2 h-[50px] w-full rounded-xl text-[15px] font-semibold" size="lg" loading={loggingIn} disabled={loggingIn}>
                  {loggingIn ? t('auth.loggingIn') : (
                    <>
                      {t('auth.login')}
                      <ArrowRight className="h-[18px] w-[18px]" aria-hidden />
                    </>
                  )}
                </Button>
              </form>
            )}

            <div className="my-6 flex items-center gap-3">
              <span className="h-px flex-1 bg-border" aria-hidden />
              <span className="text-[11px] text-muted-foreground">{language === 'zh' ? '或' : 'or'}</span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>

            <button
              type="button"
              onClick={() => toast.info(language === 'zh' ? '请联系系统管理员开通账号' : 'Contact your system administrator to request an account')}
              className="flex h-[46px] w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface text-[13.5px] font-medium text-foreground transition-colors hover:border-primary/35 hover:bg-primary-soft/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <Mail className="h-4 w-4 text-primary" aria-hidden />
              {language === 'zh' ? '联系管理员开通账号' : 'Request an account'}
            </button>

            <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-[11px] leading-5 text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden />
              仅限授权成员使用 · 登录信息加密传输
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
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
          </div>
        </section>
      </main>

      <ForgotPasswordDialog open={forgotOpen} onOpenChange={setForgotOpen} />
    </div>
  );
}
