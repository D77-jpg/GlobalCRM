import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';

export const OMNICHANNEL_TYPES = ['whatsapp', 'alibaba', 'instagram', 'trademanager', 'wechat', 'web_chat'] as const;
export type OmnichannelType = (typeof OMNICHANNEL_TYPES)[number];

export const CONVERSATION_STATUSES = ['open', 'pending_followup', 'resolved', 'archived'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface IChannelConversation {
  projectId: Types.ObjectId;
  customerId?: Types.ObjectId;
  ownerId?: Types.ObjectId;
  channel: OmnichannelType;
  externalContactId: string;
  contactName: string;
  contactCompany?: string;
  contactCountry?: string;
  contactPhone?: string;
  contactEmail?: string;
  status: ConversationStatus;
  starred: boolean;
  tags: string[];
  unreadCount: number;
  mode: 'api_live' | 'manual_assist';
  lastMessagePreview: string;
  lastMessageDirection: 'inbound' | 'outbound';
  lastMessageAt: Date;
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelConversationDocument = HydratedDocument<IChannelConversation>;
export type ChannelConversationModel = Model<IChannelConversation>;

const ChannelConversationSchema = new Schema<IChannelConversation>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', index: true },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  channel: { type: String, enum: OMNICHANNEL_TYPES, required: true, index: true },
  externalContactId: { type: String, required: true, trim: true, maxlength: 160 },
  contactName: { type: String, required: true, trim: true, maxlength: 160 },
  contactCompany: { type: String, trim: true, maxlength: 200 },
  contactCountry: { type: String, trim: true, maxlength: 80 },
  contactPhone: { type: String, trim: true, maxlength: 60 },
  contactEmail: { type: String, trim: true, maxlength: 160 },
  status: { type: String, enum: CONVERSATION_STATUSES, default: 'open', index: true },
  starred: { type: Boolean, default: false, index: true },
  tags: { type: [String], default: [] },
  unreadCount: { type: Number, default: 0, min: 0 },
  mode: { type: String, enum: ['api_live', 'manual_assist'], default: 'manual_assist' },
  lastMessagePreview: { type: String, default: '', maxlength: 400 },
  lastMessageDirection: { type: String, enum: ['inbound', 'outbound'], default: 'inbound' },
  lastMessageAt: { type: Date, default: () => new Date(), index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, versionKey: false });

ChannelConversationSchema.index({ projectId: 1, channel: 1, externalContactId: 1 }, { unique: true });
ChannelConversationSchema.index({ projectId: 1, status: 1, lastMessageAt: -1 });
ChannelConversationSchema.index({ projectId: 1, customerId: 1, lastMessageAt: -1 });

export const ChannelConversation = model<IChannelConversation, ChannelConversationModel>(
  'ChannelConversation',
  ChannelConversationSchema,
);
export default ChannelConversation;
