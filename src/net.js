// Peer-to-peer networking over WebRTC, using the public PeerJS signalling service.
// Nothing runs on the server: the host player's browser is the authority, every other player
// connects straight to it. That is what lets multiplayer work from a static Vercel deploy.
//
// Lobby codes are just peer ids. A private lobby takes a random 5 letter code; a public lobby
// claims one of a handful of well-known ids (PUB0..PUB7) so "quick play" can find it by trying
// each in turn - a directory with no directory server.

const PREFIX = 'doodledistrict-';
const PUBLIC_SLOTS = 8;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const makeCode = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
const PEER_OPTS = { debug: 1, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] } };

function peerAvailable() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }

export class Net {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false; this.id = null; this.code = null; this.hostId = null;
    this.handlers = new Map(); this.connected = false; this.onPeerJoin = null; this.onPeerLeave = null; this.onDisconnect = null;
    this.maxPlayers = 8; this.accepting = true; this.stats = { sent: 0, recv: 0 };
  }
  get active() { return !!this.peer && this.connected; }
  get peerIds() { return [...this.conns.keys()]; }
  on(type, fn) { this.handlers.set(type, fn); }
  _emit(type, data, from) { const h = this.handlers.get(type); if (h) h(data, from); }

  _newPeer(id) {
    return new Promise((resolve, reject) => {
      if (!peerAvailable()) return reject(new Error('networking library did not load'));
      const peer = new window.Peer(id, PEER_OPTS); let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; peer.destroy(); reject(new Error('signalling server timed out')); } }, 9000);
      peer.on('open', (pid) => { if (settled) return; settled = true; clearTimeout(timer); resolve(peer); });
      peer.on('error', (err) => { if (settled) { if (err.type === 'peer-unavailable') this._emit('__unavailable', err); return; } settled = true; clearTimeout(timer); peer.destroy(); reject(err); });
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

  // ---- lobby creation / joining ----
  async host({ isPublic = false } = {}) {
    this.leave(); this.isHost = true;
    if (isPublic) {
      for (let slot = 0; slot < PUBLIC_SLOTS; slot++) {
        try { this.peer = await this._newPeer(PREFIX + 'PUB' + slot); this.code = 'PUB' + slot; break; } catch (e) { if (!(e && e.type === 'unavailable-id')) throw e; }
      }
      if (!this.peer) throw new Error('all public lobbies are busy - host a private one');
    } else {
      this.code = makeCode(); this.peer = await this._newPeer(PREFIX + this.code);
    }
    this.id = this.peer.id; this.hostId = this.id; this.connected = true;
    this.peer.on('connection', (conn) => {
      if (!this.accepting || this.conns.size >= this.maxPlayers - 1) { conn.on('open', () => { conn.send({ t: 'refused', d: { reason: this.accepting ? 'lobby is full' : 'game already started' } }); setTimeout(() => conn.close(), 300); }); return; }
      conn.on('open', () => { this.conns.set(conn.peer, conn); this._wire(conn); if (this.onPeerJoin) this.onPeerJoin(conn.peer); });
    });
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) { /* ignore */ } });
    return this.code;
  }
  async join(code) {
    this.leave(); this.isHost = false; code = String(code || '').trim().toUpperCase();
    if (!code) throw new Error('enter a lobby code');
    this.peer = await this._newPeer(null); this.id = this.peer.id;
    await this._connectTo(PREFIX + code, 7000); this.code = code; return code;
  }
  async quickJoin(onStatus) {
    this.leave(); this.isHost = false; this.peer = await this._newPeer(null); this.id = this.peer.id;
    for (let slot = 0; slot < PUBLIC_SLOTS; slot++) {
      if (onStatus) onStatus(`looking for a lobby… (${slot + 1}/${PUBLIC_SLOTS})`);
      try { await this._connectTo(PREFIX + 'PUB' + slot, 2600); this.code = 'PUB' + slot; return this.code; } catch (e) { /* next slot */ }
    }
    this.leave(); throw new Error('no open public lobbies right now - host one');
  }
  _connectTo(hostId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(hostId, { reliable: true, serialization: 'json' }); let done = false;
      const fail = (err) => { if (done) return; done = true; clearTimeout(timer); try { conn.close(); } catch (e) { /* ignore */ } reject(err instanceof Error ? err : new Error(String(err && err.message || err || 'could not connect'))); };
      const timer = setTimeout(() => fail(new Error('no answer from that lobby')), timeoutMs);
      const onErr = (err) => { if (err && (err.type === 'peer-unavailable')) fail(new Error('no lobby with that code')); };
      this.peer.on('error', onErr);
      conn.on('open', () => {
        if (done) return; done = true; clearTimeout(timer); this.peer.off('error', onErr);
        this.hostId = hostId; this.conns.set(hostId, conn); this.connected = true; this._wire(conn); resolve();
      });
      conn.on('error', fail);
    });
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
