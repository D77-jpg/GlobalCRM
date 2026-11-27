import { GlobalSiteNotifications } from '@/components/customers/globalsite-inquiries';
/**
 * Top Header — Executive utility bar
 * ------------------------------------------------------------------
 * Left: sidebar toggle + live workspace breadcrumb (Project / Current Page)
 * Center: unified Global Search & Command Palette pill (Ctrl K / ⌘K)
 * Right: prominent Forest-Emerald AI Assistant CTA, Scratchpad, Inquiries bell,
 *        Language toggle, Theme toggle, User menu.
 */
import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Menu, PanelLeftClose, PanelLeftOpen, Search, Sparkles, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/popover';
import { ThemeToggle } from './theme-toggle';
import { LanguageToggle } from './language-toggle';
import { UserMenu } from './user-menu';
import { ProjectSwitcher } from './project-switcher';
import { NAV_ITEMS } from './sidebar';
import { ROUTES } from '@/constants';
import { useMetaStore } from '@/store/meta.store';
import { useProjectStore } from '@/store/project.store';
import { useUiStore } from '@/store/ui.store';
import { useCustomerStore } from '@/store/customer.store';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

function GlobalSearch(): React.JSX.Element {
  const navigate = useNavigate();
  const setFilters = useCustomerStore((state) => state.setFilters);
  const [value, setValue] = React.useState('');
  const shortcutKey = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K';
  const { t, language } = useI18n();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const query = value.trim();
    if (!query) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
      return;
    }
    setFilters({ search: query });
    navigate(ROUTES.customers);
    setValue('');
  }

  return (
    <form onSubmit={submit} role="search" className="relative hidden min-w-[13.5rem] max-w-[25rem] flex-1 md:block">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={t('header.searchAria')}
        placeholder={language === 'zh' ? '搜索客户、邮件或报价…' : 'Search customers, mail, quotes…'}
        className="h-9 w-full rounded-xl border border-border/80 bg-surface pl-9 pr-16 text-xs text-foreground outline-none transition-[border-color,background-color,box-shadow] placeholder:text-muted-foreground/80 hover:border-foreground/20 hover:bg-card focus:border-primary/50 focus:bg-card focus:ring-2 focus:ring-primary/15"
      />
      <button
        type="button"
        onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))}
        title={language === 'zh' ? '打开全局命令面板' : 'Open command palette'}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
      >
        {shortcutKey}
      </button>
    </form>
  );
}

export interface HeaderProps {
  onOpenMobileNav: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export function Header({ onOpenMobileNav, sidebarCollapsed, onToggleSidebar }: HeaderProps): React.JSX.Element {
  const { t, language } = useI18n();
  const location = useLocation();
  const activeProject = useProjectStore((state) => state.activeProject);
  const channel = useMetaStore((state) => state.mailChannel);
  const scratchpadOpen = useUiStore((state) => state.scratchpadOpen);
  const toggleScratchpad = useUiStore((state) => state.toggleScratchpad);
  const agentOpen = useUiStore((state) => state.agentOpen);
  const toggleAgent = useUiStore((state) => state.toggleAgent);

  const currentNavLabel = React.useMemo(() => {
    if (location.pathname.startsWith('/customers/')) {
      return language === 'zh' ? '客户详情' : 'Customer Detail';
    }
    const matched = NAV_ITEMS.find((item) =>
      item.end ? location.pathname === item.to : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
    );
    return matched ? t(matched.labelKey) : '';
  }, [location.pathname, language, t]);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-card/95 px-3.5 backdrop-blur-md sm:px-5 lg:px-6 xl:px-8">
      <Button type="button" variant="ghost" size="icon-sm" className="lg:hidden" onClick={onOpenMobileNav} aria-label={t('nav.open')}>
        <Menu className="h-4 w-4" />
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="hidden text-muted-foreground hover:text-foreground lg:inline-flex"
            onClick={onToggleSidebar}
            aria-label={sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}
            aria-pressed={sidebarCollapsed}
          >
            {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}</TooltipContent>
      </Tooltip>

      {/* Mobile keeps compact switcher; Desktop shows clean contextual breadcrumb */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="lg:hidden">
          <ProjectSwitcher />
        </div>
        {activeProject ? (
          <div className="hidden min-w-0 items-center gap-2 text-[0.8125rem] lg:flex">
            <span className="max-w-[10rem] truncate font-semibold text-foreground">{activeProject.name}</span>
            {currentNavLabel ? (
              <>
                <span className="text-muted-foreground/45" aria-hidden>/</span>
                <span className="truncate font-medium text-muted-foreground">{currentNavLabel}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <GlobalSearch />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {channel === 'mock' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="mr-1 hidden items-center gap-1.5 rounded-full border border-amberx/25 bg-amberx-soft/75 px-2.5 py-0.5 text-[11px] font-medium text-amberx xl:inline-flex">
                <span className="h-1.5 w-1.5 rounded-full bg-amberx" aria-hidden />
                {t('header.mock')}
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[16rem]">
              {t('header.mockHint')}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={toggleAgent}
              aria-label={agentOpen ? t('header.assistantClose') : t('header.assistantOpen')}
              aria-expanded={agentOpen}
              className={cn(
                'h-8 gap-1.5 rounded-lg px-3 text-xs font-medium shadow-sm',
                agentOpen && 'ring-2 ring-foreground/20 ring-offset-1 ring-offset-card',
              )}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{language === 'zh' ? 'AI 助手' : 'AI Assistant'}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('header.assistant')} · Ctrl/Cmd + Shift + A</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={scratchpadOpen ? 'secondary' : 'ghost'}
              size="icon-sm"
              onClick={toggleScratchpad}
              aria-label={scratchpadOpen ? t('header.scratchpadClose') : t('header.scratchpadOpen')}
              aria-expanded={scratchpadOpen}
            >
              <StickyNote className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('header.scratchpad')} · Ctrl/Cmd + Shift + M</TooltipContent>
        </Tooltip>

        <GlobalSiteNotifications />
        <LanguageToggle />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
