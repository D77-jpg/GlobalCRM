import * as React from 'react';
import { BookOpen, FileText, Layers, ShieldCheck } from 'lucide-react';
import { KnowledgeAdmin } from '@/components/agent/knowledge-admin';
import { KnowledgeSalesLibrary } from '@/components/agent/knowledge-sales-library';
import { KnowledgeTraining } from '@/components/agent/knowledge-training';
import { PlaybookAdmin } from '@/components/agent/playbook-admin';
import { PolicyLedgerPanel } from '@/components/workbench/policy-ledger-panel';
import { KnowledgeQaPanel } from '@/components/workbench/knowledge-qa-panel';
import { PageHeader } from '@/components/common/page-header';
import { apiGet } from '@/lib/api';
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
      apiGet<{ items?: unknown[]; total?: number } | unknown[]>('/knowledge/sales'),
      apiGet<ProjectPolicyDto[]>('/workbench/policies'),
      apiGet<Paginated<Product>>('/products', { params: { limit: 1 } }),
    ]).then(([kRes, polRes, prodRes]) => {
      if (!active) return;
      const docs =
        kRes.status === 'fulfilled'
          ? Array.isArray(kRes.value)
            ? kRes.value.length
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
        ['sales', '资料库'],
        ['qa', 'AI 知识问答'],
        ['policies', '对外口径与红线'],
        ['manage', '资料管理'],
        ['playbook', '行业卡'],
        ['training', '质量与训练'],
      ] as const)
    : ([
        ['sales', '资料库'],
        ['qa', 'AI 知识问答'],
        ['policies', '对外口径与红线'],
      ] as const);
  const descriptions: Record<KnowledgeView, string> = {
    sales: '公司、产品、交易政策与销售事实依据 · 按项目严格隔离。',
    qa: '按目录树查阅并通过 AI 问答联动检索已审核资料、对外口径与产品参数卡。',
    policies: canManage ? '统一维护项目对外口径、品牌禁忌与发信规则检查。' : '查看本项目已确认的对外口径与品牌禁忌，避免写信时超出授权。',
    manage: '上传并审核企业销售文档，仅审核通过的资料会进入 AI 事实依据库。',
    playbook: '维护行业切入策略与话术偏好，仅影响表达方式，不混入事实依据。',
    training: '用真实审核反馈校准资料检索质量，不改动底层大模型。',
  };

  return (
    <section className="workspace-page">
      <PageHeader title="知识库" description={descriptions[active]} />

      {/* 4 Compact Knowledge KPI Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: '已发布销售资料', value: stats.docs, sub: '审核通过后供 AI 引用', icon: BookOpen, view: 'sales' as KnowledgeView },
          { label: '对外口径与红线', value: stats.policies, sub: '发信与回复前自动核验', icon: ShieldCheck, view: 'policies' as KnowledgeView },
          { label: '关联产品参数', value: stats.products, sub: 'SKU 规格与阶梯价依据', icon: Layers, view: 'qa' as KnowledgeView },
          { label: '项目隔离状态', value: project?.name || '当前项目', sub: '跨项目零串库共享', icon: FileText, view: active },
        ].map((card) => (
          <button
            key={card.label}
            type="button"
            onClick={() => tab(card.view)}
            className="panel flex items-start gap-3 p-3.5 text-left transition-colors hover:border-foreground/25"
          >
            <span className="flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground" aria-hidden>
              <card.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium text-muted-foreground">{card.label}</p>
              <p className="mt-0.5 truncate text-lg font-bold leading-snug tracking-[-0.025em] tabular-nums text-foreground">
                {card.value}
              </p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{card.sub}</p>
            </div>
          </button>
        ))}
      </div>

      <nav aria-label="知识库视图" className="flex flex-wrap items-center gap-5 border-b border-border">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={active === id ? 'page' : undefined}
            className={
              '-mb-px inline-flex h-10 items-center border-b-2 px-1 text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ' +
              (active === id ? 'border-foreground font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')
            }
            onClick={() => tab(id)}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto hidden pr-1 text-xs text-muted-foreground sm:block">{project?.name} · 项目隔离资料库</span>
      </nav>

      <div className={full ? 'min-w-0' : 'panel min-w-0 overflow-hidden xl:flex xl:h-[calc(100dvh-16rem)] xl:flex-col'}>
        {active === 'qa' ? (
          <KnowledgeQaPanel key={`qa:${key}`} admin={admin} />
        ) : active === 'policies' ? (
          <PolicyLedgerPanel key={`pol:${key}`} canManage={canManage} />
        ) : active === 'playbook' ? (
          <PlaybookAdmin key={key} />
        ) : active === 'training' ? (
          <KnowledgeTraining />
        ) : active === 'manage' ? (
          <KnowledgeAdmin
            key={key}
            initialKnowledgeId={requested === 'manage' ? item : undefined}
            initialDocumentId={params.get('document') ?? undefined}
            initialRevisionId={params.get('revision') ?? undefined}
            initialChunkId={params.get('chunk') ?? undefined}
          />
        ) : (
          <KnowledgeSalesLibrary
            key={key}
            admin={admin}
            initialId={item}
            onManage={(id) => setParams(id ? { view: 'manage', knowledge: id } : { view: 'manage' })}
            onImport={() => setParams({ view: 'manage' })}
          />
        )}
      </div>
    </section>
  );
}
