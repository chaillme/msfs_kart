// Starts the game server (ws://127.0.0.1:8787) and the Vite dev client (http://127.0.0.1:5188) together.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx tsx watch server/src/index.ts', { stdio: 'inherit', shell: true }),
  spawn('npm --prefix client run dev', { stdio: 'inherit', shell: true }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
