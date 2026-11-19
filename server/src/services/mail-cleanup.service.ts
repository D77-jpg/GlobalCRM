import { Types } from 'mongoose';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DevelopmentLetter } from '../models/DevelopmentLetter';
import { MailMessage } from '../models/MailMessage';
import env from '../config/env';
import { deleteObject } from './storage.service';
import { ApiError } from '../utils/ApiError';

export async function prepareMailDeletion(customerIds: Types.ObjectId[], projectId: Types.ObjectId): Promise<void> {
  const scope = { projectId, customerId: { $in: customerIds } };
  await DevelopmentLetter.updateMany({ ...scope, status: { $in: ['queued', 'scheduled', 'retrying'] } }, {
    $set: { status: 'cancelled' }, $push: { history: { $each: [{ at: new Date(), status: 'cancelled' }], $slice: -50 } },
  });
  if (await DevelopmentLetter.exists({ ...scope, $or: [{ status: 'sending' }, { needsReview: true }] })) {
    throw ApiError.conflict('客户有发送中或投递结果待核实的任务，请稍后处理');
  }
}

export async function purgeCustomerMail(customerIds: Types.ObjectId[], projectId: Types.ObjectId): Promise<void> {
  const docs = await MailMessage.find({ projectId, customerId: { $in: customerIds }, deleted: { $ne: true } }).select('+attachments.filename');
  for (const doc of docs) {
    const files = doc.attachments.map(a => a.filename).filter((v): v is string => Boolean(v));
    // A minimal tombstone prevents a later IMAP cursor reset from resurrecting
    // deliberately deleted customer mail. It contains no customer/body/attachment data.
    await MailMessage.updateOne({ _id: doc._id, projectId }, { $set: { deleted: true, customerId: null, from: '', fromName: '', to: [], cc: [], html: '', text: '', subject: '', normalizedSubject: '', references: [], readBy: [], attachments: [], threadId: '' }, $unset: { messageId: 1, inReplyTo: 1 } });
    for (const filename of files) {
      if (path.basename(filename) === filename) {
        // 统一走对象存储抽象（兼容 local 与 S3）；同时清理 V2.1/V2.5 本地旧路径。
        await Promise.all([
          deleteObject(`mail/${String(projectId)}/${filename}`).catch(() => undefined),
          fs.unlink(path.join(env.UPLOAD_DIR, 'mail', filename)).catch(() => undefined),
        ]);
      }
    }
  }
}
