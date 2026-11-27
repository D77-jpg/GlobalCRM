/**
 * AppShell —— 现代化外贸 CRM 全局应用骨架
 * ------------------------------------------------------------------
 * 左侧暖石侧栏（含项目工作空间切换 + 三段式信息架构 + 底部成员名片），
 * 右侧精致顶栏（面包屑 + 全局搜索/指令入口 + 森林绿 AI 助手按钮 + 通知/语言/主题）
 * 与温润象牙白内容区。移动端自动收起为抽屉。
 */
import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { useUiStore } from '@/store/ui.store';
import { useIsMobile, useEscapeKey } from '@/hooks/use-ui';
import { cn } from '@/lib/utils';
import { ScratchpadPanel } from '@/components/scratchpad/scratchpad-panel';
import { CommandPalette } from './command-palette';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { selectIsReadOnly, useAuthStore } from '@/store/auth.store';
import { useI18n } from '@/i18n';

const LazyAgentPanel = React.lazy(() =>
  import('@/components/agent/agent-panel').then((m) => ({ default: m.AgentPanel })),
);

const SIDEBAR_WIDTH = '15.5rem';
const SIDEBAR_WIDTH_COLLAPSED = '4.25rem';

export function AppShell(): React.JSX.Element {
  const { t } = useI18n();
  const readOnly = useAuthStore(selectIsReadOnly);
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const mobileNavOpen = useUiStore((state) => state.mobileNavOpen);
  const setMobileNavOpen = useUiStore((state) => state.setMobileNavOpen);
  const agentOpen = useUiStore((state) => state.agentOpen);
  const [agentMounted, setAgentMounted] = React.useState(false);
  React.useEffect(() => { if (agentOpen) setAgentMounted(true); }, [agentOpen]);
  const isMobile = useIsMobile();
  const location = useLocation();
  const scrollRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    setMobileNavOpen(false);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [location.pathname, setMobileNavOpen]);

  React.useEffect(() => {
    if (isMobile && mobileNavOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobile, mobileNavOpen]);

  useEscapeKey(() => setMobileNavOpen(false), mobileNavOpen && isMobile);

  const sidebarWidth = collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH;

  return (
    <div className="workspace-shell overflow-hidden">
      <a href="#workspace-main" className="workspace-skip-link">{t('app.skip')}</a>

      <div className="workspace-shell-body flex h-full w-full overflow-hidden bg-background">
        {/* 桌面端暖石侧栏 */}
        <aside
          className="hidden shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:block"
          style={{ width: sidebarWidth }}
        >
          <Sidebar collapsed={collapsed} />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            onOpenMobileNav={() => setMobileNavOpen(true)}
            sidebarCollapsed={collapsed}
            onToggleSidebar={toggleSidebar}
          />

          <main
            id="workspace-main"
            ref={scrollRef}
            tabIndex={-1}
            className="workspace-main no-print min-w-0 flex-1 overflow-y-auto bg-background px-4 py-4 sm:px-6 sm:py-5 lg:px-7 xl:px-8"
          >
            <div className="mx-auto min-w-0 w-full max-w-[var(--workspace-content-width)]">
              {readOnly ? (
                <div role="status" className="mb-4 flex items-start gap-2.5 rounded-xl border border-amberx/25 bg-amberx-soft/75 px-3.5 py-2.5 text-xs text-amberx">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amberx" aria-hidden />
                  <span><strong className="font-semibold">{t('role.readOnlyTitle')}</strong> · {t('role.readOnlyDesc')}</span>
                </div>
              ) : null}
              <Outlet />
            </div>
          </main>
        </div>
      </div>

      {/* 移动端导航抽屉 */}
      <Dialog open={mobileNavOpen && isMobile} onOpenChange={setMobileNavOpen}>
        <DialogContent
          hideClose
          aria-describedby={undefined}
          className={cn('left-0 top-0 h-dvh max-h-none w-[16.5rem] max-w-[85vw] translate-x-0 translate-y-0 gap-0 rounded-none border-0 bg-sidebar p-0 sm:p-0')}
        >
          <DialogTitle className="sr-only">{t('nav.main')}</DialogTitle>
          <Sidebar collapsed={false} mobile onNavigate={() => setMobileNavOpen(false)} />
        </DialogContent>
      </Dialog>

      <ScratchpadPanel />
      <CommandPalette />
      {agentMounted ? (
        <React.Suspense fallback={null}>
          <LazyAgentPanel />
        </React.Suspense>
      ) : null}
    </div>
  );
}
