import {KnowledgeAdmin} from '@/components/agent/knowledge-admin';
import {KnowledgeSalesLibrary} from '@/components/agent/knowledge-sales-library';
import {KnowledgeTraining} from '@/components/agent/knowledge-training';
import {PlaybookAdmin} from '@/components/agent/playbook-admin';
import {PolicyLedgerPanel} from '@/components/workbench/policy-ledger-panel';
import {KnowledgeQaPanel} from '@/components/workbench/knowledge-qa-panel';
import {PageHeader} from '@/components/common/page-header';
import {usePageTitle} from '@/hooks/use-ui';
import {selectCanManageProjects, useAuthStore} from '@/store/auth.store';
import {useProjectStore} from '@/store/project.store';
import {useSearchParams} from 'react-router-dom';

type KnowledgeView = 'sales' | 'qa' | 'policies' | 'manage' | 'training' | 'playbook';

export function KnowledgePage(){
 usePageTitle('知识库');
 const user=useAuthStore(s=>s.user),admin=user?.role==='admin',canManage=useAuthStore(selectCanManageProjects);
 const project=useProjectStore(s=>s.activeProject);
 const [params,setParams]=useSearchParams();
 // Old links (documents/index) are folded into the single management view.
 const requested=params.get('view');
 const active:KnowledgeView = requested==='qa'
  ?'qa'
  :requested==='policies'
   ?'policies'
   :admin&&requested==='playbook'
    ?'playbook'
    :admin&&requested==='training'
     ?'training'
     :admin&&(requested==='manage'||requested==='documents'||requested==='index')
      ?'manage'
      :'sales';
 const item=params.get('knowledge')??params.get('item')??undefined;
 const key=project?.id+':'+user?.id;
 const full=active!=='sales';
 const tab=(id:KnowledgeView)=>{
  if(id==='sales'){setParams(item?{item}:{});return;}
  setParams({view:id});
 };
 const tabs: readonly (readonly [KnowledgeView, string])[] = admin
  ? ([['sales','资料库'],['qa','AI 知识问答'],['policies','对外口径与红线'],['manage','资料管理'],['playbook','行业卡'],['training','质量与训练']] as const)
  : ([['sales','资料库'],['qa','AI 知识问答'],['policies','对外口径与红线']] as const);
 const descriptions: Record<KnowledgeView, string> = {
  sales: '销售查询已发布的公司、产品与交易政策，作为写开发信的事实依据。',
  qa: '按目录树查阅并通过 AI 问答联动检索已审核资料、对外口径与产品参数卡。',
  policies: canManage
   ? '统一维护项目对外口径、品牌禁忌与发信规则检查。'
   : '查看本项目已确认的对外口径与品牌禁忌，避免写信时超出授权。',
  manage: '把文件收成资料，发布后助手才能使用',
  playbook: '行业卡只影响写作策略，不进入事实证据',
  training: '用真实审核结果校准资料检索，不改动 AI 底层模型',
 };
 return <section className="workspace-page">
  <PageHeader title="知识库" description={descriptions[active]} />
  <nav aria-label="知识库视图" className="flex flex-wrap items-center gap-4 border-b border-border">
   {tabs.map(([id,label])=><button key={id} type="button" aria-current={active===id?'page':undefined} className={'-mb-px inline-flex h-10 items-center border-b-2 px-1 text-[0.8125rem] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 '+(active===id?'border-primary font-semibold text-primary':'border-transparent text-muted-foreground hover:text-foreground')} onClick={()=>tab(id)}>{label}</button>)}
   <span className="ml-auto hidden pr-1 text-xs text-muted-foreground sm:block">{project?.name} · 项目隔离资料库</span>
  </nav>
  <div className={full?'min-w-0':'panel min-w-0 overflow-hidden xl:flex xl:h-[calc(100dvh-13rem)] xl:flex-col'}>
   {active==='qa'?<KnowledgeQaPanel key={`qa:${key}`} admin={admin}/>
    :active==='policies'?<PolicyLedgerPanel key={`pol:${key}`} canManage={canManage}/>
    :active==='playbook'?<PlaybookAdmin key={key}/>
    :active==='training'?<KnowledgeTraining/>
    :active==='manage'?<KnowledgeAdmin key={key} initialKnowledgeId={requested==='manage'?item:undefined} initialDocumentId={params.get('document')??undefined} initialRevisionId={params.get('revision')??undefined} initialChunkId={params.get('chunk')??undefined}/>
    :<KnowledgeSalesLibrary key={key} admin={admin} initialId={item} onManage={id=>setParams(id?{view:'manage',knowledge:id}:{view:'manage'})} onImport={()=>setParams({view:'manage'})}/>}
  </div>
 </section>;
}
