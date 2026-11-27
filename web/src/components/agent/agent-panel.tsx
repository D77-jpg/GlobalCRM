import * as React from 'react';
import {PendingDrafts} from '@/components/letters/pending-drafts';
import {usePendingDrafts} from '@/hooks/use-pending-drafts';
import {acceptsKnowledgeHandoff} from '@/lib/knowledge-sales';
import { WorkspaceDrawer } from '@/components/common/workspace';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  BriefcaseBusiness,
  Inbox,
  Layers3,
  ListChecks,
  MessageSquare,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  FileClock,
  Loader2,
  MailSearch,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useEscapeKey, useIsMobile } from '@/hooks/use-ui';
import { apiGet, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { CUSTOMER_STATUS_LABEL } from '@/constants';
import { useAuthStore } from '@/store/auth.store';
import { useProjectStore } from '@/store/project.store';
import { useUiStore } from '@/store/ui.store';
import type { AgentAction, AgentRecordedWorkflow, AgentContext, AgentMessage, AgentSession, AgentStatus, AgentUsage, Customer, DevelopmentLetter } from '@/types';
import {AgentEventInbox} from './agent-event-inbox';
import {AgentBatches} from './agent-batches';
import {AgentKnowledge} from './agent-knowledge';
import { AgentTasks, type AgentTask } from './agent-tasks';
import { taskCounts } from '@/lib/agent-workflow';
import { AgentMessageContent } from './agent-message-content';
import { AgentActionDetail } from './agent-action-detail';
import { ScratchpadCustomerPreviewView } from './scratchpad-customer-preview';
import { CustomerAnalysisView } from './customer-analysis';
import { MailThreadAnalysisView } from './mail-thread-analysis';

interface SendResult {
  userMessage: AgentMessage;
  assistantMessage: AgentMessage;
  degraded: boolean;
}

const EMPTY_USAGE: AgentUsage = {
  runs: 0, completed: 0, failed: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0,
  estimatedCostUsd: 0, toolSuccessRate: 0, approvals: { approved: 0, rejected: 0, pending: 0 },
};

function routeContext(pathname: string, search: string): AgentContext {
  const customerMatch = /^\/customers\/([a-f\d]{24})(?:\/|$)/i.exec(pathname);
  if (customerMatch?.[1]) return { type: 'customer', resourceId: customerMatch[1] };
  if (pathname === '/mail' || pathname.startsWith('/mail/')) {
    const params = new URLSearchParams(search);
    const id = params.get('id');
    if (id && /^[a-f\d]{24}$/i.test(id)) {
      return { type: 'mail', resourceId: id, direction: params.get('direction') === 'outbound' ? 'outbound' : 'inbound' };
    }
  }
  return { type: 'global' };
}

function sessionContextLabel(session: AgentSession): string {
  if (session.context.type === 'global') return '项目会话';
  const type = session.context.type === 'customer' ? '客户' : '邮件';
  return session.contextName ? `${type} · ${session.contextName}` : `${type}会话`;
}

function sameContext(left: AgentContext, right: AgentContext): boolean {
  return left.type === right.type
    && ('resourceId' in left ? left.resourceId : '') === ('resourceId' in right ? right.resourceId : '')
    && ('direction' in left ? left.direction : '') === ('direction' in right ? right.direction : '');
}

function suggestions(context: AgentContext): string[] {
  if (context.type === 'customer') return ['帮我给这个客户写第一封开发信', '请给这个客户写报价说明邮件，不要发送', '请给这个客户写样品回复邮件，不要发送', '请给这个客户写跟进邮件，不要发送', '总结客户时间线'];
  if (context.type === 'mail') return ['请回复这封询盘邮件，不要发送', '请写样品回复邮件，不要发送', '请写报价说明邮件，不要发送', '总结这封邮件的往来'];
  return ['总结今天的销售工作区', '有哪些逾期客户需要优先处理？', '给我一份今日工作建议'];
}

function actionLabel(toolName: string): string {
  const labels: Record<string, string> = {
    search_customers: '查找客户',
    prepare_first_outreach_draft: '准备并保存开发信草稿',
    get_current_customer: '读取当前客户',
    get_customer_timeline: '读取客户时间线',
    get_mail_thread: '读取邮件往来',
    get_customer_followups: '读取跟进记录',
    get_customer_quotations: '读取报价记录',
    get_dashboard_summary: '读取仪表盘',
    extract_scratchpad_customer: '提取随手记客户',
    extract_mail_customer: '从邮件提取客户',
    update_scratchpad_customer_preview: '编辑客户预览',
    create_customer_from_scratchpad: '确认创建客户',
    research_customer:'分析客户官网与开发角度',
    analyze_customer_and_draft_email: '分析客户并生成邮件草稿',
    edit_customer_analysis_draft: '编辑分析草稿',
    save_agent_email_draft: '确认保存开发信草稿',
    schedule_agent_followup: '确认安排跟进',
    analyze_mail_thread: '分析邮件会话',
    edit_mail_thread_approval: '编辑邮件审批卡片',
    save_mail_reply_draft: '确认保存回复草稿',
    apply_mail_customer_status: '确认更新客户状态',
    save_mail_followup_record: '确认保存跟进记录',
  };
  return labels[toolName] ?? ({
    search_product_knowledge:'查项目资料',list_customer_attachments:'查看客户附件',read_customer_attachment:'读取附件正文',
  } as Record<string,string>)[toolName] ?? '处理业务资料';
}

export function AgentPanel(): React.JSX.Element | null {
  const user = useAuthStore((state) => state.user);
  const project = useProjectStore((state) => state.activeProject);
  const open = useUiStore((state) => state.agentOpen);
  const setOpen = useUiStore((state) => state.setAgentOpen);
  const toggleOpen = useUiStore((state) => state.toggleAgent);
  const customerPreviewId = useUiStore((state) => state.agentCustomerPreviewId);
  const customerAnalysisId = useUiStore((state) => state.agentCustomerAnalysisId);
  const customerAnalysisCustomerId = useUiStore((state) => state.agentCustomerAnalysisCustomerId);
  const openCustomerAnalysis = useUiStore((state) => state.openAgentCustomerAnalysis);
  const clearCustomerAnalysis = useUiStore((state) => state.clearAgentCustomerAnalysis);
  const mailAnalysisId = useUiStore((state) => state.agentMailAnalysisId);
  const mailAnalysisMailId = useUiStore((state) => state.agentMailAnalysisMailId);
  const mailAnalysisDirection = useUiStore((state) => state.agentMailAnalysisDirection);
  const openMailAnalysis = useUiStore((state) => state.openAgentMailAnalysis);
  const clearMailAnalysis = useUiStore((state) => state.clearAgentMailAnalysis);
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const openCustomerPreview = useUiStore((state) => state.openAgentCustomerPreview);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const context = React.useMemo(() => routeContext(location.pathname, location.search), [location.pathname, location.search]);

  const [status, setStatus] = React.useState<AgentStatus | null>(null);
  const [sessions, setSessions] = React.useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState('');
  const [messages, setMessages] = React.useState<AgentMessage[]>([]);
  const [usage, setUsage] = React.useState<AgentUsage>(EMPTY_USAGE);
  const [actions, setActions] = React.useState<AgentAction[]>([]);
  const [draft, setDraft] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const analyzing=sending;
  const [error, setError] = React.useState('');
  const [tab, setTab] = React.useState('chat');
  const selectedBatchIds=useUiStore(s=>s.agentBatchCustomerIds);
  const clearBatchSelection=useUiStore(s=>s.clearAgentBatchSelection);
  const promptHandoff = useUiStore((s) => s.agentPromptHandoff);
  const clearPromptHandoff = useUiStore((s) => s.clearAgentPromptHandoff);
  React.useEffect(()=>{if(selectedBatchIds.length)setTab('batches');},[selectedBatchIds]);
  React.useEffect(() => {
    if (!open || !promptHandoff) return;
    setTab('chat');
    setDraft(promptHandoff.prompt);
    clearPromptHandoff(promptHandoff.requestId);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open, promptHandoff, clearPromptHandoff]);
  const [focusTaskId,setFocusTaskId]=React.useState<string|null>(null);
  const [autoOpenTaskId, setAutoOpenTaskId] = React.useState<string|null>(null);
  const [recordsError, setRecordsError] = React.useState('');
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [renameTitle, setRenameTitle] = React.useState('');
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [sessionListOpen, setSessionListOpen] = React.useState(false);
  const [sessionActionsOpen, setSessionActionsOpen] = React.useState(false);
  const [sessionSaving, setSessionSaving] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const activeContext = activeSession?.context ?? context;
  const [customerInfo, setCustomerInfo] = React.useState<{ key: string; customer: Customer } | null>(null);
  const [workflowTasks, setWorkflowTasks] = React.useState<AgentTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = React.useState(false);
  const [tasksError, setTasksError] = React.useState('');
  const contextKey = project?.id + ':' + (activeContext.type === 'customer' ? activeContext.resourceId : '');
  const currentCustomer = customerInfo?.key === contextKey ? customerInfo.customer : null;
  const pendingDrafts=usePendingDrafts(context.type==='customer'?context.resourceId:undefined,open);
  const contextualTasks = workflowTasks.filter(task => activeContext.type === 'customer'
    ? task.customerId === activeContext.resourceId
    : activeContext.type === 'mail' ? task.sourceMailId === activeContext.resourceId : true);
  const contextCounts = taskCounts(contextualTasks);
  // 待审核任务通常已经有对应草稿；草稿清单已经代表这份工作，不能再重复计数。
  const reviewTasksWithoutDraft = contextualTasks.filter(task => task.status === 'awaiting_review' && !task.draftId && !task.staleDraftId).length;
  const taskTodoCount = contextCounts.attention + reviewTasksWithoutDraft;
  const hasPendingWork = pendingDrafts.total > 0 || taskTodoCount > 0 || contextCounts.active > 0;
  const workSummary = [
    pendingDrafts.total > 0 ? `草稿待审核 ${pendingDrafts.total} 封` : reviewTasksWithoutDraft > 0 ? `任务待审核 ${reviewTasksWithoutDraft} 项` : '',
    contextCounts.attention > 0 ? `任务需处理 ${contextCounts.attention} 项` : '',
    contextCounts.active > 0 ? `任务准备中 ${contextCounts.active} 项` : '',
  ].filter(Boolean).join(' · ');
  const secondaryLabels: Record<string, string> = {
    inbox: '来信与提醒', batches: '批量写信', knowledge: '项目知识库', records: '操作记录',
    'customer-preview': '客户预览', 'customer-analysis': '客户分析', 'mail-analysis': '邮件助理',
  };

  React.useEffect(() => {
    if (!open || !user?.id || !project?.id) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setWorkflowTasks([]);
    setTasksLoaded(false);
    setTasksError('');
    const poll = async () => {
      try {
        const rows = await apiGet<AgentTask[]>('/agent/tasks');
        if (active) { setWorkflowTasks(rows); setTasksLoaded(true); setTasksError(''); }
      } catch (reason) {
        if (active) setTasksError(toErrorMessage(reason, '待办暂未更新，请稍后重试'));
      }
      if (active) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [open, project?.id, user?.id]);

  React.useEffect(() => {
    setCustomerInfo(null);
    if (!open || activeContext.type !== 'customer') return;
    let active = true;
    void apiGet<Customer>('/customers/' + activeContext.resourceId)
      .then(customer => { if (active) setCustomerInfo({ key: contextKey, customer }); })
      .catch(() => { if (active) setCustomerInfo(null); });
    return () => { active = false; };
  }, [open, contextKey, activeContext]);

  const loadRecords = React.useCallback(async () => {
    const [nextUsage, nextActions] = await Promise.all([
      apiGet<AgentUsage>('/agent/usage'),
      apiGet<AgentAction[]>('/agent/approvals'),
    ]);
    setUsage(nextUsage);
    setActions(nextActions);
  }, []);

  React.useEffect(() => {
    if (tab !== 'records' || !open) return;
    setRecordsError('');
    void loadRecords().catch((reason) => setRecordsError(toErrorMessage(reason, '运行记录加载失败')));
  }, [tab, open, loadRecords]);

  React.useEffect(() => { setSelectedActionId(null); }, [project?.id, user?.id]);

  const loadSessions = React.useCallback(async () => {
    const nextSessions = await apiGet<AgentSession[]>('/agent/sessions');
    const visibleSessions = nextSessions.filter((item) => item.messageCount > 0);
    setSessions(visibleSessions);
    return visibleSessions;
  }, []);

  const panelLoad = React.useRef(0);
  const cancelPanelLoad = React.useCallback(() => { panelLoad.current++; }, []);
  const loadPanel = React.useCallback(async () => {
    const loadId = ++panelLoad.current;
    const handoff = useUiStore.getState().agentKnowledgeHandoff;
    setLoading(true);
    setError('');
    try {
      const [nextStatus, nextSessions] = await Promise.all([
        apiGet<AgentStatus>('/agent/status'),
        loadSessions(),
        loadRecords(),
      ]);
      if (loadId !== panelLoad.current) return;
      setStatus(nextStatus);
      if (handoff && acceptsKnowledgeHandoff(handoff, project?.id, user?.id, context)) {
        setActiveSessionId('');
        setMessages([]);
        setDraft(handoff.prompt);
        setTab('chat');
        useUiStore.getState().clearKnowledgeHandoff(handoff.requestId);
      } else {
        const matching = nextSessions.find((item) => sameContext(item.context, context));
        setActiveSessionId(matching?.id ?? '');
        if (handoff) useUiStore.getState().clearKnowledgeHandoff(handoff.requestId);
      }
    } catch (reason) {
      if (loadId === panelLoad.current) setError(toErrorMessage(reason, '销售助手暂时无法加载，请重试'));
    } finally {
      if (loadId === panelLoad.current) setLoading(false);
    }
  }, [context, loadRecords, loadSessions, project?.id, user?.id]);

  React.useEffect(() => {
    if (open && user && project) void loadPanel();
    return cancelPanelLoad;
  }, [open, user, project, loadPanel, cancelPanelLoad]);

  React.useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void apiGet<AgentMessage[]>(`/agent/sessions/${activeSessionId}/messages`)
      .then((data) => { if (!cancelled) setMessages(data); })
      .catch((reason) => { if (!cancelled) setError(toErrorMessage(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  React.useEffect(() => {
    if (open && !isMobile) window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open, activeSessionId, isMobile]);

  React.useEffect(() => {
    // Select a newly opened result once; manual tab changes must remain selected.
    setTab((current) => {
      if (mailAnalysisId) return 'mail-analysis';
      if (customerAnalysisId) return 'customer-analysis';
      if (customerPreviewId) return 'customer-preview';
      return ['customer-preview', 'customer-analysis', 'mail-analysis'].includes(current) ? 'chat' : current;
    });
  }, [customerAnalysisId, customerPreviewId, mailAnalysisId]);

  React.useEffect(() => {
    if (customerAnalysisId && (context.type !== 'customer' || customerAnalysisCustomerId !== context.resourceId)) clearCustomerAnalysis();
  }, [clearCustomerAnalysis, context, customerAnalysisCustomerId, customerAnalysisId]);

  React.useEffect(() => {
    if (mailAnalysisId && (context.type !== 'mail' || mailAnalysisMailId !== context.resourceId || mailAnalysisDirection !== context.direction)) clearMailAnalysis();
  }, [clearMailAnalysis, context, mailAnalysisDirection, mailAnalysisId, mailAnalysisMailId]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: messages.length || sending ? scrollRef.current.scrollHeight : 0, behavior: 'smooth' });
  }, [messages, sending]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        toggleOpen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleOpen]);

  React.useEffect(() => {
    if (!isMobile || !open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [isMobile, open]);

  useEscapeKey(
    () => setOpen(false),
    open && !selectedActionId && !sessionListOpen && !sessionActionsOpen && !renameOpen && !archiveOpen,
  );

  async function createSession(): Promise<AgentSession> {
    const created = await apiPost<AgentSession>('/agent/sessions', { context });
    setActiveSessionId(created.id);
    setMessages([]);
    return created;
  }

  function openRecordedWorkflow(workflow: AgentRecordedWorkflow) {
    setSelectedActionId(null);
    if (workflow.kind === 'task') {setFocusTaskId(workflow.id);setAutoOpenTaskId(null);setTab('tasks');return;}
    if (workflow.kind === 'customer-analysis' && workflow.context?.type === 'customer') {
      navigate(`/customers/${workflow.context.resourceId}`);
      openCustomerAnalysis(workflow.id, workflow.context.resourceId);
    } else if (workflow.kind === 'mail-analysis' && workflow.context?.type === 'mail') {
      const direction = workflow.context.direction ?? 'inbound';
      navigate(`/mail?id=${workflow.context.resourceId}&direction=${direction}`);
      openMailAnalysis(workflow.id, workflow.context.resourceId, direction);
    } else if (workflow.kind === 'customer-preview') {
      openCustomerPreview(workflow.id);
    }
    // Reopening the same saved result does not change its ID, so select it explicitly.
    setTab(workflow.kind);
  }

  function startNewSession() {
    setActiveSessionId('');
    setMessages([]);
    setError('');
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function showTask(id:string){setFocusTaskId(id);setAutoOpenTaskId(null);setTab('tasks');}
  function showTaskMail(task:AgentTask){if(!task.mailAnalysisId||!task.sourceMailId)return;navigate(`/mail?id=${task.sourceMailId}&direction=inbound`);openMailAnalysis(task.mailAnalysisId,task.sourceMailId,'inbound');}
  function openTaskDraft(task:AgentTask) {
    if(!task.customerId || (!task.draftId && !task.staleDraftId)) return;
    setAutoOpenTaskId(null);
    navigate(`/customers/${task.customerId}?outreachTask=${task.id}`);
    setOpen(false);
  }
  function openPendingDraft(letter: DevelopmentLetter) {
    navigate(`/customers/${letter.customerId}?knowledgeDraft=${letter.id}`);
    setOpen(false);
  }
  function openOutreachComposer(action: NonNullable<AgentMessage['uiAction']>) {
    if (action.kind !== 'compose-first-outreach') return;
    navigate(`/customers/${action.customerId}?composeAnalysis=${action.analysisId}`);
    setOpen(false);
  }

  async function sendMessage(value = draft) {
    const content = value.trim();
    if (!content || sending) return;
    setSending(true);
    setError('');
    setDraft('');
    try {
      const session = activeSessionId ? sessions.find((item) => item.id === activeSessionId) : await createSession();
      if (!session) throw new Error('请选择或新建会话');
      const optimistic: AgentMessage = {
        id: `pending-${Date.now()}`, sessionId: session.id, role: 'user', content, status: 'completed', createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, optimistic]);
      const result = await apiPost<SendResult>(`/agent/sessions/${session.id}/messages`, {
        content,
        idempotencyKey: globalThis.crypto?.randomUUID?.() ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }, { timeout: 180_000 });
      setMessages((current) => [
        ...current.filter((item) => item.id !== optimistic.id && item.id !== result.userMessage.id && item.id !== result.assistantMessage.id),
        result.userMessage,
        result.assistantMessage,
      ]);
      if(result.assistantMessage.batchId)setTab('batches');
      if (result.assistantMessage.taskId) {setAutoOpenTaskId(result.assistantMessage.taskId);setTab('tasks');}
      if (result.assistantMessage.uiAction) openOutreachComposer(result.assistantMessage.uiAction);
      if (result.degraded) toast.warning('当前为降级回复，请核对关键信息后再使用');
      await Promise.all([loadRecords(), loadSessions()]);
    } catch (reason) {
      setMessages((current) => current.filter((item) => !item.id.startsWith('pending-')));
      setDraft(content);
      const message = toErrorMessage(reason, '消息发送失败');
      setError(message.includes('请求超时') ? '助手处理时间较长，本次请求已超时，请稍后重试。' : message);
    } finally {
      setSending(false);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  async function renameActiveSession() {
    const title = renameTitle.trim();
    if (!activeSessionId || !title || sessionSaving) return;
    setSessionSaving(true);
    setError('');
    try {
      await apiPut<AgentSession>(`/agent/sessions/${activeSessionId}`, { title });
      await loadSessions();
      setRenameOpen(false);
      toast.success('会话名称已更新');
    } catch (reason) {
      setError(toErrorMessage(reason, '会话重命名失败'));
    } finally {
      setSessionSaving(false);
    }
  }

  async function archiveActiveSession() {
    if (!activeSessionId || sessionSaving) return;
    setSessionSaving(true);
    setError('');
    try {
      await apiPut<AgentSession>(`/agent/sessions/${activeSessionId}`, { status: 'archived' });
      setSessions((current) => current.filter((item) => item.id !== activeSessionId));
      setArchiveOpen(false);
      startNewSession();
      toast.success('会话已归档');
    } catch (reason) {
      setError(toErrorMessage(reason, '会话归档失败'));
    } finally {
      setSessionSaving(false);
    }
  }

  async function startMailAnalysis(){if(activeContext.type==='mail'&&!sending)await sendMessage('请整理当前询盘并准备回复邮件，不要发送');}

  if (!open || !user || !project) return null;

  return (
    <WorkspaceDrawer
      title="AI 助手"
      onClose={() => setOpen(false)}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col workspace-drawer border-border/70 bg-card shadow-[var(--shadow-pop)] sm:inset-y-3 sm:right-3 sm:w-[min(500px,calc(100vw-1.5rem))] sm:rounded-xl sm:border lg:w-[520px]"
    >
      {/* Calm, Minimal Header */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/80 bg-card px-4">
        <Sparkles className="h-4 w-4 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">AI 助手</h2>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                !status ? 'bg-slate-400' : status.available ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
              aria-hidden
            />
            {!status ? '连接中' : status.mode === 'mock' ? '演示模式' : status.available ? '在线' : '暂不可用'}
          </span>
          <span className="hidden truncate text-[11px] text-muted-foreground/80 sm:inline">
            · {project.name}
          </span>
        </div>
        {(customerPreviewId||customerAnalysisId||mailAnalysisId)&&<DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="查看最近分析"><FileClock className="h-4 w-4 text-muted-foreground" aria-hidden /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {customerPreviewId&&<DropdownMenuItem onSelect={()=>setTab('customer-preview')}>客户预览</DropdownMenuItem>}
            {customerAnalysisId&&<DropdownMenuItem onSelect={()=>setTab('customer-analysis')}>客户分析</DropdownMenuItem>}
            {mailAnalysisId&&<DropdownMenuItem onSelect={()=>setTab('mail-analysis')}>邮件助理</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>}
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={startNewSession} title="开始新对话" aria-label="开始新会话">
          <Plus className="h-4 w-4 text-muted-foreground" />
        </Button>
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => setOpen(false)} aria-label="关闭销售助手">
          <X className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
      {status && !status.available ? (
        <div role="status" className="mx-4 mt-2.5 shrink-0 rounded-lg border border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200">
          AI 助手暂不可用，已有草稿仍可正常查看和发送。
          {user.role === 'admin'
            ? <> 前往<a href="/ai-settings" className="ml-1 font-medium underline underline-offset-2">AI 配置</a>检查连接。</>
            : ' 请联系管理员检查配置。'}
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        {/* Clean Minimal Underline Navigation */}
        <div className="shrink-0 border-b border-border/80 px-4">
          <TabsList aria-label="助手功能" className="flex h-10 w-full justify-start gap-5 rounded-none bg-transparent p-0 [&>button]:relative [&>button]:h-10 [&>button]:rounded-none [&>button]:border-b-2 [&>button]:border-transparent [&>button]:bg-transparent [&>button]:px-0.5 [&>button]:text-xs [&>button]:font-medium [&>button]:text-muted-foreground [&>button]:shadow-none [&>button]:data-[state=active]:border-indigo-600 [&>button]:data-[state=active]:font-semibold [&>button]:data-[state=active]:text-foreground dark:[&>button]:data-[state=active]:border-indigo-400">
            <TabsTrigger value="chat" className="gap-1.5"><MessageSquare className="h-3.5 w-3.5" aria-hidden />对话</TabsTrigger>
            <TabsTrigger value="tasks" className="gap-1.5" onClick={() => { setFocusTaskId(null); setAutoOpenTaskId(null); }}>
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              待办
              {(tasksLoaded||!pendingDrafts.loading) && pendingDrafts.total + taskTodoCount > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-semibold tabular-nums text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                  {pendingDrafts.total + taskTodoCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value={secondaryLabels[tab] ? tab : 'tools'} className="gap-1.5" onClick={() => setTab('tools')}><BriefcaseBusiness className="h-3.5 w-3.5" aria-hidden />工具</TabsTrigger>
          </TabsList>
        </div>

        {/* Compact Single-Line Pending Bar when inside an active conversation */}
        {tab === 'chat' && messages.length > 0 && (hasPendingWork || pendingDrafts.error) && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 bg-surface/50 px-4 py-2 text-xs">
            <span className="min-w-0 truncate text-muted-foreground">
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle" aria-hidden />
              {workSummary || '待审核草稿暂未更新'}
            </span>
            <button
              type="button"
              onClick={() => { setTab('tasks'); if (pendingDrafts.error) pendingDrafts.refresh(); }}
              className="shrink-0 font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            >
              去待办 →
            </button>
          </div>
        )}
        {secondaryLabels[tab] && <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
          <Button variant="ghost" className="min-h-9 px-2 text-xs text-muted-foreground" onClick={() => setTab(['customer-preview','customer-analysis','mail-analysis'].includes(tab) ? 'chat' : 'tools')}><ArrowLeft className="h-3.5 w-3.5" aria-hidden />返回{['customer-preview','customer-analysis','mail-analysis'].includes(tab) ? '对话' : '工具'}</Button>
          <span className="text-xs font-semibold">{secondaryLabels[tab]}</span>
        </div>}

        <TabsContent value="tools" className="m-0 min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="divide-y divide-border/60">
            {[
              { value: 'inbox', label: '来信与提醒', description: '查看客户来信、到期跟进与自动准备', icon: Inbox, accent: 'text-indigo-600 dark:text-indigo-400' },
              { value: 'batches', label: '批量写信', description: '批量选择客户并逐一准备开发信', icon: Layers3, accent: 'text-sky-600 dark:text-sky-400' },
              { value: 'knowledge', label: '项目知识库', description: '查阅产品资料、对外口径与客户附件', icon: BookOpen, accent: 'text-teal-600 dark:text-teal-400' },
              { value: 'records', label: '操作记录', description: '回看历史查询、草稿与确认结果', icon: FileClock, accent: 'text-violet-600 dark:text-violet-400' },
            ].map(item => <button type="button" key={item.value} onClick={() => setTab(item.value)} className="group flex w-full items-center gap-3 py-3.5 text-left transition-colors hover:bg-surface/60 focus-visible:outline-none">
              <item.icon className={`h-4 w-4 shrink-0 ${item.accent}`} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{item.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{item.description}</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </button>)}
          </div>
        </TabsContent>

        <TabsContent value="chat" className="m-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0">
          {(activeSession || activeSessionId || sessions.length > 0) && <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-4 py-1.5">
            <DropdownMenu open={sessionListOpen} onOpenChange={setSessionListOpen}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" className="h-8 min-w-0 flex-1 justify-between gap-2 px-1.5 text-left" aria-label="选择会话">
                  <span className="truncate text-xs font-medium text-foreground/90">{activeSession?.title ?? '新对话'}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-[min(400px,calc(100vw-2rem))] overflow-y-auto">
                <DropdownMenuItem className="min-h-10" onSelect={startNewSession}>
                  <Plus className="h-4 w-4 text-indigo-600" aria-hidden />
                  <span><span className="block font-medium">开始新会话</span><span className="block text-xs text-muted-foreground">发送第一条问题后自动保存</span></span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>最近会话</DropdownMenuLabel>
                {sessions.length === 0 && <DropdownMenuItem disabled className="min-h-10">还没有已保存的会话</DropdownMenuItem>}
                {sessions.map((session) => (
                  <DropdownMenuItem key={session.id} className="min-h-12 items-start py-2" onSelect={() => setActiveSessionId(session.id)}>
                    {session.id === activeSessionId ? <Check className="mt-0.5 h-4 w-4 text-indigo-600" aria-hidden /> : <span className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" title={session.title}>{session.title}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="min-w-0 truncate">{sessionContextLabel(session)}</span>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">{formatRelative(session.lastMessageAt ?? session.updatedAt)}</span>
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {activeSession ? (
              <DropdownMenu open={sessionActionsOpen} onOpenChange={setSessionActionsOpen}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" aria-label="当前会话操作">
                    <MoreHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-36">
                  <DropdownMenuItem onSelect={() => { setRenameTitle(activeSession?.title ?? ''); setRenameOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden />重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setArchiveOpen(true)}>
                    <Archive className="h-3.5 w-3.5" aria-hidden />归档会话
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>}

          {activeContext.type === 'customer' && (
            <div aria-label="当前会话客户" className="flex shrink-0 items-center gap-2.5 border-b border-border/60 bg-surface/40 px-4 py-2 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" aria-hidden />
              <span className="truncate font-semibold text-foreground">{currentCustomer?.company || currentCustomer?.name || activeSession?.contextName || '客户资料'}</span>
              {currentCustomer ? (
                <span className="truncate text-muted-foreground">
                  {[currentCustomer.country, CUSTOMER_STATUS_LABEL[currentCustomer.status]].filter(Boolean).join(' · ')}
                </span>
              ) : null}
            </div>
          )}

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto px-5 py-5" aria-live="polite" aria-busy={loading || sending}>
            {loading && messages.length === 0 && <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载会话…</div>}

            {/* Clean, Minimal, Card-Free Empty State */}
            {!loading && messages.length === 0 && (
              <div className="flex min-h-full flex-col justify-between py-2">
                <div className="space-y-6">
                  <div className="space-y-1.5 pt-2">
                    <p className="text-base font-semibold tracking-tight text-foreground">
                      {activeContext.type === 'customer'
                        ? '这位客户，想从哪里推进？'
                        : activeContext.type === 'mail'
                          ? '一起处理这封来信'
                          : '有什么可以帮你？'}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {activeContext.type === 'customer'
                        ? '结合客户档案、官网与历史往来起草邮件或梳理策略。'
                        : activeContext.type === 'mail'
                          ? '提炼客户诉求、对照口径并准备回复草稿。'
                          : '直接问我客户跟进、开发信撰写、知识库口径或业绩分析。'}
                    </p>
                  </div>

                  {/* Single Compact Pending Strip (No Multi-Card Stacking!) */}
                  {hasPendingWork && (
                    <button
                      type="button"
                      onClick={() => setTab('tasks')}
                      className="group flex w-full items-center justify-between gap-3 rounded-xl bg-amber-50/75 px-3.5 py-2.5 text-left text-xs transition-colors hover:bg-amber-50 dark:bg-amber-500/10 dark:hover:bg-amber-500/15"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
                        <span className="truncate font-medium text-amber-950 dark:text-amber-100">{workSummary}</span>
                      </span>
                      <span className="shrink-0 font-medium text-amber-700 group-hover:underline dark:text-amber-300">
                        去处理 →
                      </span>
                    </button>
                  )}

                  {/* Contextual One-Click Action for Customer / Mail */}
                  {activeContext.type === 'customer' && (
                    <Button type="button" size="sm" className="gap-2" onClick={() => void sendMessage('请分析这个客户，结合官网与历史往来准备合适的邮件，不要发送')} disabled={sending}>
                      <Send className="h-3.5 w-3.5" aria-hidden />分析客户并准备邮件
                    </Button>
                  )}
                  {activeContext.type === 'mail' && (
                    <Button type="button" size="sm" className="gap-2" onClick={() => void startMailAnalysis()} disabled={analyzing}>
                      {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MailSearch className="h-3.5 w-3.5" />}整理来信并准备回复
                    </Button>
                  )}

                  {/* Minimal Hairline Prompt Suggestions (Zero Boxed Cards) */}
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-muted-foreground">快捷提问</p>
                    <div className="divide-y divide-border/55">
                      {suggestions(activeContext)
                        .filter(item => activeContext.type !== 'customer' || !item.includes('第一封'))
                        .map(item => (
                          <button
                            key={item}
                            type="button"
                            disabled={sending}
                            onClick={() => void sendMessage(item)}
                            className="group -mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left text-[0.8125rem] text-foreground/90 transition-colors hover:bg-surface disabled:opacity-50"
                          >
                            <span>{item}</span>
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden />
                          </button>
                        ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Clean Editorial Message Stream */}
            {messages.map((message) => (
              <article
                key={message.id}
                className={
                  message.role === 'user'
                    ? 'ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm text-primary-foreground'
                    : `min-w-0 text-sm ${message.status === 'failed' ? 'rounded-xl border border-amber-500/40 bg-amber-500/5 px-3.5 py-3' : 'py-0.5'}`
                }
              >
                {message.role === 'assistant' && (
                  <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                    <Sparkles className="h-3 w-3 text-indigo-500" aria-hidden />
                    AI 助手 · 请核对关键信息
                  </p>
                )}
                {message.role === 'assistant' ? <AgentMessageContent content={message.content} /> : <p className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</p>}
                {message.batchId&&<Button variant="outline" size="sm" className="mt-3" onClick={()=>setTab('batches')}>查看批量计划</Button>}
                {message.taskId && <Button variant="outline" size="sm" className="mt-3" onClick={()=>showTask(message.taskId!)}>查看任务进度</Button>}
                {message.role === 'assistant' && message.uiAction && <Button type="button" size="sm" className="mt-3" onClick={() => openOutreachComposer(message.uiAction!)}>打开首封开发信</Button>}
              </article>
            ))}
            {sending && (
              <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />
                正在读取资料并分析…
              </div>
            )}
          </div>

          {error && <p role="alert" className="mx-4 mb-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
          <form className="shrink-0 border-t border-border/80 bg-card px-4 py-3" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
            <label htmlFor="agent-message" className="sr-only">向 AI 助手提问</label>
            <div className="rounded-2xl border border-border/90 bg-surface/45 px-3 py-2.5 transition-colors focus-within:border-indigo-500/45 focus-within:bg-card">
              <Textarea
                ref={textareaRef}
                id="agent-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
                maxLength={8000}
                rows={2}
                disabled={sending}
                placeholder={activeContext.type === 'customer' ? '例如：结合客户需求，准备一封英文跟进信…' : '输入问题或任务指令…'}
                className="min-h-10 max-h-32 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">Enter 发送 · 邮件均需人工确认</span>
                <Button type="submit" size="icon" className="h-7 w-7 shrink-0 rounded-lg" disabled={!draft.trim() || sending} aria-label="发送消息">
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </form>
        </TabsContent>

        {customerPreviewId && <TabsContent forceMount value="customer-preview" className="m-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"><ScratchpadCustomerPreviewView previewId={customerPreviewId} onRecordsChanged={loadRecords} /></TabsContent>}
        {customerAnalysisId && <TabsContent forceMount value="customer-analysis" className="m-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"><CustomerAnalysisView analysisId={customerAnalysisId} onRecordsChanged={loadRecords} /></TabsContent>}
        {mailAnalysisId && <TabsContent forceMount value="mail-analysis" className="m-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"><MailThreadAnalysisView analysisId={mailAnalysisId} onRecordsChanged={loadRecords} /></TabsContent>}

        <TabsContent value="inbox" className="m-0 flex min-h-0 flex-1 flex-col"><AgentEventInbox key={`${project.id}:${user.id}`} onTask={showTask}/></TabsContent>
        <TabsContent value="batches" className="m-0 flex min-h-0 flex-1 flex-col"><AgentBatches key={`${project.id}:${user.id}`} selectedIds={selectedBatchIds} onClearSelection={clearBatchSelection} onTask={showTask} onDraft={openTaskDraft}/></TabsContent>
        <TabsContent value="knowledge" className="m-0 flex min-h-0 flex-1 flex-col"><AgentKnowledge key={`${project.id}:${user.id}`} admin={user.role==='admin'} customerId={context.type==='customer'?context.resourceId:undefined}/></TabsContent>
        <TabsContent value="tasks" className="m-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"><AgentTasks drafts={<PendingDrafts feed={pendingDrafts} onOpenDraft={openPendingDraft}/>} key={`${project.id}:${user.id}`} tasks={workflowTasks} loaded={tasksLoaded} loadError={tasksError} onTaskUpdated={updated => setWorkflowTasks(rows => rows.map(task => task.id === updated.id ? updated : task))} autoOpenTaskId={autoOpenTaskId} onOpenDraft={openTaskDraft} onMailAnalysis={showTaskMail} focusTaskId={focusTaskId}/></TabsContent>

        <TabsContent value="records" className="m-0 min-h-0 flex-1 overflow-y-auto p-4 focus-visible:ring-0">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">处理次数</p><p className="mt-1 text-xl font-semibold tabular-nums">{usage.runs}</p></div>
            <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">已完成</p><p className="mt-1 text-xl font-semibold tabular-nums">{usage.completed}</p></div>
          </div>
          <div className="mt-5 flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">操作与确认记录</h3><Button type="button" variant="outline" size="sm" onClick={() => { setRecordsError(''); void loadRecords().catch((reason) => setRecordsError(toErrorMessage(reason, '运行记录加载失败'))); }}>刷新记录</Button></div>
          {recordsError && <p role="alert" className="mt-3 text-sm text-destructive">{recordsError}</p>}
          <div className="mt-3 space-y-2">
            {actions.length === 0 && <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">还没有操作记录</div>}
            {actions.map((action) => (
              <button key={action.id} type="button" onClick={() => setSelectedActionId(action.id)} aria-label={`查看记录：${actionLabel(action.toolName)}`} className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="flex items-start justify-between gap-3"><p className="text-sm font-medium">{actionLabel(action.toolName)}</p><Badge variant={action.executionStatus === 'succeeded' ? 'developed' : action.executionStatus === 'failed' ? 'failed' : 'muted'}>{action.executionStatus === 'succeeded' ? '成功' : action.executionStatus === 'failed' ? '失败' : action.executionStatus === 'rejected' ? '已取消' : '处理中'}</Badge></div>
                <p className="mt-1 text-xs text-muted-foreground">{action.resultSummary || '等待执行'} · {action.approvalStatus === 'not_required' ? action.riskLevel === 'read' ? '资料查询' : '已委托处理' : action.approvalStatus === 'approved' ? '用户已确认' : '用户已取消'}</p>
                <p className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground"><span className="flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatDateTime(action.createdAt)}</span><span className="flex items-center gap-1">查看详情<ChevronRight className="h-3 w-3" /></span></p>
              </button>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      <AgentActionDetail actionId={selectedActionId} label={actionLabel(actions.find((action) => action.id === selectedActionId)?.toolName ?? '')} onClose={() => setSelectedActionId(null)} onOpenWorkflow={openRecordedWorkflow} />

      <Dialog open={renameOpen} onOpenChange={(next) => { if (!sessionSaving) setRenameOpen(next); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>使用客户、任务或邮件主题命名，之后会更容易找到。</DialogDescription>
          </DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void renameActiveSession(); }}>
            <label htmlFor="agent-session-title" className="mb-1.5 block text-sm font-medium">会话名称</label>
            <Input id="agent-session-title" value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} maxLength={80} autoFocus disabled={sessionSaving} />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenameOpen(false)} disabled={sessionSaving}>取消</Button>
              <Button type="submit" disabled={!renameTitle.trim() || sessionSaving}>{sessionSaving && <Loader2 className="h-4 w-4 animate-spin" />}保存名称</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveOpen} onOpenChange={(next) => { if (!sessionSaving) setArchiveOpen(next); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>归档这个会话？</AlertDialogTitle>
            <AlertDialogDescription>“{activeSession?.title ?? '当前会话'}”会从最近会话列表中移除，CRM 客户、邮件和业务数据不会受到影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sessionSaving}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={sessionSaving} onClick={(event) => { event.preventDefault(); void archiveActiveSession(); }}>
              {sessionSaving && <Loader2 className="h-4 w-4 animate-spin" />}确认归档
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </WorkspaceDrawer>
  );
}
