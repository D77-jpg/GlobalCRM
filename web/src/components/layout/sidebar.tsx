/**
 * 左侧导航栏 — Atelier Trade 三段式工作空间架构
 * ------------------------------------------------------------------
 * 顶部品牌标识 + 独立工作空间项目切换卡 + 三组语义导航（工作空间 / 业务资源 / 系统管理）
 * + 底部成员信息卡。完整保留全部角色权限、部署模式与项目隔离机制。
 */
import * as React from 'react';
import { Link, NavLink } from 'react-router-dom';
import {
  Activity,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronsUpDown,
  CreditCard,
  FileText,
  FolderKanban,
  Globe2,
  KeyRound,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Package,
  ReceiptText,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { ROUTES, USER_ROLE_LABEL } from '@/constants';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from '@/constants/brand';
import { selectDeploymentFeatures, useMetaStore } from '@/store/meta.store';
import { selectCanManageProjects, selectIsAdmin, selectIsPlatformAdmin, useAuthStore } from '@/store/auth.store';
import { cn } from '@/lib/utils';
import { initials } from '@/lib/format';
import { useProjectStore } from '@/store/project.store';
import { ProjectLogo, projectLogoSrc } from '@/components/projects/project-logo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n, type TranslationKey } from '@/i18n';

export type NavGroupKey = 'workspace' | 'resources' | 'manage';

export interface NavItem {
  to: string;
  labelKey: TranslationKey;
  group: NavGroupKey;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  adminOnly?: boolean;
  managerOnly?: boolean;
  platformOnly?: boolean;
  featureFlag?: 'billing' | 'multiOrg';
}

export const NAV_ITEMS: NavItem[] = [
  // 工作空间 · 核心外贸销售主链路
  { to: ROUTES.dashboard, labelKey: 'nav.dashboard', group: 'workspace', icon: LayoutDashboard, end: true },
  { to: ROUTES.prospecting, labelKey: 'nav.prospecting', group: 'workspace', icon: Target, end: false },
  { to: ROUTES.customers, labelKey: 'nav.customers', group: 'workspace', icon: Users, end: false },
  { to: ROUTES.customs, labelKey: 'nav.tradeIntelligence', group: 'workspace', icon: Globe2, end: false },
  { to: '/mail', labelKey: 'nav.mail', group: 'workspace', icon: Mail, end: false },
  { to: ROUTES.channels, labelKey: 'nav.channels', group: 'workspace', icon: MessageSquare, end: false },
  { to: ROUTES.quotations, labelKey: 'nav.quotations', group: 'workspace', icon: ReceiptText, end: false },
  { to: ROUTES.outreachAutomation, labelKey: 'nav.outreach', group: 'workspace', icon: Bot, end: false },
  { to: ROUTES.letters, labelKey: 'nav.letters', group: 'workspace', icon: Send, end: false },

  // 业务资源 · 知识、产品、模板与项目空间
  { to: '/knowledge', labelKey: 'nav.knowledge', group: 'resources', icon: BookOpen, end: false },
  { to: ROUTES.products, labelKey: 'nav.products', group: 'resources', icon: Package, end: false },
  { to: ROUTES.templates, labelKey: 'nav.templates', group: 'resources', icon: FileText, end: false },
  { to: ROUTES.projects, labelKey: 'nav.projects', group: 'resources', icon: FolderKanban, end: true, managerOnly: true },

  // 系统管理 · 引导、团队、集成、合规与 AI 治理
  { to: ROUTES.onboarding, labelKey: 'nav.onboarding', group: 'manage', icon: Sparkles, end: false, managerOnly: true },
  { to: ROUTES.users, labelKey: 'nav.users', group: 'manage', icon: UserCog, end: false, adminOnly: true },
  { to: '/projects/integrations', labelKey: 'integrations.title', group: 'manage', icon: KeyRound, end: true, managerOnly: true },
  { to: ROUTES.mailCompliance, labelKey: 'nav.compliance', group: 'manage', icon: ShieldCheck, end: false, managerOnly: true },
  { to: ROUTES.agentDiagnostics, labelKey: 'nav.agentDiagnostics', group: 'manage', icon: Activity, end: false, adminOnly: true },
  { to: ROUTES.aiSettings, labelKey: 'nav.aiSettings', group: 'manage', icon: Settings2, end: false, adminOnly: true },
  { to: ROUTES.organization, labelKey: 'nav.organization', group: 'manage', icon: Building2, end: false, managerOnly: true },
  { to: ROUTES.billing, labelKey: 'nav.billing', group: 'manage', icon: CreditCard, end: false, adminOnly: true, featureFlag: 'billing' },
  { to: ROUTES.oauthApplications, labelKey: 'oauth.title', group: 'manage', icon: ShieldCheck, end: false },
  { to: ROUTES.oauthClients, labelKey: 'oauth.clients', group: 'manage', icon: KeyRound, end: false, platformOnly: true, featureFlag: 'multiOrg' },
  { to: ROUTES.platform, labelKey: 'nav.platform', group: 'manage', icon: Globe2, end: false, platformOnly: true, featureFlag: 'multiOrg' },
];

interface SidebarProps {
  collapsed: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
}

function BrandMark(): React.JSX.Element {
  return (
    <span className="brand-mark flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
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

function Brand({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const fallbackCompanyName = useMetaStore((state) => state.meta?.company?.name);
  const project = useProjectStore((state) => state.activeProject);
  const subtitle = project?.companyName || fallbackCompanyName || PRODUCT_TAGLINE;
  const hasLogo = Boolean(project && projectLogoSrc(project));

  return (
    <div className={cn('flex h-14 shrink-0 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
      <Link
        to={ROUTES.dashboard}
        className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        aria-label={t('nav.backDashboard')}
      >
        {project && hasLogo ? (
          <ProjectLogo
            project={project}
            size={collapsed ? 'sm' : 'md'}
            compact={collapsed}
            className={collapsed ? undefined : 'dark:[&_img]:invert dark:[&_img]:hue-rotate-180'}
          />
        ) : (
          <BrandMark />
        )}
        {!collapsed && !hasLogo ? (
          <span className="min-w-0">
            <span className="block truncate text-[0.9375rem] font-bold leading-tight tracking-[-0.02em] text-foreground">
              {PRODUCT_NAME}
            </span>
            <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-muted-foreground" title={subtitle}>
              {subtitle}
            </span>
          </span>
        ) : null}
      </Link>
    </div>
  );
}

/** 顶部项目工作空间切换卡（对应设计稿左上角独立白卡，保留完整多项目隔离与切换） */
function SidebarWorkspaceCard({ collapsed }: { collapsed: boolean }): React.JSX.Element | null {
  const { t, language } = useI18n();
  const items = useProjectStore((state) => state.items).filter((item) => item.status === 'active');
  const active = useProjectStore((state) => state.activeProject);
  const switchProject = useProjectStore((state) => state.switchProject);

  if (!active) return null;

  return (
    <div className={cn('shrink-0 px-3 pb-2', collapsed && 'px-2')}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={collapsed ? `${t('nav.currentProject')}: ${active.name}` : undefined}
            aria-label={`切换项目，当前为 ${active.name}`}
            className={cn(
              'group flex w-full items-center gap-2.5 rounded-lg border border-border bg-card text-left shadow-[0_1px_2px_hsl(40_10%_8%_/_0.03)] transition-[border-color,box-shadow] hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35',
              collapsed ? 'justify-center p-1.5' : 'px-2.5 py-2',
            )}
          >
            {collapsed ? (
              <ProjectLogo project={active} size="sm" compact />
            ) : (
              <>
                <ProjectLogo project={active} size="sm" compact />
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
                    {language === 'zh' ? '工作空间' : 'Workspace'}
                  </span>
                  <span className="mt-0.5 block truncate text-[0.8125rem] font-semibold leading-tight text-foreground">
                    {active.name}
                  </span>
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={collapsed ? 'right' : 'bottom'} className="max-h-[min(24rem,70vh)] w-64 overflow-y-auto">
          <DropdownMenuLabel className="flex items-center justify-between">
            <span>{language === 'zh' ? '切换工作空间' : 'Switch workspace'}</span>
            <span className="text-[10px] font-normal tabular-nums text-muted-foreground">{items.length}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {items.map((project) => {
            const isCurrent = project.id === active.id;
            return (
              <DropdownMenuItem key={project.id} onSelect={() => void switchProject(project.id)} className="min-h-10 gap-2.5">
                <ProjectLogo project={project} size="sm" compact />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{project.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{project.industry || project.companyName}</span>
                </span>
                {isCurrent ? <Check className="h-4 w-4 shrink-0 text-primary" aria-label={t('nav.currentProject')} /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }): React.JSX.Element {
  const { t, language } = useI18n();
  const isAdmin = useAuthStore(selectIsAdmin);
  const isPlatformAdmin = useAuthStore(selectIsPlatformAdmin);
  const canManageProjects = useAuthStore(selectCanManageProjects);
  const features = useMetaStore(selectDeploymentFeatures);

  const items = React.useMemo(
    () => NAV_ITEMS.filter(
      (item) => (!item.adminOnly || isAdmin)
        && (!item.managerOnly || canManageProjects)
        && (!item.platformOnly || isPlatformAdmin)
        && (!item.featureFlag || features[item.featureFlag]),
    ),
    [isAdmin, isPlatformAdmin, canManageProjects, features],
  );

  const rawGroups: Array<{ key: NavGroupKey; label: string; items: NavItem[] }> = [
    { key: 'workspace', label: language === 'zh' ? '工作空间' : 'Workspace', items: items.filter((item) => item.group === 'workspace') },
    { key: 'resources', label: language === 'zh' ? '业务资源' : 'Resources', items: items.filter((item) => item.group === 'resources') },
    { key: 'manage', label: language === 'zh' ? '系统管理' : 'Administration', items: items.filter((item) => item.group === 'manage') },
  ];
  const groups = rawGroups.filter((g) => g.items.length > 0);

  return (
    <nav className="sidebar-project-list flex-1 space-y-4 overflow-y-auto px-3 py-2" aria-label={t('nav.main')}>
      {groups.map((group) => (
        <div key={group.key} className="space-y-0.5">
          {!collapsed ? (
            <p className="mb-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/75">
              {group.label}
            </p>
          ) : (
            <div className="mx-auto my-2 h-px w-6 bg-sidebar-border" aria-hidden />
          )}
          {group.items.map((item) => (
            <NavLink
              key={`${group.key}-${item.labelKey}-${item.to}`}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              title={collapsed ? t(item.labelKey) : undefined}
              className={({ isActive }) =>
                cn(
                  'group relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[0.8125rem] font-medium transition-[background-color,color] duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  collapsed && 'justify-center px-0',
                  isActive
                    ? 'bg-card font-semibold text-foreground shadow-[0_1px_2px_hsl(40_10%_8%_/_0.06)] ring-1 ring-border/90'
                    : 'text-sidebar-foreground/75 hover:bg-sidebar-accent/70 hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    className={cn(
                      'h-4 w-4 shrink-0 transition-colors',
                      isActive ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
                    )}
                    aria-hidden
                  />
                  {!collapsed ? <span className="truncate">{t(item.labelKey)}</span> : null}
                </>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** 底部成员名片（展示真实登录用户信息，无硬编码演示人名） */
function SidebarUserCard({ collapsed }: { collapsed: boolean }): React.JSX.Element | null {
  const user = useAuthStore((state) => state.user);
  if (!user) return null;
  const displayName = user.displayName || user.username;
  const roleText = USER_ROLE_LABEL[user.role] ?? '销售';

  return (
    <div className={cn('shrink-0 border-t border-sidebar-border px-3 py-3', collapsed && 'px-2')}>
      <div className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5', collapsed && 'justify-center px-0')}>
        <span className="avatar-bubble flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ring-1 ring-primary/15">
          {initials(displayName)}
        </span>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.8125rem] font-semibold leading-tight text-foreground">{displayName}</span>
              <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">{roleText}</span>
            </span>
            <span className="h-2 w-2 shrink-0 rounded-full bg-status-developed ring-2 ring-sidebar" title="在线" aria-hidden />
          </>
        ) : null}
      </div>
    </div>
  );
}

export function Sidebar({ collapsed, mobile = false, onNavigate }: SidebarProps): React.JSX.Element {
  const { t } = useI18n();
  const isCollapsed = collapsed && !mobile;

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center">
        <div className="min-w-0 flex-1">
          <Brand collapsed={isCollapsed} />
        </div>
        {mobile && (
          <button
            type="button"
            onClick={onNavigate}
            aria-label={t('nav.close')}
            className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <SidebarWorkspaceCard collapsed={isCollapsed} />

      <NavList collapsed={isCollapsed} onNavigate={onNavigate} />

      <SidebarUserCard collapsed={isCollapsed} />
    </div>
  );
}
