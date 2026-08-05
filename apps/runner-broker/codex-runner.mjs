import process from 'node:process';

const input = await new Promise((resolve, reject) => {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  process.stdin.on('error', reject);
});
const job = JSON.parse(input || '{}');
if (!['read', 'write', 'assist', 'test', 'review'].includes(job.mode)) process.exit(2);
process.stdout.write(JSON.stringify({ exit_code: 0, task_id: job.task_id, execution_id: job.execution_id }));
