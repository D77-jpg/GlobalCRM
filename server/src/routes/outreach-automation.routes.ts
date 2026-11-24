import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { sendSuccess } from '../utils/pagination';
import { validate } from '../middleware/validate.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { requireProjectId } from '../utils/access';
import {
  auditLegacyOutreachCampaigns,
  controlOutreachEnrollment,
  drainQueuedOutreachTasks,
  getOutreachAutomationOverview,
  getOutreachEnrollmentDiagnostics,
  migrateLegacyOutreachModes,
  pauseOutreachAutomation,
  recoverCircuitFailedEnrollments,
  regenerateOutreachEnrollmentDraft,
  resumeOutreachAutomation,
  reverifyUnverifiedOutreachDrafts,
  saveOutreachAutomationConfig,
  getOutreachResults,
  startOutreachAutomation,
} from '../services/outreach-automation.service';
import { crossBrandOutreachResults } from '../services/outreach-results.service';
import {
  createOutreachExperiment,
  evaluateOutreachExperiment,
  listOutreachExperiments,
  stopOutreachExperiment,
} from '../services/outreach-experiment.service';
import { harvestWinningExemplars, listWinningExemplars } from '../services/winning-exemplar.service';

const router = Router();
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'ID 格式不正确');
const configInput = z.object({
  rolloutMode: z.enum(['shadow', 'pilot', 'active']).optional(),
  expectedVersion: z.number().int().min(0),
  dailyLimit: z.number().int().min(1).max(20),
  perDomainLimit: z.number().int().min(1).max(10),
  windowStart: z.string().regex(/^\d{2}:\d{2}$/, '开始时间格式不正确'),
  windowEnd: z.string().regex(/^\d{2}:\d{2}$/, '结束时间格式不正确'),
  timezone: z.string().trim().min(1).max(80),
  useBuyerTimezone: z.boolean().optional(),
  minPacingSeconds: z.number().int().min(30).max(3600).optional(),
  maxPacingSeconds: z.number().int().min(60).max(7200).optional(),
}).strict();
const startInput = z.object({
  customerIds: z.array(objectId).max(500).optional(),
}).strict();
const targetUserId = (req: Request): string | undefined =>
  typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;

router.get('/', asyncHandler(async (req, res) => {
  sendSuccess(res, await getOutreachAutomationOverview(req.user!, targetUserId(req)));
}));
router.get('/upgrade-audit', requireRole('admin'), asyncHandler(async (req, res) => {
  sendSuccess(res, await auditLegacyOutreachCampaigns(req.user!));
}));
router.post('/migrate-legacy-modes', requireRole('admin'), validate({
  body: z.object({ targetMode: z.enum(['shadow', 'pilot', 'active']) }).strict(),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await migrateLegacyOutreachModes(req.body.targetMode, req.user!));
}));
router.get('/results', asyncHandler(async (req, res) => {
  sendSuccess(res, await getOutreachResults(req.user!, targetUserId(req)));
}));
router.get('/results/cross-brand', requireRole('admin'), asyncHandler(async (req, res) => {
  const windowDays = Number(req.query.windowDays ?? 30) || 30;
  sendSuccess(res, await crossBrandOutreachResults(req.user!.organizationId ?? '', windowDays));
}));
router.get('/experiments', asyncHandler(async (req, res) => {
  sendSuccess(res, await listOutreachExperiments(req.user!));
}));
router.post('/experiments', requireRole('admin'), validate({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    controlVersion: z.string().trim().min(1).max(60),
    treatmentVersion: z.string().trim().min(1).max(60),
    stratifyBy: z.array(z.enum(['brand', 'data_tier', 'contact_role'])).optional(),
    observationWindowDays: z.number().int().min(3).max(90).optional(),
    minSamplePerArm: z.number().int().min(10).max(1000).optional(),
    customerIds: z.array(objectId).max(1000).optional(),
  }).strict(),
}), asyncHandler(async (req, res) => {
  sendSuccess(res, await createOutreachExperiment(req.body, req.user!), 201);
}));
router.get('/experiments/:id', validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
  sendSuccess(res, await evaluateOutreachExperiment(req.params.id, req.user!));
}));
router.post('/experiments/:id/stop', requireRole('admin'), validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
  sendSuccess(res, await stopOutreachExperiment(req.params.id, req.user!));
}));
router.get('/exemplars', asyncHandler(async (req, res) => {
  const segmentCode = typeof req.query.segmentCode === 'string' ? req.query.segmentCode : undefined;
  const outreachStep = req.query.step ? Number(req.query.step) : undefined;
  sendSuccess(res, await listWinningExemplars(requireProjectId(req.user!), { segmentCode, outreachStep }));
}));
router.post('/exemplars/harvest', requireRole('admin'), asyncHandler(async (req, res) => {
  const windowDays = Number(req.body?.windowDays ?? 90) || 90;
  sendSuccess(res, await harvestWinningExemplars(req.user!, windowDays), 201);
}));

router.put('/', validate({ body: configInput }), asyncHandler(async (req, res) => {
  sendSuccess(res, await saveOutreachAutomationConfig(req.body, req.user!, targetUserId(req)));
}));

router.post('/start', validate({ body: startInput }), asyncHandler(async (req, res) => {
  sendSuccess(res, await startOutreachAutomation(req.user!, req.body.customerIds, targetUserId(req)));
}));

router.post('/pause', asyncHandler(async (req, res) => {
  sendSuccess(res, await pauseOutreachAutomation(req.user!, targetUserId(req)));
}));

router.post('/resume', asyncHandler(async (req, res) => {
  sendSuccess(res, await resumeOutreachAutomation(req.user!, targetUserId(req)));
}));

router.post('/reverify-unverified', validate({
  body: z.object({
    enrollmentIds: z.array(objectId).max(200).optional(),
  }).strict().optional(),
}), asyncHandler(async (req, res) => {
  const enrollmentIds = req.body && Array.isArray(req.body.enrollmentIds) ? req.body.enrollmentIds : undefined;
  sendSuccess(res, await reverifyUnverifiedOutreachDrafts(req.user!, { enrollmentIds }, targetUserId(req)));
}));

router.post('/drain-queued-tasks', asyncHandler(async (req, res) => {
  sendSuccess(res, await drainQueuedOutreachTasks(req.user!, targetUserId(req)));
}));

router.post('/recover-circuit-failed', asyncHandler(async (req, res) => {
  sendSuccess(res, await recoverCircuitFailedEnrollments(req.user!, targetUserId(req)));
}));

for (const action of ['pause', 'resume'] as const) {
  router.post(`/enrollments/:id/${action}`, validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
    sendSuccess(res, await controlOutreachEnrollment(req.user!, req.params.id, action, targetUserId(req)));
  }));
}

router.post('/enrollments/:id/regenerate', validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
  sendSuccess(res, await regenerateOutreachEnrollmentDraft(req.user!, req.params.id, targetUserId(req)));
}));

router.get('/enrollments/:id/diagnostics', validate({ params: z.object({ id: objectId }) }), asyncHandler(async (req, res) => {
  sendSuccess(res, await getOutreachEnrollmentDiagnostics(req.user!, req.params.id, targetUserId(req)));
}));

export default router;
