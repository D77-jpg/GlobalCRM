import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCheck,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Languages,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  Star,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiGet, apiPatch, apiPost, apiPut, toErrorMessage } from '@/lib/api';
import { downloadFile } from '@/lib/download';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectCanManageProjects, useAuthStore } from '@/store/auth.store';
import { useProjectStore } from '@/store/project.store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MailCopilotPane } from '@/components/workbench/mail-copilot-pane';
import { CustomerWorkbenchSidebar } from '@/components/workbench/customer-workbench-sidebar';
import type {
  ChannelConfigDto,
  ChannelConversationDetailDto,
  ChannelConversationDto,
  ChannelMessageDto,
  ConversationStatus,
  Customer,
  OmnichannelType,
} from '@/types';

const CHANNEL_META: Record<OmnichannelType, { label: string; short: string; badgeClass: string }> = {
  whatsapp: { label: 'WhatsApp', short: 'WA', badgeClass: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-300' },
  alibaba: { label: 'Alibaba', short: '阿里', badgeClass: 'bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-300' },
  instagram: { label: 'Instagram', short: 'IG', badgeClass: 'bg-pink-500/15 text-pink-700 border-pink-500/30 dark:text-pink-300' },
  trademanager: { label: 'TradeManager', short: '旺旺', badgeClass: 'bg-sky-500/15 text-sky-700 border-sky-500/30 dark:text-sky-300' },
  wechat: { label: '微信', short: '微信', badgeClass: 'bg-green-500/15 text-green-700 border-green-500/30 dark:text-green-300' },
  web_chat: { label: '在线客服', short: '网站', badgeClass: 'bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-300' },
};

const STATUS_LABELS: Record<ConversationStatus, string> = {
  open: '沟通中',
  pending_followup: '待跟进',
  resolved: '已解决',
  archived: '已归档',
};

const DELIVERY_LABELS: Record<ChannelMessageDto['deliveryStatus'], string> = {
  received: '已收到',
  logged_manual: '已记档',
  sent_api: 'API 已发',
  delivered: '已送达',
  read: '已读',
  failed: '发送失败',
};

function initialsOf(name: string): string {
  const s = (name || '?').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && /^[A-Za-z]/.test(words[0])) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return s.slice(0, 2).toUpperCase();
}

function toCopilotChannel(ch?: OmnichannelType): 'whatsapp' | 'alibaba' | 'trademanager' | 'instagram' | 'web' | 'chat' {
  if (ch === 'whatsapp' || ch === 'alibaba' || ch === 'trademanager' || ch === 'instagram') return ch;
  if (ch === 'web_chat') return 'web';
  return 'chat';
}

export function ChannelsPage(): React.JSX.Element {
  const canManage = useAuthStore(selectCanManageProjects);
  const activeProjectId = useProjectStore((s) => s.activeProject?.id);

  const [items, setItems] = React.useState<ChannelConversationDto[]>([]);
  const [stats, setStats] = React.useState({
    todayMessages: 0,
    activeConversations: 0,
    unreadTotal: 0,
    pendingFollowup: 0,
    starredCount: 0,
    whatsappConnected: false,
  });
  const [listLoading, setListLoading] = React.useState(false);

  const [channelFilter, setChannelFilter] = React.useState<'all' | OmnichannelType>('all');
  const [tab, setTab] = React.useState<'all' | 'unread' | 'followup' | 'starred'>('all');
  const [search, setSearch] = React.useState('');

  const [selectedId, setSelectedId] = React.useState<string>('');
  const [detail, setDetail] = React.useState<ChannelConversationDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [centerTab, setCenterTab] = React.useState<'chat' | 'customer' | 'quotations' | 'items'>('chat');
  const [copilotOpen, setCopilotOpen] = React.useState(true);

  // Composer state
  const [composerDirection, setComposerDirection] = React.useState<'outbound' | 'inbound'>('outbound');
  const [composerText, setComposerText] = React.useState('');
  const [composerZh, setComposerZh] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [translatingMsgId, setTranslatingMsgId] = React.useState<string>('');
  const messagesEndRef = React.useRef<HTMLDivElement | null>(null);

  // New conversation dialog
  const [newOpen, setNewOpen] = React.useState(false);
  const [newChannel, setNewChannel] = React.useState<OmnichannelType>('whatsapp');
  const [newCustomerId, setNewCustomerId] = React.useState('');
  const [newName, setNewName] = React.useState('');
  const [newCompany, setNewCompany] = React.useState('');
  const [newCountry, setNewCountry] = React.useState('');
  const [newPhone, setNewPhone] = React.useState('');
  const [newEmail, setNewEmail] = React.useState('');
  const [newFirstMessage, setNewFirstMessage] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [customers, setCustomers] = React.useState<Customer[]>([]);

  // WhatsApp Cloud API config dialog
  const [cfgOpen, setCfgOpen] = React.useState(false);
  const [cfg, setCfg] = React.useState<ChannelConfigDto | null>(null);
  const [cfgEnabled, setCfgEnabled] = React.useState(false);
  const [cfgPhoneId, setCfgPhoneId] = React.useState('');
  const [cfgWabaId, setCfgWabaId] = React.useState('');
  const [cfgDisplayPhone, setCfgDisplayPhone] = React.useState('');
  const [cfgAccessToken, setCfgAccessToken] = React.useState('');
  const [cfgAppSecret, setCfgAppSecret] = React.useState('');
  const [cfgVerifyToken, setCfgVerifyToken] = React.useState('');
  const [savingCfg, setSavingCfg] = React.useState(false);

  const loadList = React.useCallback(async () => {
    setListLoading(true);
    try {
      const qs = new URLSearchParams();
      if (channelFilter !== 'all') qs.set('channel', channelFilter);
      if (tab !== 'all') qs.set('tab', tab);
      if (search.trim()) qs.set('search', search.trim());
      const res = await apiGet<{
        items: ChannelConversationDto[];
        stats: typeof stats;
      }>(`/channels/conversations?${qs.toString()}`);
      setItems(res.items);
      setStats(res.stats);
      setSelectedId((prev) => (prev && res.items.some((x) => x.id === prev) ? prev : res.items[0]?.id || ''));
    } catch (e) {
      toast.error(toErrorMessage(e, '加载会话列表失败'));
    } finally {
      setListLoading(false);
    }
  }, [channelFilter, tab, search]);

  const loadDetail = React.useCallback(async (id: string) => {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    try {
      const res = await apiGet<ChannelConversationDetailDto>(`/channels/conversations/${id}`);
      setDetail(res);
    } catch (e) {
      toast.error(toErrorMessage(e, '加载会话详情失败'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadConfig = React.useCallback(async () => {
    try {
      const res = await apiGet<ChannelConfigDto>('/channels/config');
      setCfg(res);
      setCfgEnabled(res.whatsappEnabled);
      setCfgPhoneId(res.phoneNumberId);
      setCfgWabaId(res.businessAccountId);
      setCfgDisplayPhone(res.displayPhoneNumber);
      setCfgAccessToken('');
      setCfgAppSecret('');
      setCfgVerifyToken('');
    } catch {
      // non-fatal
    }
  }, []);

  React.useEffect(() => {
    setSelectedId('');
    setDetail(null);
    void loadList();
    void loadConfig();
  }, [activeProjectId, loadList, loadConfig]);

  React.useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  React.useEffect(() => {
    if (centerTab === 'chat') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [detail?.messages.length, centerTab]);

  const openNewDialog = async () => {
    setNewOpen(true);
    if (customers.length === 0) {
      try {
        const res = await apiGet<{ items: Customer[] }>('/customers?page=1&limit=100');
        setCustomers(res.items ?? []);
      } catch {
        // optional
      }
    }
  };

  const handleSelectCustomerForNew = (cid: string) => {
    setNewCustomerId(cid);
    const found = customers.find((c) => c.id === cid);
    if (found) {
      setNewName(found.name);
      setNewCompany(found.company || '');
      setNewCountry(found.country || '');
      setNewPhone(found.phone || '');
      setNewEmail(found.email || '');
    }
  };

  const submitNewConversation = async () => {
    if (!newName.trim() && !newCustomerId) {
      toast.error('请填写联系人姓名或选择已有客户');
      return;
    }
    setCreating(true);
    try {
      const res = await apiPost<{ conversation: ChannelConversationDto }>('/channels/conversations', {
        channel: newChannel,
        customerId: newCustomerId || undefined,
        contactName: newName.trim() || undefined,
        contactCompany: newCompany.trim() || undefined,
        contactCountry: newCountry.trim() || undefined,
        contactPhone: newPhone.trim() || undefined,
        contactEmail: newEmail.trim() || undefined,
        initialInboundText: newFirstMessage.trim() || undefined,
      });
      toast.success('会话已创建');
      setNewOpen(false);
      setNewCustomerId('');
      setNewName('');
      setNewCompany('');
      setNewCountry('');
      setNewPhone('');
      setNewEmail('');
      setNewFirstMessage('');
      await loadList();
      setSelectedId(res.conversation.id);
      await loadDetail(res.conversation.id);
    } catch (e) {
      toast.error(toErrorMessage(e, '创建会话失败'));
    } finally {
      setCreating(false);
    }
  };

  const submitMessage = async (opts: { sendViaApi?: boolean; copyAfter?: boolean }) => {
    if (!detail) return;
    const text = composerText.trim();
    if (!text) {
      toast.error('请先输入消息内容');
      return;
    }
    setSending(true);
    try {
      const res = await apiPost<{ message: ChannelMessageDto; apiDelivered: boolean; apiError?: string }>(
        `/channels/conversations/${detail.conversation.id}/messages`,
        {
          direction: composerDirection,
          text,
          zhTranslation: composerZh.trim() || undefined,
          sendViaApi: opts.sendViaApi,
          autoTranslate: true,
        },
      );
      if (opts.copyAfter && composerDirection === 'outbound') {
        await navigator.clipboard.writeText(text).catch(() => undefined);
      }
      if (res.apiError) {
        toast.error(`API 发送失败：${res.apiError}`);
      } else if (res.apiDelivered) {
        toast.success('已通过 WhatsApp Cloud API 发出并同步至客户时间线');
      } else if (composerDirection === 'outbound') {
        toast.success(opts.copyAfter ? '已复制英文回复并记录到会话与客户时间线' : '已记录回复到会话');
      } else {
        toast.success('已录入客户消息并自动翻译');
      }
      setComposerText('');
      setComposerZh('');
      await loadDetail(detail.conversation.id);
      void loadList();
    } catch (e) {
      toast.error(toErrorMessage(e, '发送失败'));
    } finally {
      setSending(false);
    }
  };

  const translateBubble = async (msgId: string) => {
    setTranslatingMsgId(msgId);
    try {
      const updated = await apiPost<ChannelMessageDto>(`/channels/messages/${msgId}/translate`, {});
      setDetail((prev) => (prev ? {
        ...prev,
        messages: prev.messages.map((m) => (m.id === updated.id ? updated : m)),
      } : prev));
    } catch (e) {
      toast.error(toErrorMessage(e, '翻译失败'));
    } finally {
      setTranslatingMsgId('');
    }
  };

  const patchConv = async (patch: Record<string, unknown>) => {
    if (!detail) return;
    try {
      const updated = await apiPatch<ChannelConversationDto>(`/channels/conversations/${detail.conversation.id}`, patch);
      setDetail((prev) => (prev ? { ...prev, conversation: updated } : prev));
      setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
    } catch (e) {
      toast.error(toErrorMessage(e));
    }
  };

  const convertToCustomer = async () => {
    if (!detail) return;
    try {
      await apiPost(`/channels/conversations/${detail.conversation.id}/create-customer`, {});
      toast.success('已创建 CRM 客户并自动关联此会话');
      await loadDetail(detail.conversation.id);
      void loadList();
    } catch (e) {
      toast.error(toErrorMessage(e, '转为客户失败'));
    }
  };

  const saveConfig = async () => {
    setSavingCfg(true);
    try {
      const updated = await apiPut<ChannelConfigDto>('/channels/config', {
        whatsappEnabled: cfgEnabled,
        phoneNumberId: cfgPhoneId.trim(),
        businessAccountId: cfgWabaId.trim(),
        displayPhoneNumber: cfgDisplayPhone.trim(),
        accessToken: cfgAccessToken.trim() || undefined,
        appSecret: cfgAppSecret.trim() || undefined,
        verifyToken: cfgVerifyToken.trim() || undefined,
      });
      setCfg(updated);
      setCfgAccessToken('');
      setCfgAppSecret('');
      setCfgVerifyToken('');
      toast.success('WhatsApp Cloud API 配置已加密保存');
      setCfgOpen(false);
      void loadList();
    } catch (e) {
      toast.error(toErrorMessage(e, '保存配置失败'));
    } finally {
      setSavingCfg(false);
    }
  };

  const latestInbound = React.useMemo(() => {
    if (!detail) return '';
    const inboundMsgs = detail.messages.filter((m) => m.direction === 'inbound');
    return inboundMsgs[inboundMsgs.length - 1]?.text || detail.messages[detail.messages.length - 1]?.text || '';
  }, [detail]);

  const chatTranscript = React.useMemo(() => {
    if (!detail) return '';
    return detail.messages
      .slice(-20)
      .map((m) => `${m.direction === 'inbound' ? 'Buyer' : 'Us'}: ${m.text}`)
      .join('\n\n');
  }, [detail]);

  const canSendLiveWhatsApp = Boolean(
    detail && detail.conversation.channel === 'whatsapp' && stats.whatsappConnected,
  );

  const fullWebhookUrl = typeof window !== 'undefined' && cfg
    ? `${window.location.origin}${cfg.webhookPath}`
    : cfg?.webhookPath || '';

  return (
    <div className="flex h-[calc(100vh-4.5rem)] min-h-[620px] flex-col gap-3 overflow-hidden">
      {/* Top Header + KPI Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <MessageSquare className="h-5 w-5 text-primary" />
            全渠道客服 · WhatsApp 工作台
          </h1>
          <p className="text-xs text-muted-foreground">
            统一管理 WhatsApp / Alibaba / Instagram / 微信会话，行内双语对照、常驻 AI 副驾驶与客户 360° 时间线沉淀。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="hidden items-center gap-2 text-xs lg:flex">
            <div className="rounded-md border border-border bg-card px-2.5 py-1">
              <span className="text-muted-foreground">今日消息 </span>
              <span className="font-semibold tabular-nums">{stats.todayMessages}</span>
            </div>
            <div className="rounded-md border border-border bg-card px-2.5 py-1">
              <span className="text-muted-foreground">在谈会话 </span>
              <span className="font-semibold tabular-nums">{stats.activeConversations}</span>
            </div>
            <div className="rounded-md border border-border bg-card px-2.5 py-1">
              <span className="text-muted-foreground">未读 </span>
              <span className="font-semibold tabular-nums text-primary">{stats.unreadTotal}</span>
            </div>
            <div className="rounded-md border border-border bg-card px-2.5 py-1">
              <span className="text-muted-foreground">待跟进 </span>
              <span className="font-semibold tabular-nums text-amber-600 dark:text-amber-400">{stats.pendingFollowup}</span>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => (canManage ? setCfgOpen(true) : toast.info('请联系管理员配置 WhatsApp Cloud API'))}
          >
            {stats.whatsappConnected ? (
              <><Wifi className="h-3.5 w-3.5 text-emerald-600" />WhatsApp API 已连接</>
            ) : (
              <><WifiOff className="h-3.5 w-3.5 text-muted-foreground" />半自动协同 · 配置官方 API</>
            )}
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCopilotOpen((v) => !v)}>
            <Sparkles className="h-3.5 w-3.5" />{copilotOpen ? '收起副驾驶' : 'AI 副驾驶'}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => void loadList()} disabled={listLoading} aria-label="刷新会话">
            <RefreshCw className={cn('h-3.5 w-3.5', listLoading && 'animate-spin')} />
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => void openNewDialog()}>
            <MessageSquarePlus className="h-3.5 w-3.5" />新建会话 / 录入询盘
          </Button>
        </div>
      </div>

      {/* 3-Pane Split Workspace */}
      <div className={cn(
        'grid min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card',
        copilotOpen ? 'grid-cols-1 xl:grid-cols-[290px_minmax(0,1fr)_385px]' : 'grid-cols-1 lg:grid-cols-[290px_minmax(0,1fr)]',
      )}>
        {/* LEFT PANE: Conversation List */}
        <aside className="flex min-h-0 flex-col border-b border-border xl:border-b-0 xl:border-r">
          <div className="space-y-2 border-b border-border p-2.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索客户、手机号、标签、内容…"
                className="h-8 pl-8 text-xs"
              />
            </div>

            <div className="flex flex-wrap gap-1">
              {([['all', '全部'], ['whatsapp', 'WhatsApp'], ['alibaba', '阿里'], ['instagram', 'IG'], ['wechat', '微信'], ['trademanager', '旺旺']] as const).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setChannelFilter(val)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    channelFilter === val
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-4 gap-1 rounded-md bg-muted/40 p-0.5 text-[11px]">
              {([
                ['all', `全部 ${stats.activeConversations}`],
                ['unread', `未读 ${stats.unreadTotal}`],
                ['followup', `待跟进 ${stats.pendingFollowup}`],
                ['starred', `重点 ${stats.starredCount}`],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={cn(
                    'rounded py-1 text-center transition-colors',
                    tab === key ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border/60">
            {listLoading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />加载会话…
              </div>
            ) : items.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                <p className="font-medium text-foreground">暂无会话</p>
                <p className="mt-1 leading-relaxed">
                  点右上角「新建会话 / 录入询盘」开始记录 WhatsApp、阿里或 IG 客户对话，或配置 Meta 官方 API 自动接收。
                </p>
                <Button size="sm" variant="outline" className="mt-3 h-7 text-xs" onClick={() => void openNewDialog()}>
                  <MessageSquarePlus className="h-3.5 w-3.5" />新建第一条会话
                </Button>
              </div>
            ) : (
              items.map((conv) => {
                const meta = CHANNEL_META[conv.channel];
                const active = conv.id === selectedId;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => setSelectedId(conv.id)}
                    className={cn(
                      'flex w-full items-start gap-2.5 p-3 text-left transition-colors hover:bg-muted/40',
                      active && 'bg-primary/5 ring-1 ring-inset ring-primary/30',
                    )}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {initialsOf(conv.contactName)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-xs font-semibold text-foreground">{conv.contactName}</span>
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {formatDateTime(conv.lastMessageAt).slice(5, 16)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {conv.lastMessageDirection === 'outbound' ? '我：' : ''}{conv.lastMessagePreview || '（无消息）'}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className={cn('rounded border px-1.5 py-0 text-[9px] font-medium', meta.badgeClass)}>
                          {meta.short}
                        </span>
                        {conv.contactCountry ? (
                          <span className="rounded bg-muted px-1.5 py-0 text-[9px] text-muted-foreground">{conv.contactCountry}</span>
                        ) : null}
                        {conv.starred ? <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> : null}
                        {conv.unreadCount > 0 ? (
                          <span className="ml-auto rounded-full bg-primary px-1.5 py-0 text-[10px] font-semibold text-primary-foreground tabular-nums">
                            {conv.unreadCount}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* CENTER PANE: Bilingual Chat + Customer / Quotes / Open Items Tabs */}
        <section className="flex min-h-0 flex-col overflow-hidden xl:border-r xl:border-border">
          {!detail ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <MessageSquare className="h-10 w-10 opacity-30" />
              <p className="mt-3 text-sm font-medium text-foreground">选择一个会话开始回复</p>
              <p className="mt-1 max-w-md text-xs leading-relaxed">
                支持 WhatsApp / Alibaba / Instagram / 微信等多渠道客户聊天沉淀，自动行内双语对照，并直接联动右侧 AI 副驾驶、产品目录与报价单。
              </p>
            </div>
          ) : (
            <>
              {/* Conversation Header */}
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                    {initialsOf(detail.conversation.contactName)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <h2 className="truncate text-sm font-semibold">{detail.conversation.contactName}</h2>
                      <button
                        type="button"
                        onClick={() => void patchConv({ starred: !detail.conversation.starred })}
                        className="text-muted-foreground hover:text-amber-500"
                        title="标记重点"
                      >
                        <Star className={cn('h-3.5 w-3.5', detail.conversation.starred && 'fill-amber-400 text-amber-400')} />
                      </button>
                      <span className={cn('rounded border px-1.5 py-0 text-[10px] font-medium', CHANNEL_META[detail.conversation.channel].badgeClass)}>
                        {CHANNEL_META[detail.conversation.channel].label}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {[detail.conversation.contactCompany, detail.conversation.contactCountry, detail.conversation.contactPhone || detail.conversation.contactEmail]
                        .filter(Boolean)
                        .join(' · ') || detail.conversation.externalContactId}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Select
                    value={detail.conversation.status}
                    onValueChange={(v) => void patchConv({ status: v as ConversationStatus })}
                  >
                    <SelectTrigger className="h-7 w-[96px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(STATUS_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {detail.customer ? (
                    <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                      <Link to={`/customers/${detail.customer.id}`}>
                        <ExternalLink className="h-3 w-3" />360° 档案
                      </Link>
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void convertToCustomer()}>
                      <UserPlus className="h-3 w-3" />转为 CRM 客户
                    </Button>
                  )}
                </div>
              </div>

              {/* Sub-tabs */}
              <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-4 py-1.5 text-xs">
                {([
                  ['chat', `聊天对话 (${detail.messages.length})`],
                  ['customer', '客户档案'],
                  ['quotations', `报价单 (${detail.quotations.length})`],
                  ['items', `未解决问题 (${detail.openItemsCount})`],
                ] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCenterTab(key)}
                    className={cn(
                      'rounded-md px-2.5 py-1 transition-colors',
                      centerTab === key
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {detailLoading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />加载消息…
                </div>
              ) : centerTab === 'chat' ? (
                <>
                  {/* Bilingual Chat Bubble Stream */}
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-muted/15 p-4">
                    {detail.messages.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                        暂无聊天记录。可在下方切到「录入客户新消息」粘贴买家的 WhatsApp / 阿里 / IG 原话。
                      </div>
                    ) : (
                      detail.messages.map((msg) => {
                        const isOut = msg.direction === 'outbound';
                        return (
                          <div key={msg.id} className={cn('flex flex-col', isOut ? 'items-end' : 'items-start')}>
                            <div className={cn(
                              'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs shadow-sm',
                              isOut
                                ? 'rounded-br-sm bg-primary text-primary-foreground'
                                : 'rounded-bl-sm border border-border bg-card text-foreground',
                            )}>
                              <p className="whitespace-pre-wrap break-words leading-relaxed">{msg.text}</p>
                              {msg.zhTranslation ? (
                                <div className={cn(
                                  'mt-2 border-t pt-1.5 text-[11px] leading-relaxed',
                                  isOut ? 'border-primary-foreground/20 text-primary-foreground/90' : 'border-border text-muted-foreground',
                                )}>
                                  <p className="whitespace-pre-wrap break-words">{msg.zhTranslation}</p>
                                </div>
                              ) : null}
                              {msg.attachments.length > 0 ? (
                                <div className="mt-2 space-y-1">
                                  {msg.attachments.map((att, idx) => (
                                    <div key={idx} className={cn(
                                      'flex items-center gap-1.5 rounded px-2 py-1 text-[11px]',
                                      isOut ? 'bg-primary-foreground/15' : 'bg-muted',
                                    )}>
                                      <FileText className="h-3.5 w-3.5 shrink-0" />
                                      <span className="truncate">{att.name}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              {msg.errorMessage ? (
                                <p className="mt-1.5 rounded bg-destructive/20 px-2 py-1 text-[10px] text-destructive-foreground">
                                  {msg.errorMessage}
                                </p>
                              ) : null}
                            </div>
                            <div className="mt-1 flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
                              <span className="tabular-nums">{formatDateTime(msg.sentAt).slice(5, 16)}</span>
                              {isOut ? (
                                <span className="flex items-center gap-0.5">
                                  <CheckCheck className="h-3 w-3" />{DELIVERY_LABELS[msg.deliveryStatus]}
                                </span>
                              ) : null}
                              {!msg.zhTranslation ? (
                                <button
                                  type="button"
                                  disabled={translatingMsgId === msg.id}
                                  onClick={() => void translateBubble(msg.id)}
                                  className="inline-flex items-center gap-0.5 text-primary hover:underline"
                                >
                                  {translatingMsgId === msg.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Languages className="h-2.5 w-2.5" />}
                                  译成中文
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard.writeText(msg.text);
                                  toast.success('已复制消息文本');
                                }}
                                className="hover:text-foreground"
                              >
                                复制
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* Composer */}
                  <div className="shrink-0 space-y-2 border-t border-border bg-card p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5 text-[11px]">
                        <button
                          type="button"
                          onClick={() => setComposerDirection('outbound')}
                          className={cn(
                            'rounded px-2.5 py-0.5 transition-colors',
                            composerDirection === 'outbound' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground',
                          )}
                        >
                          我方回复（右侧）
                        </button>
                        <button
                          type="button"
                          onClick={() => setComposerDirection('inbound')}
                          className={cn(
                            'rounded px-2.5 py-0.5 transition-colors',
                            composerDirection === 'inbound' ? 'bg-foreground text-background font-medium' : 'text-muted-foreground',
                          )}
                        >
                          录入客户新消息（左侧）
                        </button>
                      </div>

                      {detail.quotations.length > 0 && composerDirection === 'outbound' ? (
                        <Select
                          value=""
                          onValueChange={(qid) => {
                            const q = detail.quotations.find((x) => x.id === qid);
                            if (!q) return;
                            const total = q.grandTotal ?? q.totalAmount;
                            const snippet = `Quotation ${q.quotationNo} (${q.incoterm || 'FOB'}): ${q.currency} ${total.toFixed(2)}. Please let us know if you would like the PDF copy or any adjustments.`;
                            setComposerText((prev) => (prev ? `${prev}\n\n${snippet}` : snippet));
                            toast.success(`已插入报价 ${q.quotationNo} 摘要`);
                          }}
                        >
                          <SelectTrigger className="h-7 w-[155px] text-[11px]"><SelectValue placeholder="插入客户报价单…" /></SelectTrigger>
                          <SelectContent>
                            {detail.quotations.map((q) => (
                              <SelectItem key={q.id} value={q.id}>
                                {q.quotationNo} · {q.currency} {(q.grandTotal ?? q.totalAmount).toFixed(0)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                    </div>

                    <Textarea
                      value={composerText}
                      onChange={(e) => setComposerText(e.target.value)}
                      rows={3}
                      placeholder={
                        composerDirection === 'outbound'
                          ? '输入回复英文（或点右侧 AI 副驾驶「填入聊天回复框」自动带入）…'
                          : '粘贴客户发来的 WhatsApp / 阿里 / IG 新消息，提交后自动生成双语对照气泡…'
                      }
                      className="text-xs leading-relaxed"
                    />
                    {composerZh ? (
                      <p className="rounded bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                        中文参考：{composerZh}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {composerDirection === 'inbound' ? (
                        <Button size="sm" className="h-8 text-xs" loading={sending} onClick={() => void submitMessage({})}>
                          录入客户消息并自动翻译
                        </Button>
                      ) : canSendLiveWhatsApp ? (
                        <>
                          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={sending} onClick={() => void submitMessage({ copyAfter: true })}>
                            <Copy className="h-3.5 w-3.5" />仅记录并复制
                          </Button>
                          <Button size="sm" className="h-8 text-xs" loading={sending} onClick={() => void submitMessage({ sendViaApi: true })}>
                            <Send className="h-3.5 w-3.5" />通过 WhatsApp API 发送
                          </Button>
                        </>
                      ) : (
                        <Button size="sm" className="h-8 text-xs" loading={sending} onClick={() => void submitMessage({ copyAfter: true })}>
                          <Copy className="h-3.5 w-3.5" />记录回复并复制英文
                        </Button>
                      )}
                    </div>
                  </div>
                </>
              ) : centerTab === 'customer' ? (
                <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
                  {detail.customer ? (
                    <div className="space-y-3 rounded-lg border border-border bg-muted/15 p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <h3 className="text-sm font-semibold">{detail.customer.name}</h3>
                          <p className="text-muted-foreground">{detail.customer.company || '未填公司'}</p>
                        </div>
                        {typeof detail.customer.intentScore === 'number' ? (
                          <Badge variant="outline">AI 意向评分：{detail.customer.intentScore}/100</Badge>
                        ) : null}
                      </div>
                      <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3">
                        <div><dt className="text-muted-foreground">国家/地区</dt><dd className="font-medium">{detail.customer.country || '—'}</dd></div>
                        <div><dt className="text-muted-foreground">销售阶段</dt><dd className="font-medium">{detail.customer.status}</dd></div>
                        <div><dt className="text-muted-foreground">邮箱</dt><dd className="font-medium">{detail.customer.email || '—'}</dd></div>
                        <div><dt className="text-muted-foreground">电话 / WhatsApp</dt><dd className="font-medium">{detail.customer.phone || '—'}</dd></div>
                      </dl>
                      {detail.customer.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {detail.customer.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
                        </div>
                      ) : null}
                      {detail.customer.requirementNotes ? (
                        <div className="rounded border border-border bg-card p-2.5">
                          <p className="font-medium text-muted-foreground">需求备注</p>
                          <p className="mt-1 whitespace-pre-wrap">{detail.customer.requirementNotes}</p>
                        </div>
                      ) : null}
                      <Button asChild size="sm" variant="outline">
                        <Link to={`/customers/${detail.customer.id}`}>打开完整客户 360° 详情页</Link>
                      </Button>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-6 text-center">
                      <p className="font-medium text-foreground">此会话尚未关联 CRM 客户</p>
                      <p className="mt-1 text-muted-foreground">关联后，所有聊天记录会自动沉淀到客户时间线，并可引用已批准报价单。</p>
                      <Button size="sm" className="mt-3" onClick={() => void convertToCustomer()}>
                        <UserPlus className="h-3.5 w-3.5" />一键转为 CRM 客户
                      </Button>
                    </div>
                  )}
                </div>
              ) : centerTab === 'quotations' ? (
                <div className="flex-1 space-y-2.5 overflow-y-auto p-4 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">客户历史报价单</span>
                    <Button asChild size="sm" variant="outline" className="h-7 text-xs">
                      <Link to="/quotations">前往报价与 RFQ 工作台</Link>
                    </Button>
                  </div>
                  {detail.quotations.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">
                      暂无该客户的报价单记录。
                    </div>
                  ) : (
                    detail.quotations.map((q) => (
                      <div key={q.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-semibold">{q.quotationNo}</span>
                            <Badge variant="outline">{q.status}</Badge>
                            {q.incoterm ? <Badge variant="secondary">{q.incoterm}</Badge> : null}
                          </div>
                          <p className="mt-1 text-muted-foreground">
                            总额：{q.currency} {(q.grandTotal ?? q.totalAmount).toFixed(2)} · {formatDateTime(q.createdAt).slice(0, 10)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => {
                              const total = q.grandTotal ?? q.totalAmount;
                              setComposerDirection('outbound');
                              setComposerText(`Quotation ${q.quotationNo} (${q.incoterm || 'FOB'}): ${q.currency} ${total.toFixed(2)}. Please review and let us know your feedback.`);
                              setCenterTab('chat');
                              toast.success('已带入聊天回复框');
                            }}
                          >
                            插入聊天
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={() => void downloadFile(`/quotations/${q.id}/pdf`, `${q.quotationNo}.pdf`)}
                            title="下载 PDF 报价单"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto p-4">
                  {detail.customer ? (
                    <CustomerWorkbenchSidebar
                      customer={{
                        id: detail.customer.id,
                        name: detail.customer.name,
                        company: detail.customer.company || '',
                        country: detail.customer.country || '',
                        email: detail.customer.email || '',
                        phone: detail.customer.phone || '',
                        status: detail.customer.status as Customer['status'],
                        intentScore: detail.customer.intentScore,
                        tags: detail.customer.tags,
                        requirementNotes: detail.customer.requirementNotes,
                        priority: 'medium',
                        source: 'manual',
                        letterCount: 0,
                        createdAt: detail.conversation.createdAt,
                        updatedAt: detail.conversation.lastMessageAt,
                      }}
                      onPatchCustomer={async (patch) => {
                        await apiPatch(`/customers/${detail.customer!.id}`, patch);
                        await loadDetail(detail.conversation.id);
                      }}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                      请先将此会话转为 CRM 客户，再沉淀未解决问题与承诺事项。
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* RIGHT PANE: Persistent AI Copilot */}
        {copilotOpen ? (
          <aside className="flex min-h-0 flex-col overflow-hidden border-t border-border xl:border-t-0" aria-label="AI 客服副驾驶">
            <MailCopilotPane
              mode="mail"
              channel={toCopilotChannel(detail?.conversation.channel)}
              applyLabel="填入聊天回复框"
              customerId={detail?.customer?.id}
              contactName={detail?.conversation.contactName}
              subject=""
              inboundText={latestInbound}
              threadText={chatTranscript}
              sourceMailId={detail?.conversation.id}
              onApplyReply={(draft) => {
                setComposerDirection('outbound');
                setComposerText(draft.content);
                setComposerZh(draft.zh || '');
                setCenterTab('chat');
                toast.success('已填入聊天回复框，核对后可发送或复制');
              }}
            />
          </aside>
        ) : null}
      </div>

      {/* Dialog: Create New Omnichannel Conversation */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新建全渠道会话 / 录入买家消息</DialogTitle>
            <DialogDescription>支持 WhatsApp、阿里国际站、Instagram、微信等渠道；粘贴客户消息后自动翻译并入库。</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>渠道 *</Label>
                <Select value={newChannel} onValueChange={(v) => setNewChannel(v as OmnichannelType)}>
                  <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CHANNEL_META).map(([k, m]) => (
                      <SelectItem key={k} value={k}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>关联已有客户（选填）</Label>
                <Select value={newCustomerId || '__none__'} onValueChange={(v) => handleSelectCustomerForNew(v === '__none__' ? '' : v)}>
                  <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue placeholder="不选则新建联系人" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不关联（新联系人）</SelectItem>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div><Label>联系人姓名 *</Label><Input className="mt-1 h-8 text-xs" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="如 Astrid Mazry" /></div>
              <div><Label>公司名称</Label><Input className="mt-1 h-8 text-xs" value={newCompany} onChange={(e) => setNewCompany(e.target.value)} placeholder="如 A.S. Avenue LLC" /></div>
              <div><Label>国家 / 地区</Label><Input className="mt-1 h-8 text-xs" value={newCountry} onChange={(e) => setNewCountry(e.target.value)} placeholder="如 USA / UK / Japan" /></div>
              <div><Label>WhatsApp 号码 / 账号</Label><Input className="mt-1 h-8 text-xs" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="如 +1 415 555 8890" /></div>
            </div>

            <div>
              <Label>客户首条消息（选填，粘贴后自动双语翻译）</Label>
              <Textarea
                className="mt-1 text-xs"
                rows={4}
                value={newFirstMessage}
                onChange={(e) => setNewFirstMessage(e.target.value)}
                placeholder="粘贴客户在 WhatsApp / 阿里 / IG 发来的英文原话…"
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNewOpen(false)}>取消</Button>
            <Button size="sm" loading={creating} onClick={() => void submitNewConversation()}>创建会话</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Meta WhatsApp Business Cloud API Settings */}
      <Dialog open={cfgOpen} onOpenChange={setCfgOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-primary" />Meta WhatsApp Business Cloud API 配置
            </DialogTitle>
            <DialogDescription>
              所有密钥在服务端 AES-256-GCM 独立加密存储，永不回显明文。未配置时可直接使用「半自动协同模式」。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-xs">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="font-semibold text-foreground">Meta Webhook 回调地址（粘贴到 Meta Developers 后台）</p>
              <div className="mt-1.5 flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-background px-2 py-1 text-[11px]">{fullWebhookUrl}</code>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  onClick={() => {
                    void navigator.clipboard.writeText(fullWebhookUrl);
                    toast.success('已复制 Webhook URL');
                  }}
                >
                  复制
                </Button>
              </div>
              {cfg?.webhookLastReceivedAt ? (
                <p className="mt-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                  最近一次收到 Meta Webhook：{formatDateTime(cfg.webhookLastReceivedAt)}
                </p>
              ) : null}
              {cfg?.webhookLastError ? (
                <p className="mt-1 text-[11px] text-destructive">最近错误：{cfg.webhookLastError}</p>
              ) : null}
            </div>

            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={cfgEnabled}
                onChange={(e) => setCfgEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              启用官方 WhatsApp Business Cloud API 实时收发
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div><Label>Phone Number ID</Label><Input className="mt-1 h-8 text-xs" value={cfgPhoneId} onChange={(e) => setCfgPhoneId(e.target.value)} placeholder="如 104298374651234" /></div>
              <div><Label>Business Account ID (WABA)</Label><Input className="mt-1 h-8 text-xs" value={cfgWabaId} onChange={(e) => setCfgWabaId(e.target.value)} placeholder="选填" /></div>
              <div className="col-span-2"><Label>展示手机号</Label><Input className="mt-1 h-8 text-xs" value={cfgDisplayPhone} onChange={(e) => setCfgDisplayPhone(e.target.value)} placeholder="如 +86 153 0600 1357" /></div>
            </div>

            <div className="space-y-2 border-t border-border pt-2">
              <div>
                <div className="flex items-center justify-between">
                  <Label>System User Permanent Access Token</Label>
                  {cfg?.hasAccessToken ? <Badge variant="outline" className="text-[10px]">已安全加密保存（留空不变）</Badge> : null}
                </div>
                <Input type="password" className="mt-1 h-8 text-xs" value={cfgAccessToken} onChange={(e) => setCfgAccessToken(e.target.value)} placeholder="EAAG..." autoComplete="new-password" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Meta App Secret（用于校验 X-Hub-Signature-256）</Label>
                  {cfg?.hasAppSecret ? <Badge variant="outline" className="text-[10px]">已安全加密保存（留空不变）</Badge> : null}
                </div>
                <Input type="password" className="mt-1 h-8 text-xs" value={cfgAppSecret} onChange={(e) => setCfgAppSecret(e.target.value)} placeholder="Meta 应用密钥" autoComplete="new-password" />
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Webhook Verify Token（自定义随机串）</Label>
                  {cfg?.hasVerifyToken ? <Badge variant="outline" className="text-[10px]">已安全加密保存（留空不变）</Badge> : null}
                </div>
                <Input type="password" className="mt-1 h-8 text-xs" value={cfgVerifyToken} onChange={(e) => setCfgVerifyToken(e.target.value)} placeholder="与 Meta 后台保持一致的验证口令" autoComplete="new-password" />
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCfgOpen(false)}>取消</Button>
            <Button size="sm" loading={savingCfg} onClick={() => void saveConfig()}>加密保存配置</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ChannelsPage;
