import '../models';
import '../models/OutreachExperiment';
import '../models/OutreachExemplar';
import '../services/knowledge/operations';
import '../services/agent/knowledge-governance';
import type { Migration } from './types';

/**
 * 016: Outreach analytics, experiment/exemplar indexes, missing dynamic model indexes
 * (KnowledgeMetric, KnowledgeGovernancePreview), and safe log/run TTL retention indexes.
 */
export const outreachCompleteIndexesMigration: Migration = {
  id: '20261119-016-outreach-complete-indexes',
  version: 1,
  name: 'Create outreach analytics, experiment, exemplar, and retention TTL indexes',
  async up(connection) {
    // 1. Campaign results & reply attribution hot-path indexes
    await connection.collection('developmentletters').createIndex(
      { projectId: 1, automationCampaignId: 1, sentAt: -1 },
      { background: true },
    );
    await connection.collection('developmentletters').createIndex(
      { projectId: 1, sentAt: -1 },
      { background: true },
    );
    await connection.collection('mailmessages').createIndex(
      { projectId: 1, inReplyTo: 1 },
      { background: true },
    );

    // 2. Retention TTL indexes for operational logs & run records (idempotent)
    const ttlSpecs: Array<{ collection: string; field: string; seconds: number }> = [
      { collection: 'auditlogs', field: 'createdAt', seconds: 365 * 86400 },
      { collection: 'integrationrequestlogs', field: 'createdAt', seconds: 90 * 86400 },
      { collection: 'agentruns', field: 'createdAt', seconds: 180 * 86400 },
      { collection: 'agentactions', field: 'createdAt', seconds: 180 * 86400 },
      { collection: 'agentevalruns', field: 'createdAt', seconds: 180 * 86400 },
      { collection: 'prospectingruns', field: 'createdAt', seconds: 180 * 86400 },
      { collection: 'prospectenrichruns', field: 'createdAt', seconds: 180 * 86400 },
    ];
    for (const spec of ttlSpecs) {
      const col = connection.collection(spec.collection);
      const existing = await col.indexes().catch(() => []);
      const hasTtlOnField = existing.some(
        (idx) => idx.key && (idx.key as Record<string, unknown>)[spec.field] === 1 && typeof idx.expireAfterSeconds === 'number',
      );
      if (!hasTtlOnField) {
        try {
          await col.createIndex(
            { [spec.field]: 1 },
            { expireAfterSeconds: spec.seconds, name: `ttl_${spec.field}_${spec.seconds}`, background: true },
          );
        } catch {
          // If an existing non-TTL single-field index with same key exists, skip without crashing upgrade
        }
      }
    }

    // 3. Ensure all registered Mongoose models (including newly imported dynamic models) have their indexes
    for (const name of ['OutreachExperiment', 'OutreachExemplar', 'KnowledgeMetric', 'KnowledgeGovernancePreview']) {
      if (connection.modelNames().includes(name)) {
        await connection.model(name).createIndexes();
      }
    }
  },
};
