/**
 * 团队与权限 / 用户管理页（仅管理员）
 * ------------------------------------------------------------------
 * 结构化双栏工作台：
 *  - 顶部 3 维团队统计卡（团队账号 / 系统管理员 / 业务成员账号）
 *  - 左栏：「成员列表」标准表格（支持搜索筛选、角色与邮箱验证状态、操作菜单）
 *  - 右栏：常驻「成员详情」检查器（角色、账号状态、发件邮箱验证状态、2FA、最近登录与快捷操作）
 * 自我保护：不能停用 / 删除当前登录的自己（前端禁用 + 后端拦截双重保险）。
 */
import * as React from 'react';
import { toast } from 'sonner';
import {
  Ban,
  Briefcase,
  CheckCircle2,
  Clock3,
  KeyRound,
  Mail,
  MailCheck,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
  UserCog,
  UserPlus,
  Users,
} from 'lucide-react';
import { PageHeader } from '@/components/common/page-header';
import { SearchInput } from '@/components/common/search-input';
import { EmptyState, ErrorState, NoResultState } from '@/components/common/empty-state';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableSkeleton } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuDangerItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserFormDialog } from '@/components/users/user-form-dialog';
import { ResetPasswordDialog } from '@/components/users/reset-password-dialog';
import { MailAccountDialog } from '@/components/users/mail-account-dialog';
import { usePageTitle } from '@/hooks/use-ui';
import { useUserStore } from '@/store/user.store';
import { useAuthStore } from '@/store/auth.store';
import {
  USER_ROLE_BADGE_CLASS,
  USER_STATUS_BADGE_CLASS,
  USER_STATUS_LABEL,
} from '@/constants';
import { formatDateTime, formatRelative, initials } from '@/lib/format';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { UserDto } from '@/types';

interface RowActionHandlers {
  onEdit: (user: UserDto) => void;
  onResetPassword: (user: UserDto) => void;
  onConfigureMail: (user: UserDto) => void;
  onToggleStatus: (user: UserDto) => void;
  onDelete: (user: UserDto) => void;
}

function RowActions({
  user,
  isSelf,
  onEdit,
  onResetPassword,
  onConfigureMail,
  onToggleStatus,
  onDelete,
}: { user: UserDto; isSelf: boolean } & RowActionHandlers): React.JSX.Element {
  const isDisabledAccount = user.status === 'disabled';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`更多操作：${user.displayName || user.username}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => onEdit(user)}>
          <Pencil className="h-4 w-4" aria-hidden />
          编辑资料
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onResetPassword(user)}>
          <KeyRound className="h-4 w-4" aria-hidden />
          重置密码
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onConfigureMail(user)}>
          <MailCheck className="h-4 w-4" aria-hidden />
          配置发件邮箱
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={isSelf} onClick={() => onToggleStatus(user)}>
          {isDisabledAccount ? (
            <CheckCircle2 className="h-4 w-4" aria-hidden />
          ) : (
            <Ban className="h-4 w-4" aria-hidden />
          )}
          {isDisabledAccount ? '启用账号' : '停用账号'}
        </DropdownMenuItem>
        <DropdownMenuDangerItem disabled={isSelf} onClick={() => onDelete(user)}>
          <Trash2 className="h-4 w-4" aria-hidden />
          删除账号
        </DropdownMenuDangerItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MailboxStatusPill({ user }: { user: UserDto }): React.JSX.Element {
  if (!user.mailbox) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/45" aria-hidden />
        未配置
      </span>
    );
  }
  if (user.mailbox.status === 'disabled') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden />
        已停用
      </span>
    );
  }
  if (user.mailbox.verificationStatus === 'verified') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        已验证
      </span>
    );
  }
  if (user.mailbox.verificationStatus === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 dark:text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-600" aria-hidden />
        验证失败
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
      待验证
    </span>
  );
}

export function UsersPage(): React.JSX.Element {
  const { t } = useI18n();
  usePageTitle('用户管理');

  const items = useUserStore((state) => state.items);
  const loading = useUserStore((state) => state.loading);
  const error = useUserStore((state) => state.error);
  const fetchList = useUserStore((state) => state.fetchList);
  const setStatus = useUserStore((state) => state.setStatus);
  const deleteUser = useUserStore((state) => state.deleteUser);
  const currentUserId = useAuthStore((state) => state.user?.id);

  const [keyword, setKeyword] = React.useState('');
  const [formOpen, setFormOpen] = React.useState(false);
  const [editingUser, setEditingUser] = React.useState<UserDto | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetTarget, setResetTarget] = React.useState<UserDto | null>(null);
  const [mailOpen, setMailOpen] = React.useState(false);
  const [mailTarget, setMailTarget] = React.useState<UserDto | null>(null);
  const [confirm, setConfirm] = React.useState<{ kind: 'delete' | 'disable'; user: UserDto } | null>(null);
  const [confirmLoading, setConfirmLoading] = React.useState(false);

  React.useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const filteredItems = React.useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return items;
    return items.filter((u) =>
      `${u.displayName ?? ''} ${u.username} ${u.email ?? ''} ${u.mailbox?.email ?? ''} ${u.role}`
        .toLowerCase()
        .includes(q),
    );
  }, [items, keyword]);

  const adminCount = React.useMemo(() => items.filter((user) => user.role === 'admin').length, [items]);
  const salesCount = React.useMemo(() => items.filter((user) => user.role !== 'admin').length, [items]);
  const verifiedMailCount = React.useMemo(
    () => items.filter((user) => user.mailbox?.verificationStatus === 'verified' && user.mailbox.status !== 'disabled').length,
    [items],
  );

  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setSelectedUserId((prev) =>
      prev && filteredItems.some((u) => u.id === prev) ? prev : filteredItems[0]?.id ?? null,
    );
  }, [filteredItems]);

  const selectedUser = React.useMemo(
    () => (selectedUserId ? filteredItems.find((u) => u.id === selectedUserId) ?? null : null),
    [filteredItems, selectedUserId],
  );

  const roleText = React.useCallback(
    (role: UserDto['role']) =>
      role === 'admin'
        ? t('users.role.admin')
        : role === 'project_admin'
          ? t('users.role.project_admin')
          : role === 'viewer'
            ? t('users.role.viewer')
            : t('users.role.user'),
    [t],
  );

  const openCreate = React.useCallback(() => {
    setEditingUser(null);
    setFormOpen(true);
  }, []);

  const openEdit = React.useCallback((user: UserDto) => {
    setEditingUser(user);
    setFormOpen(true);
  }, []);

  const openReset = React.useCallback((user: UserDto) => {
    setResetTarget(user);
    setResetOpen(true);
  }, []);

  const openMailAccount = React.useCallback((user: UserDto) => {
    setMailTarget(user);
    setMailOpen(true);
  }, []);

  const handleToggleStatus = React.useCallback(
    async (user: UserDto) => {
      if (user.status === 'disabled') {
        try {
          await setStatus(user.id, 'active');
          toast.success('账号已启用', { description: `${user.displayName || user.username} 可重新登录` });
        } catch (err) {
          toast.error('启用失败', { description: err instanceof Error ? err.message : '请稍后重试' });
        }
      } else {
        setConfirm({ kind: 'disable', user });
      }
    },
    [setStatus],
  );

  const handleDelete = React.useCallback((user: UserDto) => {
    setConfirm({ kind: 'delete', user });
  }, []);

  const runConfirm = React.useCallback(async () => {
    if (!confirm) return;
    setConfirmLoading(true);
    const name = confirm.user.displayName || confirm.user.username;
    try {
      if (confirm.kind === 'delete') {
        const result = await deleteUser(confirm.user.id);
        const moved = result?.reassignedCustomers ?? 0;
        toast.success('账号已删除', {
          description: moved > 0 ? `${name} 已删除，${moved} 个客户转为未分配` : `${name} 已删除`,
        });
      } else {
        await setStatus(confirm.user.id, 'disabled');
        toast.success('账号已停用', { description: `${name} 立即无法登录，已登录会话同步失效` });
      }
      setConfirm(null);
    } catch (err) {
      toast.error(confirm.kind === 'delete' ? '删除失败' : '停用失败', {
        description: err instanceof Error ? err.message : '请稍后重试',
      });
    } finally {
      setConfirmLoading(false);
    }
  }, [confirm, deleteUser, setStatus]);

  const confirmIsDelete = confirm?.kind === 'delete';
  const confirmName = confirm ? confirm.user.displayName || confirm.user.username : '';

  return (
    <div className="workspace-page">
      <PageHeader
        title="用户管理"
        description={
          items.length > 0 ? (
            <>
              管理团队成员、角色权限与个人发件邮箱，共{' '}
              <span className="font-semibold text-foreground tabular-nums">{items.length}</span> 个账号
              {adminCount > 0 ? `（管理员 ${adminCount} 人）` : ''}
            </>
          ) : (
            '创建业务员账号后，在「客户管理」里把客户分配给他们；业务员只能看到自己名下的客户'
          )
        }
        actions={
          <Button type="button" size="sm" onClick={openCreate}>
            <UserPlus className="h-4 w-4" aria-hidden />
            新建用户
          </Button>
        }
      />

      {/* 顶部 3 维团队统计卡 */}
      <div className="grid gap-3.5 sm:grid-cols-3">
        <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground"
              aria-hidden
            >
              <Users className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-medium text-muted-foreground">团队账号</p>
              <p className="mt-1 text-2xl font-bold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                {items.length}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">当前系统的团队成员总数</p>
            </div>
          </div>
          <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-foreground">
            启用 {items.filter((u) => u.status === 'active').length}
          </span>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground"
              aria-hidden
            >
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-medium text-muted-foreground">系统管理员</p>
              <p className="mt-1 text-2xl font-bold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                {adminCount}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">可管理系统设置、用户与项目权限</p>
            </div>
          </div>
          <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            全局权限
          </span>
        </div>

        <div className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-4 shadow-xs">
          <div className="flex items-start gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 bg-surface text-foreground"
              aria-hidden
            >
              <Briefcase className="h-4 w-4" />
            </span>
            <div>
              <p className="text-xs font-medium text-muted-foreground">业务成员账号</p>
              <p className="mt-1 text-2xl font-bold leading-none tabular-nums tracking-[-0.03em] text-foreground">
                {salesCount}
              </p>
              <p className="mt-1.5 text-[11px] text-muted-foreground">独立分配客户与个人发件邮箱</p>
            </div>
          </div>
          <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-foreground">
            已配邮箱 {verifiedMailCount}
          </span>
        </div>
      </div>

      {/* 左表 + 右详情双栏工作台 */}
      <div className={cn('grid gap-4', selectedUser && 'xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start')}>
        <Card className="min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">成员列表</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                点击任意成员行可在右侧查看详细权限与邮箱配置
              </p>
            </div>
            <SearchInput
              value={keyword}
              onChange={setKeyword}
              placeholder="搜索姓名、账号或邮箱…"
              className="w-full sm:w-64"
              aria-label="搜索成员"
            />
          </div>

          {error ? (
            <ErrorState title="用户列表加载失败" description={error} onRetry={() => void fetchList()} retrying={loading} />
          ) : loading && items.length === 0 ? (
            <div className="p-4">
              <TableSkeleton rows={5} columns={5} />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title="还没有其他账号"
              description="创建业务员账号后，在「客户管理」里把客户分配给他们"
              action={
                <Button type="button" size="sm" onClick={openCreate}>
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  新建用户
                </Button>
              }
            />
          ) : filteredItems.length === 0 ? (
            <NoResultState
              title="没有匹配的成员"
              description="请尝试其他姓名、账号或邮箱关键词"
              action={
                <Button type="button" variant="outline" size="sm" onClick={() => setKeyword('')}>
                  清空搜索
                </Button>
              }
            />
          ) : (
            <div className="table-scroll">
              <Table aria-label="成员列表">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="min-w-[13rem] pl-4">成员</TableHead>
                    <TableHead className="whitespace-nowrap">角色</TableHead>
                    <TableHead className="whitespace-nowrap">状态</TableHead>
                    <TableHead className="whitespace-nowrap">邮箱状态</TableHead>
                    <TableHead className="whitespace-nowrap">加入 / 最近登录</TableHead>
                    <TableHead className="w-12 pr-4 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredItems.map((user) => {
                    const isSelf = currentUserId === user.id;
                    const active = selectedUser?.id === user.id;
                    return (
                      <TableRow
                        key={user.id}
                        onClick={() => setSelectedUserId(user.id)}
                        className={cn(
                          'cursor-pointer',
                          active && 'bg-surface/90 shadow-[inset_2px_0_0_hsl(var(--foreground))]',
                        )}
                      >
                        <TableCell className="pl-4">
                          <div className="flex items-center gap-3">
                            <span
                              className="avatar-bubble flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border/80 text-xs font-semibold"
                              aria-hidden
                            >
                              {initials(user.displayName || user.username)}
                            </span>
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {user.displayName || user.username}
                                </span>
                                {isSelf ? <Badge variant="muted">当前登录</Badge> : null}
                                {user.twoFactorEnabled ? <Badge variant="outline">2FA</Badge> : null}
                              </div>
                              <span className="block truncate text-xs text-muted-foreground">
                                {user.mailbox?.email || user.email || `@${user.username}`}
                              </span>
                            </div>
                          </div>
                        </TableCell>

                        <TableCell className="whitespace-nowrap">
                          <Badge variant="outline" className={cn('gap-1 font-normal', USER_ROLE_BADGE_CLASS[user.role])}>
                            {user.role === 'admin' ? (
                              <ShieldCheck className="h-3 w-3" aria-hidden />
                            ) : (
                              <UserCog className="h-3 w-3" aria-hidden />
                            )}
                            {roleText(user.role)}
                          </Badge>
                        </TableCell>

                        <TableCell className="whitespace-nowrap">
                          <Badge variant="outline" className={cn('gap-1 font-normal', USER_STATUS_BADGE_CLASS[user.status])}>
                            {user.status === 'disabled' ? (
                              <Ban className="h-3 w-3" aria-hidden />
                            ) : (
                              <CheckCircle2 className="h-3 w-3" aria-hidden />
                            )}
                            {USER_STATUS_LABEL[user.status]}
                          </Badge>
                        </TableCell>

                        <TableCell className="whitespace-nowrap">
                          <MailboxStatusPill user={user} />
                        </TableCell>

                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          <div className="tabular-nums text-foreground">{formatDateTime(user.createdAt)}</div>
                          <div className="text-[11px]">
                            {user.lastLoginAt ? `最近登录 ${formatRelative(user.lastLoginAt)}` : '尚未登录'}
                          </div>
                        </TableCell>

                        <TableCell className="pr-4 text-right">
                          <RowActions
                            user={user}
                            isSelf={isSelf}
                            onEdit={openEdit}
                            onResetPassword={openReset}
                            onConfigureMail={openMailAccount}
                            onToggleStatus={(target) => void handleToggleStatus(target)}
                            onDelete={handleDelete}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>

        {selectedUser ? (
          <Card className="p-5 xl:sticky xl:top-4">
            <div className="flex items-center justify-between border-b border-border/75 pb-3">
              <h2 className="text-sm font-semibold text-foreground">成员详情</h2>
              <RowActions
                user={selectedUser}
                isSelf={currentUserId === selectedUser.id}
                onEdit={openEdit}
                onResetPassword={openReset}
                onConfigureMail={openMailAccount}
                onToggleStatus={(target) => void handleToggleStatus(target)}
                onDelete={handleDelete}
              />
            </div>

            <div className="mt-4 flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="avatar-bubble flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-sm font-bold">
                  {initials(selectedUser.displayName || selectedUser.username)}
                </span>
                <div className="min-w-0">
                  <h3 className="truncate text-base font-semibold text-foreground">
                    {selectedUser.displayName || selectedUser.username}
                  </h3>
                  <p className="truncate text-xs text-muted-foreground">@{selectedUser.username}</p>
                </div>
              </div>
              <Badge variant="outline" className={USER_STATUS_BADGE_CLASS[selectedUser.status]}>
                {USER_STATUS_LABEL[selectedUser.status]}
              </Badge>
            </div>

            <dl className="mt-4 divide-y divide-border/65 border-t border-border/75 text-xs">
              <div className="flex items-center justify-between gap-2 py-2.5">
                <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <UserCog className="h-3.5 w-3.5" aria-hidden />
                  角色权限
                </dt>
                <dd>
                  <Badge variant="outline" className={USER_ROLE_BADGE_CLASS[selectedUser.role]}>
                    {roleText(selectedUser.role)}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3 py-2.5">
                <dt className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  <Mail className="h-3.5 w-3.5" aria-hidden />
                  个人发件邮箱
                </dt>
                <dd className="min-w-0 text-right">
                  <span className="block truncate font-medium text-foreground">
                    {selectedUser.mailbox?.email || '未配置'}
                  </span>
                  <div className="mt-0.5 flex justify-end">
                    <MailboxStatusPill user={selectedUser} />
                  </div>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 py-2.5">
                <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                  两步验证 (2FA)
                </dt>
                <dd className="font-medium text-foreground">
                  {selectedUser.twoFactorEnabled ? '已开启' : '未开启'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 py-2.5">
                <dt className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Clock3 className="h-3.5 w-3.5" aria-hidden />
                  最近登录
                </dt>
                <dd className="tabular-nums text-foreground">
                  {selectedUser.lastLoginAt ? formatDateTime(selectedUser.lastLoginAt) : '尚未登录'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2 py-2.5">
                <dt className="text-muted-foreground">创建时间</dt>
                <dd className="tabular-nums text-foreground">{formatDateTime(selectedUser.createdAt)}</dd>
              </div>
            </dl>

            <div className="mt-4 space-y-2 border-t border-border/75 pt-4">
              <Button type="button" size="sm" className="w-full" onClick={() => openEdit(selectedUser)}>
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                管理成员资料
              </Button>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => openMailAccount(selectedUser)}>
                  <MailCheck className="h-3.5 w-3.5" aria-hidden />
                  发件邮箱
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => openReset(selectedUser)}>
                  <KeyRound className="h-3.5 w-3.5" aria-hidden />
                  重置密码
                </Button>
              </div>
            </div>
          </Card>
        ) : null}
      </div>

      <UserFormDialog key={editingUser?.id ?? 'new'} open={formOpen} onOpenChange={setFormOpen} user={editingUser} />
      <ResetPasswordDialog open={resetOpen} onOpenChange={setResetOpen} user={resetTarget} />
      <MailAccountDialog open={mailOpen} onOpenChange={setMailOpen} user={mailTarget} />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => {
          if (!next && !confirmLoading) setConfirm(null);
        }}
        variant={confirmIsDelete ? 'destructive' : 'default'}
        title={confirmIsDelete ? '删除账号' : '停用账号'}
        description={
          confirmIsDelete
            ? `确认删除「${confirmName}」？此操作不可撤销。`
            : `确认停用「${confirmName}」？停用后该账号立即无法登录。`
        }
        confirmText={confirmIsDelete ? '删除' : '停用'}
        loading={confirmLoading}
        onConfirm={runConfirm}
      >
        {confirmIsDelete ? (
          <p>该账号名下的客户将全部转为「未分配」，回到管理员池后可重新分配。</p>
        ) : (
          <p>已登录的会话会同步失效；如需恢复，可随时在该账号上选择「启用」。</p>
        )}
      </ConfirmDialog>
    </div>
  );
}
