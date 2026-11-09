/**
 * 转交跟进弹窗
 * ------------------------------------------------------------------
 * 管理员把客户和后续跟进交给另一位业务员。转交后旧负责人的自动开发信
 * 会停止，新的负责人继续跟进；说明会写进客户时间线。
 */
import * as React from 'react';
import { ArrowRightLeft, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { apiPost, toErrorMessage } from '@/lib/api';
import type { Customer, OwnerOption } from '@/types';

export interface CustomerHandoffDialogProps {
  open: boolean;
  customer: Customer;
  owners: OwnerOption[];
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}

export function CustomerHandoffDialog({
  open,
  customer,
  owners,
  onOpenChange,
  onCompleted,
}: CustomerHandoffDialogProps): React.JSX.Element {
  const [ownerId, setOwnerId] = React.useState('');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const candidates = React.useMemo(
    () => owners.filter((owner) => owner.id !== customer.ownerId),
    [owners, customer.ownerId],
  );

  React.useEffect(() => {
    if (!open) return;
    setOwnerId('');
    setNote('');
    setError(null);
  }, [open, customer.id]);

  const submit = async (): Promise<void> => {
    if (!ownerId) {
      setError('请选择要转交的业务员');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost<Customer>(`/customers/${customer.id}/handoff`, {
        ownerId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      const target = candidates.find((owner) => owner.id === ownerId);
      toast.success('已转交跟进', {
        description: target ? `后续由 ${target.name} 负责，原自动开发信已停止` : '原自动开发信已停止',
      });
      onCompleted();
      onOpenChange(false);
    } catch (cause) {
      setError(toErrorMessage(cause, '转交失败，请稍后重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft className="h-4 w-4 text-primary" aria-hidden />
            转交跟进
          </DialogTitle>
          <DialogDescription>
            将 {customer.name} 和后续跟进转交给另一位业务员。转交后原业务员的自动开发信会停止，客户历史记录和开发信会保留。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div>
            <Label htmlFor="handoff-owner">接手业务员</Label>
            <Select value={ownerId} onValueChange={(value) => { setOwnerId(value); setError(null); }} disabled={busy}>
              <SelectTrigger id="handoff-owner" className="mt-1.5">
                <SelectValue placeholder="选择接手业务员" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((owner) => (
                  <SelectItem key={owner.id} value={owner.id}>
                    {owner.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {candidates.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">当前没有其他可接手的业务员。</p>
            ) : null}
          </div>

          <div>
            <Label htmlFor="handoff-note">转交说明（可选）</Label>
            <Textarea
              id="handoff-note"
              value={note}
              onChange={(event) => { setNote(event.target.value); setError(null); }}
              placeholder="例如：客户已回复，请接手报价和后续沟通。"
              maxLength={500}
              rows={4}
              disabled={busy}
              className="mt-1.5 resize-none"
            />
            <p className="mt-1 text-right text-xs text-muted-foreground">{note.length}/500</p>
          </div>

          {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!ownerId || busy} loading={busy}>
            <UserRound className="h-4 w-4" aria-hidden />
            确认转交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
