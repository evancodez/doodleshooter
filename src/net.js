// Peer-to-peer networking over WebRTC, using the public PeerJS signalling service.
// Nothing runs on a server of ours: the host player's browser is the authority, every other
// player connects straight to it. That is what lets multiplayer work from a static Vercel deploy.
//
// Lobby codes are just peer ids. A private lobby takes a random 5 letter code; a public lobby
// claims one of a handful of well-known ids (PUB0..PUB7) so quick play can find it by knocking on
// every slot at once - a directory with no directory server. A connection only counts once the
// host has answered with a welcome, so a full or closed lobby can be skipped for the next one.

const PREFIX = 'doodledistrict-';
const PUBLIC_SLOTS = 8;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const PEER_OPTS = { debug: 0, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] } };
const JOIN_TIMEOUT = 14000, QUICK_TIMEOUT = 11000, SIGNAL_TIMEOUT = 12000;

function peerAvailable() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }
const idFromError = (err) => { const m = /peer\s+(\S+)/.exec(String(err && err.message || '')); return m ? m[1] : null; };

export class Net {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false; this.id = null; this.code = null; this.hostId = null;
    this.handlers = new Map(); this.connected = false; this.onPeerJoin = null; this.onPeerLeave = null; this.onDisconnect = null;
    this.maxPlayers = 8; this.accepting = true; this.stats = { sent: 0, recv: 0 }; this.isPublic = false;
  }
  get active() { return !!this.peer && this.connected; }
  get peerIds() { return [...this.conns.keys()]; }
  on(type, fn) { this.handlers.set(type, fn); }
  _emit(type, data, from) { const h = this.handlers.get(type); if (h) h(data, from); }

  _newPeer(id) {
    return new Promise((resolve, reject) => {
      if (!peerAvailable()) return reject(new Error('networking library did not load'));
      const peer = new window.Peer(id, PEER_OPTS); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; peer.destroy(); reject(new Error('signalling server timed out')); } }, SIGNAL_TIMEOUT);
      peer.on('open', () => { if (settled) return; settled = true; clearTimeout(timer); resolve(peer); });
      peer.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); peer.destroy(); reject(err); });
    });
  }
  _wire(conn) {
    conn.on('data', (msg) => { this.stats.recv++; if (!msg || typeof msg !== 'object') return; this._route(msg, conn.peer); });
    conn.on('close', () => this._drop(conn.peer));
    conn.on('error', () => this._drop(conn.peer));
  }
  _drop(pid) {
    if (!this.conns.has(pid)) return; this.conns.delete(pid);
    if (this.isHost) { if (this.onPeerLeave) this.onPeerLeave(pid); this.broadcast('leave', { id: pid }); }
    else if (pid === this.hostId) { this.connected = false; if (this.onDisconnect) this.onDisconnect(); }
  }
  _route(msg, from) {
    // clients can address each other; the host forwards those
    if (this.isHost && msg.to && msg.to !== this.id) { const c = this.conns.get(msg.to); if (c && c.open) c.send(msg); return; }
    if (this.isHost && msg.relay) { for (const [pid, c] of this.conns) if (pid !== from && c.open) c.send({ t: msg.t, d: msg.d, from }); }
    this._emit(msg.t, msg.d, msg.from || from);
  }
  _keepAlive(peer) { peer.on('disconnected', () => { if (this.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } }); }

  // ---- lobby creation / joining ----
  async host({ isPublic = false } = {}) {
    this.leave(); this.isHost = true; this.isPublic = isPublic;
    if (isPublic) {
      for (let slot = 0; slot < PUBLIC_SLOTS; slot++) {
        try { this.peer = await this._newPeer(PREFIX + 'PUB' + slot); this.code = 'PUB' + slot; break; } catch (e) { if (!(e && e.type === 'unavailable-id')) throw e; }
      }
      if (!this.peer) throw new Error('all public lobbies are busy - host a private one');
    } else {
      for (let tries = 0; tries < 3 && !this.peer; tries++) {
        this.code = makeCode();
        try { this.peer = await this._newPeer(PREFIX + this.code); } catch (e) { if (!(e && e.type === 'unavailable-id') || tries === 2) throw e; }
      }
    }
    this.id = this.peer.id; this.hostId = this.id; this.connected = true; this.accepting = true;
    this.peer.on('connection', (conn) => {
      conn.on('open', () => {
        if (!this.accepting || this.conns.size >= this.maxPlayers - 1) { conn.send({ t: 'refused', d: { reason: this.accepting ? 'that lobby is full' : 'that lobby is closed' } }); setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 400); return; }
        this.conns.set(conn.peer, conn); this._wire(conn);
        conn.send({ t: 'welcome', d: { hostId: this.id, code: this.code, isPublic: this.isPublic }, from: this.id });
        if (this.onPeerJoin) this.onPeerJoin(conn.peer, conn.metadata || {});
      });
    });
    this._keepAlive(this.peer);
    return this.code;
  }
  async join(code, meta = {}) {
    this.leave(); this.isHost = false; code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('enter a lobby code');
    this.peer = await this._newPeer(null); this.id = this.peer.id; this._keepAlive(this.peer);
    const hostId = PREFIX + code;
    const { conn, welcome } = await this._knock(hostId, meta, JOIN_TIMEOUT);
    this._adopt(hostId, conn, welcome); return code;
  }
  // try every public slot at the same time and take the first host that says welcome
  async quickJoin(meta = {}, onStatus = null) {
    this.leave(); this.isHost = false; this.peer = await this._newPeer(null); this.id = this.peer.id; this._keepAlive(this.peer);
    if (onStatus) onStatus('looking for an open lobby…');
    const ids = Array.from({ length: PUBLIC_SLOTS }, (_, i) => PREFIX + 'PUB' + i);
    const winner = await new Promise((resolve) => {
      let pending = ids.length, done = false; const attempts = [];
      const settle = (val) => { if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr); for (const a of attempts) if (!val || a.conn !== val.conn) { try { a.conn.close(); } catch (e) { /* ignore */ } } resolve(val); };
      const failOne = (a) => { if (a.done) return; a.done = true; pending--; if (pending <= 0) settle(null); };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') { const a = attempts.find((x) => x.hostId === idFromError(err)); if (a) failOne(a); } };
      this.peer.on('error', onErr);
      const timer = setTimeout(() => settle(null), QUICK_TIMEOUT);
      for (const hostId of ids) {
        let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: meta }); } catch (e) { pending--; continue; }
        const a = { conn, hostId, done: false }; attempts.push(a);
        conn.on('data', (msg) => { if (!msg) return; if (msg.t === 'welcome') { a.done = true; settle({ conn, hostId, welcome: msg.d }); } else if (msg.t === 'refused') failOne(a); });
        conn.on('error', () => failOne(a)); conn.on('close', () => failOne(a));
      }
      if (pending <= 0) settle(null);
    });
    if (!winner) { this.leave(); throw new Error('no open public lobbies'); }
    this._adopt(winner.hostId, winner.conn, winner.welcome); this.code = winner.hostId.slice(PREFIX.length); return this.code;
  }
  _knock(hostId, meta, timeoutMs) {
    return new Promise((resolve, reject) => {
      let conn; try { conn = this.peer.connect(hostId, { reliable: true, serialization: 'json', metadata: meta }); } catch (e) { return reject(new Error('could not start a connection')); }
      let done = false;
      const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr); if (err) { try { conn.close(); } catch (e) { /* ignore */ } reject(err); } else resolve(val); };
      const timer = setTimeout(() => finish(new Error('no answer from that lobby')), timeoutMs);
      const onErr = (err) => { if (err && err.type === 'peer-unavailable' && idFromError(err) === hostId) finish(new Error('no lobby with that code')); };
      this.peer.on('error', onErr);
      conn.on('data', (msg) => { if (!msg) return; if (msg.t === 'welcome') finish(null, { conn, welcome: msg.d }); else if (msg.t === 'refused') finish(new Error(msg.d && msg.d.reason || 'the lobby turned you away')); });
      conn.on('error', (e) => finish(e instanceof Error ? e : new Error('could not connect')));
      conn.on('close', () => finish(new Error('the lobby closed the connection')));
    });
  }
  _adopt(hostId, conn, welcome) {
    this.hostId = hostId; this.conns.set(hostId, conn); this.connected = true; this.isPublic = !!(welcome && welcome.isPublic); this._wire(conn);
  }
  leave() {
    for (const c of this.conns.values()) { try { c.close(); } catch (e) { /* ignore */ } }
    this.conns.clear(); if (this.peer) { try { this.peer.destroy(); } catch (e) { /* ignore */ } }
    this.peer = null; this.connected = false; this.isHost = false; this.id = null; this.code = null; this.hostId = null;
  }

  // ---- messaging ----
  // host: to everyone; client: to the host (and on to everyone if relay is set)
  send(type, data, relay = false) {
    this.stats.sent++;
    if (this.isHost) { const m = { t: type, d: data, from: this.id }; for (const c of this.conns.values()) if (c.open) c.send(m); }
    else { const c = this.conns.get(this.hostId); if (c && c.open) c.send({ t: type, d: data, relay }); }
  }
  broadcast(type, data) { this.send(type, data, true); }
  sendTo(pid, type, data) {
    this.stats.sent++;
    if (this.isHost) { const c = this.conns.get(pid); if (c && c.open) c.send({ t: type, d: data, from: this.id }); }
    else { const c = this.conns.get(this.hostId); if (c && c.open) c.send({ t: type, d: data, to: pid, from: this.id }); }
  }
}
