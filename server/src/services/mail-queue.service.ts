import {hasProtectedCustomerMail} from './agent/mail-thread-analysis.service';
import {recordAgentSendReceipt} from './agent/automation.service';
import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { AgentTask } from '../models/AgentTask';
import { createFollowUp } from './followup.service';
import { DevelopmentLetter, Customer, User, Project, OutreachAutomationConfig, OutreachAutomationEnrollment, type DevelopmentLetterDocument } from '../models';
import env from '../config/env';
import { sendMail, type SendMailPayload, type SendMailResult } from './mailer.service';
import { createLogger } from '../config/logger';
import { auditMailResult, reserveMailAttempt } from './mail-account.service';
import {
  cancelPendingOutreachLetters,
  hasInboundReplySince,
  scheduleOutreachFollowUp,
} from './outreach-followup.service';
import { appendUnsubscribeFooter, isEmailSuppressed, suppressEmail, unsubscribeHeaders } from './mail-compliance.service';
import { getAttachmentForDownload } from './attachment.service';
import { stripReplySubjectPrefix } from '../utils/text';
import { automatedReviewIssue, repeatedOutreachIssue } from './agent/knowledge-send-gate';
import { previousOutreachDrafts } from './agent/outreach-history';
import { draftHash, knowledgeFreshness } from './agent/knowledge-grounding';
import type { AuthUser } from '../types/express';

const logger = createLogger('mail-queue');
export function newMessageId(senderAddress?: string): string {
  const domain = [senderAddress?.split('@').at(-1), new URL(env.publicBaseUrl).hostname]
    .map(value => domainToASCII(value?.trim() ?? '').toLowerCase())
    .find(value => value.length <= 253 && /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/.test(value)
      && !value.endsWith('.local')) ?? 'globalcrm.invalid';
  return `<${randomUUID()}@${domain}>`;
}

async function checkAutomaticDelivery(job: DevelopmentLetterDocument, customerEmail: string | undefined, user: AuthUser): Promise<string | undefined> {
  const campaignId = job.automationCampaignId;
  if (!campaignId) return;
  const [campaign, enrollment, project] = await Promise.all([
    OutreachAutomationConfig.exists({ _id: campaignId, projectId: job.projectId, userId: job.sentBy, enabled: true, rolloutMode: { $ne: 'shadow' } }),
    OutreachAutomationEnrollment.exists({ _id: job.automationEnrollmentId, campaignId, projectId: job.projectId, customerId: job.customerId, status: 'active' }),
    Project.findOne({ _id: job.projectId, status: 'active' }).select('organizationId brandProfile').lean(),
  ]);
  if (!campaign || !enrollment || !project || (project.organizationId && String(project.organizationId) !== user.organizationId)) {
    return '自动开发已暂停或所属项目权限发生变化';
  }
  if (customerEmail?.trim().toLowerCase() !== job.recipientEmail.trim().toLowerCase()) return '客户邮箱已变化，需重新准备开发信';
  const review = job.knowledgeReview;
  const approvedOffers = project.brandProfile?.approvedOffers;
  const issue = automatedReviewIssue(review, job.outreachStep, {
    bodyText: job.contentText,
    subject: job.subject,
    approvedOffers,
  });
  if (issue) return issue;
  if (!review || review.bodyHash !== draftHash(job.contentText) || review.context.customerId !== String(job.customerId)) {
    return '草稿正文或证据与当前客户不一致';
  }
  if (job.outreachStep && job.outreachStep >= 2) {
    const previous = await previousOutreachDrafts(String(job.projectId), String(job.customerId), job.outreachStep);
    const repeated = repeatedOutreachIssue(review, previous, {
      bodyText: job.contentText,
      step: job.outreachStep,
      approvedOffers,
    });
    if (repeated) return repeated;
  }
  const freshness = await knowledgeFreshness(review, user);
  if (freshness.failed || freshness.changed.length) return '发信前未能确认依据仍有效';
  return undefined;
}

// Apply counter + idempotency marker in ONE atomic customer update. A crash
// between this update and the job update is safe, including multiple workers.
async function reconcile(id: string): Promise<void> {
  const letter = await DevelopmentLetter.findById(id);
  if (!letter || !['sent', 'opened'].includes(letter.status)) return;
  await Customer.updateOne({ _id: letter.customerId, projectId: letter.projectId, mailEffectIds: { $ne: letter._id } }, {
    $inc: { letterCount: 1 }, $push: { mailEffectIds: { $each: [letter._id], $slice: -500 } },
    $max: { lastContactAt: letter.sentAt || letter.createdAt },
  });
  if (letter.agentOutreachId && letter.channel === 'smtp' && letter.sentBy) {
    await createFollowUp(String(letter.customerId), { method: 'email', result: 'no_reply',
      content: `首封开发信已发送（SMTP 已接受，等待客户回复）。主题：${letter.subject}；收件人：${letter.recipientEmail}。`,
      followUpAt: letter.sentAt || letter.createdAt }, String(letter.sentBy), String(letter.projectId),
      { agentActionKey: `first-outreach-sent:${letter.agentOutreachId}` });
    await AgentTask.updateOne({projectId:letter.projectId,analysisId:letter.agentOutreachId,status:{$in:['awaiting_review','cancelled']}},
      {$set:{status:'completed',sentLetterId:letter._id},$inc:{version:1},$push:{events:{$each:[{at:new Date(),message:'SMTP 已接受邮件，已自动新增首封开发信跟进记录。'}],$slice:-100}}});
  }
  await recordAgentSendReceipt(letter.id);
  if (letter.markAsDeveloped) await Customer.updateOne({ _id: letter.customerId, projectId: letter.projectId, status: 'pending' }, { $set: { status: 'contacted' } });
  // 开发信按 3/7/14 的节奏自动排下一次跟进（有回复就靠同步停表）
  try {
    await scheduleOutreachFollowUp(letter);
  } catch (error) {
    logger.warn('排开发信跟进失败（不影响投递结果）：', error instanceof Error ? error.message : String(error));
  }
  await DevelopmentLetter.updateOne({ _id: id, projectId: letter.projectId, status: { $in: ['sent', 'opened'] } }, { $set: { effectsPending: false } });
}

/** The atomic state transition is the only permission to contact SMTP. */
export async function processMailJob(id?: string, deliver: (payload: SendMailPayload) => Promise<SendMailResult> = sendMail): Promise<void> {
  const job = await DevelopmentLetter.findOneAndUpdate({
    ...(id ? { _id: id } : {}),
    status: { $in: ['queued', 'scheduled', 'retrying'] },
    nextAttemptAt: { $lte: new Date() },
  }, {
    $set: { status: 'sending', claimedAt: new Date() },
    $inc: { attempts: 1 },
    $push: { history: { at: new Date(), status: 'sending' } },
  }, { new: true, sort: { nextAttemptAt: 1 } }).select('+deliveryContent');
  if (!job) return;

  // A reassignment/disabled user/deleted customer must also revoke pending sends.
  const [customer, user] = await Promise.all([
    Customer.findOne({ _id: job.customerId, projectId: job.projectId }), job.sentBy ? User.findById(job.sentBy) : null,
  ]);
  const projectAccess = user?.role === 'admin' || user?.projectIds.some((id) => String(id) === String(job.projectId));
  if (!customer || !user || user.status === 'disabled' || user.role === 'viewer' || !projectAccess || (user.role === 'user' && String(customer.ownerId) !== String(user._id))) {
    await DevelopmentLetter.updateOne({ _id: job._id, status: 'sending' }, {
      $set: { status: 'cancelled', error: '客户或发送人权限已变化，任务已取消' },
      $push: { history: { at: new Date(), status: 'cancelled' } },
    });
    return;
  }

  // 开发信序列的后续邮件在真正到期发送前再查一次回复。
  // syncOutreachFollowUps 会取消候选任务，但这里覆盖“回复刚刚到达、
  // 定时任务已经被 worker claim”的竞态，不能只依赖客户字段是否已同步。
  // 只拦截真正的序列后续信，避免普通定时邮件被 outreachStep 误判。
  const sequenceFollowUp = Boolean(job.inReplyTo || job.agentOutreachId || job.automationCampaignId
    || job.automationEnrollmentId || job.agentTaskId);
  if (sequenceFollowUp && job.outreachStep && job.outreachStep > 1) {
    const replied = Boolean(customer.outreachRepliedAt)
      || await hasInboundReplySince(job.projectId, job.customerId, customer.outreachLastAt);
    if (replied) {
      const reason = '客户已回复，已停止后续开发信';
      await cancelPendingOutreachLetters(job.projectId, job.customerId, reason);
      await DevelopmentLetter.updateOne({ _id: job._id, status: 'sending' }, {
        $set: { status: 'cancelled', error: reason },
        $push: { history: { at: new Date(), status: 'cancelled', error: reason } },
      });
      return;
    }
  }

  if((job.agentOutreachId||job.agentTaskId)&&await hasProtectedCustomerMail(String(job.customerId),String(job.projectId))){
    await DevelopmentLetter.updateOne({_id:job._id,status:'sending'},{$set:{status:'cancelled',error:'检测到停止营销联系记录，已阻止投递'},$push:{history:{at:new Date(),status:'cancelled'}}});return;
  }
  const suppression = await isEmailSuppressed(String(job.projectId), job.recipientEmail);
  if (suppression) {
    await DevelopmentLetter.updateOne({ _id: job._id, status: 'sending' }, {
      $set: { status: 'cancelled', error: `收件人已进入不再发送名单（${suppression.reason}），已阻止投递` },
      $push: { history: { at: new Date(), status: 'cancelled', error: '收件人已退订或被标记为退信/投诉' } },
    });
    return;
  }
  if (job.automationCampaignId) {
    let reason: string | undefined;
    try {
      reason = await checkAutomaticDelivery(job, customer.email, {
        id: user.id, role: user.role, projectId: String(job.projectId), organizationId: user.organizationId?.toString(),
        username: user.username, displayName: user.displayName,
      });
      if (!reason && await hasInboundReplySince(job.projectId, job.customerId, customer.outreachLastAt ?? customer.createdAt)) {
        reason = '客户已回复，已停止自动开发';
      }
    } catch {
      reason = '发信前未能完成自动开发核对';
    }
    if (reason) {
      await DevelopmentLetter.updateOne({ _id: job._id, status: 'sending' }, {
        $set: { status: 'cancelled', error: reason },
        $push: { history: { at: new Date(), status: 'cancelled', error: reason } },
      });
      return;
    }
  }
  let result: SendMailResult;
  const accountId = job.mailAccountId ? String(job.mailAccountId) : undefined;
  const senderUserId = job.sentBy ? String(job.sentBy) : undefined;
  if (job.channel === 'smtp' && (!accountId || !senderUserId)) {
    result = { accepted: false, channel: 'smtp', error: '发送任务未绑定业务员邮箱，已阻止发送', durationMs: 0 };
  } else {
    try {
      if (accountId && senderUserId) await reserveMailAttempt(accountId, String(job.projectId), senderUserId);
      const isInboundReply = job.mailKind === 'inbound_reply';
      const html = job.deliveryContent || job.content;
      const withUnsubscribe = isInboundReply
        ? { html, text: job.contentText }
        : appendUnsubscribeFooter(
          html,
          job.contentText,
          String(job.projectId),
          job.recipientEmail,
          /<[a-z][\s\S]*>/i.test(html),
        );
      const deliverySubject = job.outreachStep && job.outreachStep > 1
        ? (stripReplySubjectPrefix(job.subject) || job.subject)
        : job.subject;
      const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
      if (job.attachmentIds?.length) {
        let totalAttachmentBytes = 0;
        for (const attachmentId of job.attachmentIds.slice(0, 5)) {
          try {
            const loaded = await getAttachmentForDownload(String(job.customerId), String(attachmentId), String(job.projectId));
            if (totalAttachmentBytes + loaded.buffer.length > 10 * 1024 * 1024) continue;
            totalAttachmentBytes += loaded.buffer.length;
            attachments.push({ filename: loaded.originalName, content: loaded.buffer, contentType: loaded.mimeType });
          } catch {
            logger.warn(`跳过不可读取的开发信附件 id=${String(attachmentId)}`);
          }
        }
      }
      result = await deliver({ projectId: String(job.projectId), mailAccountId: accountId, senderUserId, from: job.senderAddress,
        to: job.recipientEmail, toName: job.recipientName, subject: deliverySubject,
        html: withUnsubscribe.html, text: withUnsubscribe.text, messageId: job.messageId,
        inReplyTo: job.inReplyTo, references: job.references,
        ...(attachments.length ? { attachments } : {}),
        ...(isInboundReply ? {} : { headers: unsubscribeHeaders(String(job.projectId), job.recipientEmail) }) });
    } catch (error) {
      result = error instanceof Error && error.name === 'ApiError'
        ? { accepted: false, channel: job.channel, error: error.message, durationMs: 0 }
        : { accepted: false, channel: job.channel, uncertain: true, error: 'SMTP 结果未知，请核实邮箱后处理', durationMs: 0 };
    }
  }
  if (accountId && senderUserId) {
    await auditMailResult(accountId, String(job.projectId), senderUserId, result.accepted, result.error, Boolean(result.hardBounce)).catch(() => undefined);
  }
  if (result.hardBounce) {
    await suppressEmail({
      projectId: String(job.projectId),
      email: job.recipientEmail,
      reason: 'hard_bounce',
      source: 'smtp',
      note: result.error?.slice(0, 500),
      global: true,
    }).catch(() => undefined);
  }
  const retry = !result.accepted && result.retryable && !result.uncertain && job.attempts < env.MAIL_MAX_ATTEMPTS;
  const status = result.accepted ? 'sent' : retry ? 'retrying' : 'failed';
  const at = new Date();
  // Never retry SMTP if this DB write fails: the durable state stays 'sending'
  // and recovery marks it for human reconciliation.
  await DevelopmentLetter.updateOne({ _id: job._id, status: 'sending' }, {
    $set: { status, channel: result.channel, sentAt: result.accepted ? at : undefined,
      ...(result.hardBounce ? { hardBouncedAt: at } : {}),
      error: result.accepted ? '' : result.error || 'SMTP 发送失败',
      needsReview: Boolean(result.uncertain), effectsPending: result.accepted,
      'tracking.enabled': Boolean(result.accepted && job.tracking?.prepared),
      nextAttemptAt: new Date(at.getTime() + env.MAIL_RETRY_DELAY_MS * 2 ** (job.attempts - 1)) },
    $push: { history: { $each: [{ at, status, error: result.accepted ? undefined : result.error }], $slice: -50 } },
  });
  if (result.accepted) await reconcile(String(job._id));
}

let running = false;
export async function runMailQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await DevelopmentLetter.updateMany({ status: 'sending', claimedAt: { $lt: new Date(Date.now() - 120000) } }, {
      $set: { status: 'failed', needsReview: true, error: '发送期间服务中断，投递结果未知；请核实，系统不会自动重发' },
      $push: { history: { at: new Date(), status: 'failed', error: '投递结果待核实' } },
    });
    for (let i = 0; i < 10; i++) await processMailJob();
    const pending = await DevelopmentLetter.find({ effectsPending: true, status: { $in: ['sent', 'opened'] } }).limit(100).select('_id');
    for (const job of pending) await reconcile(String(job._id));
  } catch {
    logger.warn('发送队列本轮失败，下轮继续；未输出原始错误以保护邮件配置');
  } finally { running = false; }
}
