import { DevelopmentLetter } from '../../models';
import { stripSignatureText } from '../letter-signature';
import type { PreviousOutreachDraft } from './provider';

export async function previousOutreachDrafts(projectId: string, customerId: string, nextStep: number, includePreview = false): Promise<PreviousOutreachDraft[]> {
  if (nextStep <= 1) return [];
  const letters = await DevelopmentLetter.find({
    projectId, customerId, outreachStep: { $gte: 1, $lt: nextStep },
    status: { $in: includePreview ? ['sent', 'opened', 'draft'] : ['sent', 'opened'] },
  }).sort({ sentAt: -1, createdAt: -1 }).limit(30)
    .select('outreachStep subject contentText knowledgeReview.context.playbook.segmentCode').lean();
  const steps = new Map<number, PreviousOutreachDraft>();
  for (const letter of letters) {
    const step = letter.outreachStep!;
    if (steps.has(step)) continue;
    const angleCode = letter.knowledgeReview?.context?.playbook?.segmentCode;
    steps.set(step, { step, subject: letter.subject, bodyText: stripSignatureText(letter.contentText).slice(0, 1800), angleCode });
  }
  return [...steps.values()].sort((left, right) => left.step - right.step);
}
