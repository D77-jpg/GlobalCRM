import '../models';
import type { Migration } from './types';

/**
 * 017: Workbench v2.7 indexes for ProjectPolicy, CustomerWorkbenchItem, CustomerRfq,
 * and cross-customer quotation / approval hot paths.
 */
export const workbenchUpgradeIndexesMigration: Migration = {
  id: '20261121-017-workbench-upgrade-indexes',
  version: 1,
  name: 'Create workbench policy, commitment/open-question, RFQ, and quotation approval indexes',
  async up(connection) {
    for (const name of ['ProjectPolicy', 'CustomerWorkbenchItem', 'CustomerRfq']) {
      if (connection.modelNames().includes(name)) {
        await connection.model(name).createIndexes();
      }
    }
    await connection.collection('quotations').createIndex(
      { projectId: 1, approvalStatus: 1, updatedAt: -1 },
      { background: true },
    );
    await connection.collection('customers').createIndex(
      { projectId: 1, status: 1, intentScore: -1 },
      { background: true },
    );
  },
};
