import '../models';
import type { Migration } from './types';

export const omnichannelInboxIndexesMigration: Migration = {
  id: '20261121-018-omnichannel-inbox-indexes',
  version: 1,
  name: 'Create omnichannel & WhatsApp Cloud API config, conversation, and message indexes',
  async up(connection) {
    for (const modelName of ['ChannelConfig', 'ChannelConversation', 'ChannelMessage']) {
      if (connection.modelNames().includes(modelName)) {
        await connection.model(modelName).createIndexes();
      }
    }
  },
};
