import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import { OMNICHANNEL_TYPES, type OmnichannelType } from './ChannelConversation';

export type ChannelDeliveryStatus = 'received' | 'logged_manual' | 'sent_api' | 'delivered' | 'read' | 'failed';

export interface IChannelAttachment {
  name: string;
  mimeType?: string;
  size?: number;
  quotationId?: string;
  quotationNo?: string;
}

export interface IChannelMessage {
  projectId: Types.ObjectId;
  conversationId: Types.ObjectId;
  customerId?: Types.ObjectId;
  channel: OmnichannelType;
  direction: 'inbound' | 'outbound';
  deliveryStatus: ChannelDeliveryStatus;
  externalMessageId?: string;
  text: string;
  zhTranslation?: string;
  detectedLang?: string;
  attachments: IChannelAttachment[];
  senderName?: string;
  createdBy?: Types.ObjectId;
  errorMessage?: string;
  sentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelMessageDocument = HydratedDocument<IChannelMessage>;
export type ChannelMessageModel = Model<IChannelMessage>;

const attachmentSchema = new Schema<IChannelAttachment>({
  name: { type: String, required: true, trim: true, maxlength: 200 },
  mimeType: { type: String, trim: true, maxlength: 120 },
  size: { type: Number, min: 0 },
  quotationId: { type: String, trim: true, maxlength: 60 },
  quotationNo: { type: String, trim: true, maxlength: 80 },
}, { _id: false });

const ChannelMessageSchema = new Schema<IChannelMessage>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  conversationId: { type: Schema.Types.ObjectId, ref: 'ChannelConversation', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  channel: { type: String, enum: OMNICHANNEL_TYPES, required: true },
  direction: { type: String, enum: ['inbound', 'outbound'], required: true },
  deliveryStatus: {
    type: String,
    enum: ['received', 'logged_manual', 'sent_api', 'delivered', 'read', 'failed'],
    default: 'received',
  },
  externalMessageId: { type: String, trim: true, maxlength: 200 },
  text: { type: String, required: true, maxlength: 20000 },
  zhTranslation: { type: String, maxlength: 20000 },
  detectedLang: { type: String, trim: true, maxlength: 32 },
  attachments: { type: [attachmentSchema], default: [] },
  senderName: { type: String, trim: true, maxlength: 160 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  errorMessage: { type: String, trim: true, maxlength: 500 },
  sentAt: { type: Date, default: () => new Date(), index: true },
}, { timestamps: true, versionKey: false });

ChannelMessageSchema.index({ projectId: 1, conversationId: 1, sentAt: 1 });
ChannelMessageSchema.index(
  { projectId: 1, externalMessageId: 1 },
  { unique: true, partialFilterExpression: { externalMessageId: { $type: 'string' } } },
);
ChannelMessageSchema.index({ projectId: 1, sentAt: -1 });

export const ChannelMessage = model<IChannelMessage, ChannelMessageModel>('ChannelMessage', ChannelMessageSchema);
export default ChannelMessage;
