/**
 * 跟进记录历史列表
 * ------------------------------------------------------------------
 * - 按跟进时间倒序（后端已排好），最新一条高亮并带「最新」标记
 * - 每条可编辑（复用新增弹窗）/ 删除（危险操作，走 ConfirmDialog）
 * - 展示：方式 / 结果徽章 + 跟进时间 + 内容 + 下一次跟进
 */
import * as React from 'react';
import { CalendarClock, NotebookPen, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState, ErrorState, InlineLoader } from '@/components/common/empty-state';
import { FOLLOW_UP_METHOD_LABEL, FOLLOW_UP_RESULT_LABEL } from '@/constants';
import { formatDate, formatDateTime, getFollowUpState } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { FollowUp, FollowUpResult } from '@/types';

const RESULT_VISUAL: Record<FollowUpResult, { dot: string; tag: string }> = {
  won: { dot: 'bg-emerald-500', tag: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  replied: { dot: 'bg-teal-500', tag: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' },
  interested: { dot: 'bg-amber-500', tag: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  quoted: { dot: 'bg-orange-500', tag: 'bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300' },
  negotiating: { dot: 'bg-violet-500', tag: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  no_need: { dot: 'bg-rose-500', tag: 'bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
  no_reply: { dot: 'bg-slate-400', tag: 'bg-surface text-muted-foreground' },
  other: { dot: 'bg-sky-500', tag: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
};

export interface FollowUpListProps {
  followUps: FollowUp[];
  loading: boolean;
  error: string | null;
  /** 删除进行中（禁用按钮） */
  busy?: boolean;
  onRetry: () => void;
  onDelete: (followUp: FollowUp) => void | Promise<void>;
  /** 编辑按钮点击（由父级打开弹窗并预填该记录） */
  onEdit: (followUp: FollowUp) => void;
  /** 新增按钮点击（由父级打开弹窗） */
  onAdd: () => void;
}

/** 下一次跟进时间的提示文案与颜色（逾期红 / 今天琥珀 / 未来常规） */
function nextFollowUpHint(value?: string | Date | null): { text: string; className: string } | null {
  if (!value) return null;
  const state = getFollowUpState(value);
  const date = formatDate(value);
  if (state === 'overdue') return { text: `下次跟进 ${date}（已逾期）`, className: 'text-destructive' };
  if (state === 'today') return { text: `下次跟进 ${date}（今天）`, className: 'text-amber-600 dark:text-amber-400' };
  return { text: `下次跟进 ${date}`, className: 'text-muted-foreground' };
}

export function FollowUpList({
  followUps,
  loading,
  error,
  busy = false,
  onRetry,
  onDelete,
  onEdit,
  onAdd,
}: FollowUpListProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = React.useState<FollowUp | null>(null);

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return;
    await onDelete(deleteTarget);
    setDeleteTarget(null);
  }, [deleteTarget, onDelete]);

  if (loading && followUps.length === 0) {
    return <InlineLoader label="正在加载跟进记录…" />;
  }

  if (error && followUps.length === 0) {
    return <ErrorState title="跟进记录加载失败" description={error} onRetry={onRetry} retrying={loading} />;
  }

  if (followUps.length === 0) {
    return (
      <EmptyState
        title="还没有跟进记录"
        description="记录每一次与客户的沟通，方便回顾进展与安排下一步。"
        action={
          <Button type="button" size="sm" onClick={onAdd}>
            <NotebookPen className="h-4 w-4" aria-hidden />
            新增跟进
          </Button>
        }
      />
    );
  }

  return (
    <>
      <ol className="relative mt-1 divide-y divide-border/55 pl-5 before:absolute before:bottom-3 before:left-[5px] before:top-3 before:w-px before:bg-border/80">
        {followUps.map((item, index) => {
          const isLatest = index === 0;
          const hint = nextFollowUpHint(item.nextFollowUpAt);
          const visual = RESULT_VISUAL[item.result] ?? RESULT_VISUAL.no_reply;
          return (
            <li
              key={item.id}
              className="group relative py-2.5 transition-colors first:pt-1 last:pb-1"
            >
              {/* Timeline Rail Dot */}
              <span
                className={cn(
                  'absolute -left-5 h-2.5 w-2.5 rounded-full ring-4 ring-card',
                  index === 0 ? 'top-2' : 'top-3.5',
                  isLatest && item.result === 'no_reply' ? 'bg-indigo-500' : visual.dot,
                )}
                aria-hidden
              />

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-foreground">
                  {FOLLOW_UP_METHOD_LABEL[item.method] ?? item.method}
                </span>
                <span className={cn('rounded-full px-2 py-0.5 text-[10.5px] font-medium leading-tight', visual.tag)}>
                  {FOLLOW_UP_RESULT_LABEL[item.result] ?? item.result}
                </span>
                {isLatest ? (
                  <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                    最新
                  </span>
                ) : null}

                <span className="ml-auto flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                  <CalendarClock className="h-3 w-3 opacity-75" aria-hidden />
                  {formatDateTime(item.followUpAt)}
                </span>

                <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    aria-label="编辑该跟进记录"
                    onClick={() => onEdit(item)}
                  >
                    <Pencil className="h-3 w-3" aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    aria-label="删除该跟进记录"
                    onClick={() => setDeleteTarget(item)}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </Button>
                </div>
              </div>

              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{item.content}</p>

              {hint ? <p className={cn('mt-1 text-[11px] font-medium', hint.className)}>{hint.text}</p> : null}
            </li>
          );
        })}
      </ol>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="删除跟进记录"
        description={
          deleteTarget
            ? `确定要删除 ${formatDate(deleteTarget.followUpAt)} 的这条跟进记录吗？删除后无法恢复。`
            : undefined
        }
        confirmText="删除"
        variant="destructive"
        loading={busy}
        onConfirm={confirmDelete}
      />
    </>
  );
}
