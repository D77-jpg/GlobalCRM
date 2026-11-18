import '../models';
import '../models/AgentAutomation';
import '../models/AgentBatch';
import '../models/AgentKnowledge';
import '../models/AgentTask';
import '../models/CustomerAgreement';
import '../models/IntegrationPublicResource';
import '../models/KnowledgeDocument';
import '../models/KnowledgeIndex';
import '../models/MailMessage';
import '../models/OAuth';
import '../models/Prospect';
import '../models/ProspectEnrichRun';
import '../models/ProspectingConfig';
import '../models/ProspectingRun';
import '../models/TemplateSuggestion';
import '../models/WebsiteResearch';
import type { Migration } from './types';

export const productionIndexesMigration: Migration = {
  id: '20261118-014-production-indexes',
  version: 1,
  name: 'Build production indexes and restore knowledge organization ownership',
  async up(connection) {
    const knowledgeArtifacts = ['KnowledgeChunk', 'KnowledgeIndexItem'];
    const projects = connection.collection('projects').find({ organizationId: { $type: 'objectId' } }, {
      projection: { _id: 1, organizationId: 1 },
    });
    for await (const project of projects) {
      for (const modelName of knowledgeArtifacts) {
        await connection.model(modelName).collection.updateMany(
          { projectId: project._id, organizationId: null },
          { $set: { organizationId: project.organizationId } },
        );
      }
    }
    const names = connection.modelNames().sort();
    for (const name of names) {
      try {
        await connection.model(name).createIndexes();
      } catch (error) {
        const code = (error as { code?: number }).code;
        throw new Error(`Index creation failed for ${name}${code ? ` (MongoDB ${code})` : ''}`);
      }
    }
  },
};
