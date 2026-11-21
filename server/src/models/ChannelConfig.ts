import './tenant-setup';
import { Schema, model, Types, type HydratedDocument, type Model } from 'mongoose';
import type { EncryptedSecret } from '../services/credential-crypto';

export interface IChannelConfig {
  projectId: Types.ObjectId;
  whatsappEnabled: boolean;
  phoneNumberId?: string;
  businessAccountId?: string;
  displayPhoneNumber?: string;
  accessTokenEncrypted?: EncryptedSecret;
  appSecretEncrypted?: EncryptedSecret;
  verifyTokenEncrypted?: EncryptedSecret;
  webhookLastReceivedAt?: Date;
  webhookLastError?: string;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelConfigDocument = HydratedDocument<IChannelConfig>;
export type ChannelConfigModel = Model<IChannelConfig>;

const encryptedSecretSchema = new Schema<EncryptedSecret>({
  ciphertext: { type: String, required: true },
  iv: { type: String, required: true },
  tag: { type: String, required: true },
}, { _id: false });

const ChannelConfigSchema = new Schema<IChannelConfig>({
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  whatsappEnabled: { type: Boolean, default: false },
  phoneNumberId: { type: String, trim: true, maxlength: 120 },
  businessAccountId: { type: String, trim: true, maxlength: 120 },
  displayPhoneNumber: { type: String, trim: true, maxlength: 60 },
  accessTokenEncrypted: { type: encryptedSecretSchema },
  appSecretEncrypted: { type: encryptedSecretSchema },
  verifyTokenEncrypted: { type: encryptedSecretSchema },
  webhookLastReceivedAt: { type: Date },
  webhookLastError: { type: String, trim: true, maxlength: 500 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true, versionKey: false });

ChannelConfigSchema.index({ projectId: 1 }, { unique: true });

export const ChannelConfig = model<IChannelConfig, ChannelConfigModel>('ChannelConfig', ChannelConfigSchema);
export default ChannelConfig;
