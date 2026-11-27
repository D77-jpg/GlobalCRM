import * as React from 'react';
import { BookOpen, Layers, Lock, ShieldCheck } from 'lucide-react';
import { KnowledgeAdmin } from '@/components/agent/knowledge-admin';
import { KnowledgeSalesLibrary } from '@/components/agent/knowledge-sales-library';
import { KnowledgeTraining } from '@/components/agent/knowledge-training';
import { PlaybookAdmin } from '@/components/agent/playbook-admin';
import { PolicyLedgerPanel } from '@/components/workbench/policy-ledger-panel';
import { KnowledgeQaPanel } from '@/components/workbench/knowledge-qa-panel';
import { PageHeader } from '@/components/common/page-header';
import { apiGet } from '@/lib/api';
import { cn } from '@/lib/utils';
import { usePageTitle } from '@/hooks/use-ui';
import { selectCanManageProjects, useAuthStore } from '@/store/auth.store';
import { useProjectStore } from '@/store/project.store';
import { useSearchParams } from 'react-router-dom';
import type { Paginated, Product, ProjectPolicyDto } from '@/types';

type KnowledgeView = 'sales' | 'qa' | 'policies' | 'manage' | 'training' | 'playbook';

export function KnowledgePage() {
  usePageTitle('知识库');
  const user = useAuthStore((s) => s.user);
  const admin = user?.role === 'admin';
  const canManage = useAuthStore(selectCanManageProjects);
  const project = useProjectStore((s) => s.activeProject);
  const [params, setParams] = useSearchParams();
  const [stats, setStats] = React.useState<{ docs: number; policies: number; products: number }>({
    docs: 0,
    policies: 0,
    products: 0,
  });

  React.useEffect(() => {
    let active = true;
    void Promise.allSettled([
      apiGet<{ items?: unknown[]; total?: number } | unknown[]>('/agent/knowledge'),
      apiGet<ProjectPolicyDto[]>('/workbench/policies'),
      apiGet<Paginated<Product>>('/products', { params: { limit: 1 } }),
    ]).then(([kRes, polRes, prodRes]) => {
      if (!active) return;
      const docs =
        kRes.status === 'fulfilled'
          ? Array.isArray(kRes.value)
            ? kRes.value.filter((x) => !(x as { archived?: boolean }).archived).length
            : typeof kRes.value?.total === 'number'
              ? kRes.value.total
              : Array.isArray(kRes.value?.items)
                ? kRes.value.items.length
                : 0
          : 0;
      const policies = polRes.status === 'fulfilled' && Array.isArray(polRes.value) ? polRes.value.length : 0;
      const products = prodRes.status === 'fulfilled' ? prodRes.value.total ?? 0 : 0;
      setStats({ docs, policies, products });
    });
    return () => {
      active = false;
    };
  }, [project?.id]);

  const requested = params.get('view');
  const active: KnowledgeView =
    requested === 'qa'
      ? 'qa'
      : requested === 'policies'
        ? 'policies'
        : admin && requested === 'playbook'
          ? 'playbook'
          : admin && requested === 'training'
            ? 'training'
            : admin && (requested === 'manage' || requested === 'documents' || requested === 'index')
              ? 'manage'
              : 'sales';
  const item = params.get('knowledge') ?? params.get('item') ?? undefined;
  const key = project?.id + ':' + user?.id;
  const full = active !== 'sales';
  const tab = (id: KnowledgeView) => {
    if (id === 'sales') {
      setParams(item ? { item } : {});
      return;
    }
    setParams({ view: id });
  };
  const tabs: readonly (readonly [KnowledgeView, string])[] = admin
    ? ([
        ['sales', '事实资料库'],
        ['qa', 'AI 检索问答'],
        ['policies', '对外口径与红线'],
        ['manage', '资料审核管理'],
        ['playbook', '行业话术卡'],
        ['training', '检索质量校准'],
      ] as const)
    : ([
        ['sales', '事实资料库'],
        ['qa', 'AI 检索问答'],
        ['policies', '对外口径与红线'],
      ] as const);

  const descriptions: Record<KnowledgeView, string> = {
    sales: '企业产品、包装选型、交易政策与对外事实依据中枢 · 仅已发布资料可供 AI 引用。',
    qa: '基于当前项目已审核资料、对外口径与产品参数进行可溯源 AI 检索问答。',
    policies: canManage ? '统一维护项目对外口径、品牌禁忌与发信前自动合规拦截规则。' : '查看本项目已确认的对外口径与品牌禁忌，避免沟通超出授权。',
    manage: '上传、修订并审核企业销售文档，严格把控进入 AI 事实库的每一条依据。',
    playbook: '维护细分行业切入角度与表达策略，仅指导行文风格，不混入事实承诺。',
    training: '用真实业务审核反馈持续校准检索命中率，不触碰底层外部模型。',
  };

  return (
    <section className="workspace-page">
      <PageHeader title="企业知识大脑" description={descriptions[active]} />

      {/* Trade OS Unified Brain Control Bar (Replaces 4 Generic KPI Boxes + Double Tab Bars) */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-3.5 py-2.5 shadow-xs">
        <nav aria-label="知识库视图" className="os-segmented flex-wrap">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-current={active === id ? 'page' : undefined}
              onClick={() => tab(id)}
              className={cn('os-segmented-item', active === id && 'os-segmented-item-active')}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => tab('sales')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface/65 px-2.5 py-1 text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
          >
            <BookOpen className="h-3.5 w-3.5 text-foreground" aria-hidden />
            <span>已审资料</span>
            <strong className="font-mono font-semibold tabular-nums text-foreground">{stats.docs}</strong>
          </button>
          <button
            type="button"
            onClick={() => tab('policies')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface/65 px-2.5 py-1 text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-foreground" aria-hidden />
            <span>口径红线</span>
            <strong className="font-mono font-semibold tabular-nums text-foreground">{stats.policies}</strong>
          </button>
          <button
            type="button"
            onClick={() => tab('qa')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-surface/65 px-2.5 py-1 text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
          >
            <Layers className="h-3.5 w-3.5 text-foreground" aria-hidden />
            <span>关联 SKU</span>
            <strong className="font-mono font-semibold tabular-nums text-foreground">{stats.products}</strong>
          </button>
          <span className="hidden items-center gap-1 rounded-lg border border-border/70 bg-surface/40 px-2.5 py-1 text-[11px] text-muted-foreground 2xl:inline-flex">
            <Lock className="h-3 w-3" aria-hidden />
            {project?.name || '当前项目'} 物理隔离
          </span>
        </div>
      </div>

      <div className={full ? 'min-w-0' : 'panel min-w-0 overflow-hidden xl:flex xl:h-[calc(100dvh-12.5rem)] xl:min-h-[600px] xl:flex-col'}>
        {active === 'qa' ? (
          <KnowledgeQaPanel key={`qa:${key}`} admin={admin} />
        ) : active === 'policies' ? (
          <PolicyLedgerPanel key={`pol:${key}`} canManage={canManage} />
        ) : active === 'playbook' ? (
          <PlaybookAdmin key={`pb:${key}`} />
        ) : active === 'training' ? (
          <KnowledgeTraining key={`train:${key}`} />
        ) : active === 'manage' ? (
          <KnowledgeAdmin
            key={`adm:${key}`}
            initialKnowledgeId={item}
            initialDocumentId={params.get('document') ?? undefined}
            initialRevisionId={params.get('revision') ?? undefined}
            initialChunkId={params.get('chunk') ?? undefined}
          />
        ) : (
          <KnowledgeSalesLibrary
            key={`lib:${key}`}
            admin={admin}
            initialId={item}
            onManage={(id) => setParams(id ? { view: 'manage', item: id } : { view: 'manage' })}
            onImport={() => setParams({ view: 'manage' })}
          />
        )}
      </div>
    </section>
  );
}
