import env from '../config/env';
import { builtinBrandPackage } from '../services/playbook-import.service';
import { createHash } from 'node:crypto';
import type { Migration } from './types';

const legacyProjects = [
  { key: 'genesis', slug: 'genesis-bags', code: 'GENESIS' },
  { key: 'ironhue', slug: 'ironhue', code: 'IRONHUE' },
  { key: 'velaturo', slug: 'velaturo', code: 'VELATURO' },
] as const;

export const projectBrandPackagesMigration: Migration = {
  id: '20261118-015-project-brand-packages',
  version: 1,
  name: 'Bind legacy brand packages to their existing workspaces',
  async up(connection) {
    const organization = await connection.collection('organizations').findOne({ slug: env.DEFAULT_ORGANIZATION_SLUG });
    if (!organization) return;
    const projects = connection.collection('projects');
    const playbooks = connection.collection('projectplaybooks');
    for (const legacy of legacyProjects) {
      const project = await projects.findOne({ organizationId: organization._id, slug: legacy.slug, code: legacy.code, mailProfileKey: legacy.slug });
      if (!project) continue;
      const filter = { organizationId: organization._id, projectId: project._id };
      const existing = await playbooks.findOne({ projectId: project._id });
      if (existing?.organizationId && !existing.organizationId.equals(organization._id)) {
        throw new Error('Brand package ownership does not match its project');
      }
      if (existing?.activePackage) {
        // A rerun after an interrupted final write can finish the project binding.
        if (existing.activePackage.release === 'legacy-1.0.0' &&
          JSON.stringify(project.brandProfile ?? {}) === JSON.stringify(existing.previousPackage?.profile ?? {})) {
          await projects.updateOne({ _id: project._id, organizationId: organization._id }, { $set: { brandProfile: existing.activePackage.profile } });
        }
        continue;
      }
      const bundle = builtinBrandPackage(legacy.key);
      const cards = (kind: 'segment' | 'preference') => bundle.playbook.cards.filter(card => card.kind === kind).map(({ kind: _kind, ...card }) => card);
      const previous = { release: 'legacy', profile: project.brandProfile ?? {}, segments: existing?.segments ?? cards('segment'), preferences: existing?.preferences ?? cards('preference') };
      const snapshot = { release: bundle.release, profile: { ...bundle.profile, ...project.brandProfile, brandKey: legacy.key },
        segments: previous.segments, preferences: previous.preferences };
      const withDigest = <T>(value: T) => ({ ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') });
      const result = await playbooks.updateOne({ projectId: project._id, activePackage: { $exists: false } }, {
        $set: { ...filter, segments: snapshot.segments, preferences: snapshot.preferences, updatedAt: new Date(),
          activePackage: withDigest(snapshot), previousPackage: withDigest(previous) },
        $setOnInsert: { createdAt: new Date() }, $inc: { version: 1 },
      }, { upsert: true });
      if (!result.matchedCount && !result.upsertedCount) throw new Error('Could not bind private brand package');
      await projects.updateOne({ _id: project._id, organizationId: organization._id }, { $set: { brandProfile: snapshot.profile } });
    }
  },
};
