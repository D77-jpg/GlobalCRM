import mongoose from 'mongoose';
import env from '../config/env';
import { migrations } from '../migrations/registry';
import { migrationState } from '../migrations/runner';

async function main() {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    // 1. Check replica set / transaction support
    try {
      const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
      const hasRs = Boolean(hello.setName);
      checks.push({ name: 'mongodb_replica_set', ok: hasRs, detail: hasRs ? `replicaSet=${hello.setName}` : '未启用副本集，事务型迁移与品牌包写入将失败' });
    } catch {
      checks.push({ name: 'mongodb_replica_set', ok: false, detail: '无法读取 MongoDB hello 状态' });
    }

    // 2. Check migrations applied via official schema_migrations state
    const state = await migrationState({ connection: mongoose.connection, registry: migrations });
    const migrationsOk = state.pending.length === 0 && state.changed.length === 0;
    const migrationDetail = migrationsOk
      ? `全部 ${migrations.length} 项迁移已执行`
      : [
          state.pending.length ? `待执行迁移：${state.pending.join(', ')}` : '',
          state.changed.length ? `校验和变更：${state.changed.join(', ')}` : '',
        ].filter(Boolean).join('；');
    checks.push({
      name: 'migrations_complete',
      ok: migrationsOk,
      detail: migrationDetail,
    });

    // 3. Check 014 knowledge tenant ownership backfill
    const nullChunks = await mongoose.connection.collection('knowledgechunks').countDocuments({ organizationId: null });
    const nullIndexItems = await mongoose.connection.collection('knowledgeindexitems').countDocuments({ organizationId: null });
    checks.push({
      name: 'knowledge_tenant_ownership',
      ok: nullChunks === 0 && nullIndexItems === 0,
      detail: `null organizationId: chunks=${nullChunks}, indexItems=${nullIndexItems}`,
    });

    // 4. Check 015 brand package binding
    const activeProjects = await mongoose.connection.collection('projects').countDocuments({ status: 'active' });
    const boundPlaybooks = await mongoose.connection.collection('projectplaybooks').countDocuments({ activePackage: { $exists: true } });
    checks.push({
      name: 'brand_package_binding',
      ok: boundPlaybooks > 0 || activeProjects === 0,
      detail: `activeProjects=${activeProjects}, boundPlaybooks=${boundPlaybooks}`,
    });

    // 5. Check legacy OutreachAutomationConfig missing rolloutMode
    const legacyUnset = await mongoose.connection.collection('outreachautomationconfigs').countDocuments({
      $or: [{ rolloutMode: { $exists: false } }, { rolloutMode: null }],
    });
    const queuedOutreach = await mongoose.connection.collection('developmentletters').countDocuments({
      automationCampaignId: { $exists: true, $ne: null },
      status: { $in: ['queued', 'scheduled', 'retrying'] },
    });
    checks.push({
      name: 'outreach_legacy_modes',
      ok: legacyUnset === 0,
      detail: `unsetRolloutMode=${legacyUnset}, pendingQueuedOutreach=${queuedOutreach}`,
    });

    // 6. Check HTTPS & production transport readiness
    const httpsReady = /^https:\/\//i.test(env.TRACKING_BASE_URL) && env.corsOrigins.every((o) => o === '*' || /^https:\/\//i.test(o));
    checks.push({
      name: 'https_and_origin_config',
      ok: env.NODE_ENV !== 'production' || httpsReady,
      detail: `NODE_ENV=${env.NODE_ENV}, TRACKING_BASE_URL_HTTPS=${/^https:\/\//i.test(env.TRACKING_BASE_URL)}`,
    });

    const verifiedMailboxes = await mongoose.connection.collection('usermailaccounts').countDocuments({
      status: 'active',
      verificationStatus: 'verified',
    });
    const publishedKnowledge = await mongoose.connection.collection('agentknowledges').countDocuments({
      archived: { $ne: true },
      approvedVersion: { $gte: 1 },
    });
    checks.push({
      name: 'live_mailboxes_and_knowledge',
      ok: verifiedMailboxes > 0 && publishedKnowledge > 0,
      detail: `verifiedMailboxes=${verifiedMailboxes}, publishedKnowledgeEntries=${publishedKnowledge}`,
    });

    for (const c of checks) {
      console.log(`${c.ok ? '[PASS]' : '[WARN]'} ${c.name}: ${c.detail}`);
    }
    const hardFailed = checks.filter((c) => !c.ok && ['mongodb_replica_set', 'migrations_complete', 'knowledge_tenant_ownership'].includes(c.name));
    if (hardFailed.length) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('Upgrade verification failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
