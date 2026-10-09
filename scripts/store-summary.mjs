import { appendFile, readFile } from 'node:fs/promises';

const [browser, path] = process.argv.slice(2);
const store = browser === 'chrome' ? 'Chrome Web Store' : 'Firefox AMO';
let summary = `${store}: submission/status check did not complete. Check the failed step for missing credentials, validation, or store errors.\n`;
try {
  const result = JSON.parse(await readFile(path, 'utf8'));
  const state = result.state || result.submittedState || result.publishedState || 'not-submitted';
  summary = `${store} ${result.version}: ${state}.\n\n`;
  if (result.reviewerSourceAttached) summary += 'Firefox reviewer source is attached.\n\n';
  summary += 'Submission, store review, approval, and public rollout are separate. Confirm the store listing before reporting a version as live.\n';
} catch { /* A failed preflight must still produce a useful job summary. */ }
console.log(summary.trim());
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
