import { DevelopmentLetter, Project } from '../../models';
import { stripSignatureText } from '../letter-signature';
import { resolveProjectSalesProfile } from '../project-profile';
import { extractDeliverables, extractQuestions } from './outreach-quality';
import type { PreviousOutreachDraft } from './provider';

export async function previousOutreachDrafts(
  projectId: string,
  customerId: string,
  nextStep: number,
  includePreview = false,
): Promise<PreviousOutreachDraft[]> {
  if (nextStep <= 1) return [];
  const [project, letters] = await Promise.all([
    Project.findById(projectId).select('code slug name companyName industry website mailFrom senderName brandProfile').lean(),
    DevelopmentLetter.find({
      projectId,
      customerId,
      outreachStep: { $gte: 1, $lt: nextStep },
      status: { $in: includePreview ? ['sent', 'opened', 'draft'] : ['sent', 'opened'] },
    })
      .sort({ sentAt: -1, createdAt: -1 })
      .limit(30)
      .select('outreachStep subject contentText knowledgeReview.claims knowledgeReview.context.playbook knowledgeReview.context.outreachMemory')
      .lean(),
  ]);
  const signature = resolveProjectSalesProfile(project).signature;
  const steps = new Map<number, PreviousOutreachDraft>();
  for (const letter of letters) {
    const step = letter.outreachStep!;
    if (steps.has(step)) continue;
    const bodyText = stripSignatureText(letter.contentText, [signature.title, ...signature.lines]).slice(0, 1800);
    const playbook = letter.knowledgeReview?.context?.playbook;
    const memory = letter.knowledgeReview?.context?.outreachMemory;
    const claimProofIds = (letter.knowledgeReview?.claims ?? [])
      .flatMap((c) => c.sourceIds ?? [])
      .filter((id) => id.startsWith('knowledge:'));
    const claimProofTexts = (letter.knowledgeReview?.claims ?? []).map((c) => c.text).filter(Boolean);
    const usedProofIds = [...new Set([...(memory?.usedProofIds ?? []), ...claimProofIds])];
    const usedProofTexts = [...new Set([...(memory?.usedProofTexts ?? []), ...claimProofTexts])];
    const usedCtas = [...new Set([...(memory?.usedCtas ?? []), ...extractQuestions(bodyText)])];
    const usedDeliverables = [
      ...new Set([...(memory?.usedDeliverables ?? []), ...extractDeliverables(bodyText).map((d) => d.key)]),
    ];
    steps.set(step, {
      step,
      subject: letter.subject,
      bodyText,
      angleCode: playbook?.segmentCode,
      ...(playbook?.alternatives?.length ? { savedAlternatives: playbook.alternatives } : {}),
      ...(usedProofIds.length ? { usedProofIds } : {}),
      ...(usedProofTexts.length ? { usedProofTexts } : {}),
      ...(usedCtas.length ? { usedCtas } : {}),
      ...(usedDeliverables.length ? { usedDeliverables } : {}),
    });
  }
  return [...steps.values()].sort((left, right) => left.step - right.step);
}
