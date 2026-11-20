import path from 'node:path';
import { runOutreachEvaluationCli } from '../services/agent/outreach-eval';

async function main() {
  const defaultSamplesPath = path.resolve(__dirname, '../../evaluation/outreach/samples.json');
  const report = await runOutreachEvaluationCli(process.argv.slice(2), defaultSamplesPath);
  if (!report.gatePassed) process.exit(1);
}

main().catch((err) => {
  console.error('Outreach evaluation failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
