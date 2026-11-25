/** HTTP + WebSocket game server factory (used by index.ts and the tests). */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildTrack } from '../../shared/src/track';
import { WAREHOUSE_TRACK } from '../../shared/src/tracks/warehouse';
import { Lobby } from './lobby';

const DIST = resolve(fileURLToPath(new URL('../../client/dist', import.meta.url)));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.map': 'application/json',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Serveur MSF Supply Kart actif. Construisez le client (npm run build) ou utilisez le serveur Vite en dev.');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  let path = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!path.startsWith(DIST)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(path) || statSync(path).isDirectory()) path = join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
}

export interface GameServer {
  port: number;
  close: () => Promise<void>;
  lobby: Lobby;
}

export function startServer(port: number, host: string, quiet = false, speed = 1): Promise<GameServer> {
  const track = buildTrack(WAREHOUSE_TRACK);
  const lobby = new Lobby(track, speed);
  lobby.start();
  const http = createServer(serveStatic);
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 8 * 1024 });
  wss.on('connection', (ws) => {
    const handlers = lobby.connect((msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    });
    ws.on('message', (data) => handlers.onMessage(data.toString()));
    ws.on('close', handlers.onClose);
    ws.on('error', () => ws.close());
  });
  return new Promise((resolveStart) => {
    http.listen(port, host, () => {
      const actual = (http.address() as { port: number }).port;
      if (!quiet) {
        console.log(`[MSF Supply Kart] serveur prêt sur http://${host}:${actual} (WebSocket /ws)`);
        if (host === '0.0.0.0') {
          for (const list of Object.values(networkInterfaces())) {
            for (const net of list ?? []) {
              if (net.family === 'IPv4' && !net.internal) console.log(`  sur le réseau local : http://${net.address}:${actual}`);
            }
          }
        }
        if (!existsSync(DIST)) console.log('  (client non construit : en dev, ouvrez le serveur Vite sur http://127.0.0.1:5188)');
      }
      resolveStart({
        port: actual,
        lobby,
        close: () =>
          new Promise<void>((done) => {
            lobby.stop();
            for (const c of wss.clients) c.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}
