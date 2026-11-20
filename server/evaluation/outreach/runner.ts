import path from 'node:path';
import { runOutreachEvaluationCli } from '../../src/services/agent/outreach-eval';

async function main() {
  const report = await runOutreachEvaluationCli(
    process.argv.slice(2),
    path.resolve(__dirname, 'samples.json'),
  );
  if (!report.gatePassed) process.exit(1);
}

main().catch((err) => {
  const code = err && typeof err === 'object' && 'code' in err ? ` [${String((err as { code?: unknown }).code)}]` : '';
  console.error(`Outreach evaluation failed:${code}`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
