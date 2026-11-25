/**
 * MSF Supply Kart server entry point.
 *   npx tsx server/src/index.ts [--port 8787] [--host 127.0.0.1]
 * Use --host 0.0.0.0 to let other computers on the local network join.
 */
import { startServer } from './app';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// GAME_PORT / GAME_HOST first (dev tools often set PORT for the web client); on a host
// such as Render, RENDER is set and the platform's PORT is the one to listen on.
const port = Number(arg('port', process.env.GAME_PORT ?? (process.env.RENDER ? process.env.PORT : undefined) ?? '8787'));
const host = arg('host', process.env.GAME_HOST ?? '127.0.0.1');
const server = await startServer(port, host);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
