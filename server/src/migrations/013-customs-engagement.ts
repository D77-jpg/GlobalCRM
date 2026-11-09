import type { Migration } from './types';
import { CustomsAlert, CustomsScore, CustomsUsage, CustomsWatch } from '../models/Customs';

export const customsEngagementMigration: Migration = {
  id: '20261109-013-customs-engagement',
  version: 1,
  name: 'Create customs watch alert score and usage indexes',
  async up() {
    for (const model of [CustomsWatch, CustomsAlert, CustomsScore, CustomsUsage]) await model.createIndexes();
  },
};
