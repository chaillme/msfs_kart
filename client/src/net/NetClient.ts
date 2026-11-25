import type { ClientMessage, ServerMessage } from '@shared/net';

type Listener = (msg: ServerMessage) => void;

const TOKEN_KEY = 'msfs-kart-token';

function safeGet(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable: reconnect after a reload simply won't resume
  }
}

/**
 * WebSocket connection to the game server with automatic reconnection.
 * The resume token is kept per browser tab (sessionStorage), so two tabs on
 * the same computer are two different players, and a reload resumes the race.
 */
export class NetClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<(s: NetStatus) => void>();
  private reconnectTimer = 0;
  private pingTimer = 0;
  private attempts = 0;
  private closedByUser = false;
  id = '';
  rtt = 0;
  status: NetStatus = 'offline';
  private profile = { name: 'Cariste', color: '#e8202a' };

  constructor(private readonly url = NetClient.defaultUrl()) {}

  static defaultUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: NetStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(s: NetStatus): void {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  connect(name: string, color: string): void {
    this.profile = { name, color };
    this.closedByUser = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.send({ t: 'profile', name, color });
      return;
    }
    this.open();
  }

  private open(): void {
    window.clearTimeout(this.reconnectTimer);
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.send({ t: 'hello', name: this.profile.name, color: this.profile.color, token: safeGet(TOKEN_KEY) ?? undefined });
      window.clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        this.id = msg.id;
        safeSet(TOKEN_KEY, msg.token);
        this.setStatus('online');
      } else if (msg.t === 'pong') {
        const sample = performance.now() - msg.ts;
        this.rtt = this.rtt ? this.rtt * 0.8 + sample * 0.2 : sample;
      }
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closedByUser) {
        this.setStatus('offline');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    this.setStatus('reconnecting');
    const delay = Math.min(5000, 400 * 2 ** Math.min(4, this.attempts - 1));
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closedByUser = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export type NetStatus = 'offline' | 'connecting' | 'online' | 'reconnecting';
