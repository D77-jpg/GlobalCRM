import type { Migration } from './types';
import { customsModels } from '../models/Customs';

export const customsDataMigration: Migration = {
  id: '20261109-012-customs-data',
  version: 1,
  name: 'Create tenant-scoped customs data indexes',
  async up() {
    for (const model of customsModels) await model.createIndexes();
  },
};
