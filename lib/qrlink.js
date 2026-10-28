/* QRLink v3: shared screen-to-camera link used by the simple page and the quiz page.

   What changed from v2 (speed and reliability):
   - Packets are binary and sent as base45 text, so the QR uses its compact alphanumeric mode
     (about 30 % more data per QR than base64 in byte mode).
   - Fixed-size binary header (17 bytes) instead of a long text header.
   - Default QR error correction L: lost or damaged frames are already covered by the fountain code.
   - Frames change on screen refreshes and are held for a whole number of refreshes,
     so the camera rarely captures half of one frame and half of the next.
   - Decoder: fast peeling, plus Gaussian elimination over GF(2) when peeling stalls,
     which lowers the extra packets needed from ~25-35 % to a few percent.

   Text in each QR:  <prefix><base45(packet)>
   Data packet: 0x01 | id(3) | j(u32) | K(u24) | B(u16) | size(u32) | payload(B)
   Info packet: 0x02 | id(3) | K(u24) | B(u16) | size(u32) | sha256(32) | UTF-8 JSON metadata
   Packet j < K is source block j; j >= K is an LT packet whose blocks are chosen from j with a
   shared generator and the Robust Soliton distribution. Senders that use the same id and block size
   (teacher and relays) produce packets that combine at the receiver. */
(function (g) {
  'use strict';
  const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const B45I = new Int16Array(128).fill(-1);
  for (let i = 0; i < 45; i++) B45I[B45.charCodeAt(i)] = i;

  function b45enc(u8) {
    const out = new Array(Math.ceil(u8.length / 2) * 3);
    let o = 0, i = 0;
    for (; i + 1 < u8.length; i += 2) {
      let n = u8[i] * 256 + u8[i + 1];
      const c = n % 45; n = (n - c) / 45;
      const d = n % 45;
      out[o++] = B45[c]; out[o++] = B45[d]; out[o++] = B45[(n - d) / 45];
    }
    if (i < u8.length) { const n = u8[i]; out[o++] = B45[n % 45]; out[o++] = B45[(n / 45) | 0]; }
    out.length = o;
    return out.join('');
  }
  function b45dec(s) {
    const L = s.length;
    if (L % 3 === 1) return null;
    const out = new Uint8Array(((L / 3) | 0) * 2 + (L % 3 === 2 ? 1 : 0));
    const idx = k => { const c = s.charCodeAt(k); return c < 128 ? B45I[c] : -1; };
    let o = 0;
    for (let i = 0; i < L; i += 3) {
      const c = idx(i), d = idx(i + 1);
      if (c < 0 || d < 0) return null;
      if (i + 2 < L) {
        const e = idx(i + 2); if (e < 0) return null;
        const n = c + d * 45 + e * 2025; if (n > 65535) return null;
        out[o++] = n >> 8; out[o++] = n & 255;
      } else {
        const n = c + d * 45; if (n > 255) return null;
        out[o++] = n;
      }
    }
    return out;
  }

  /* ---------- LT fountain code (same generator as v2) ---------- */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const cdfCache = new Map();
  function robustSolitonCdf(K) {
    if (cdfCache.has(K)) return cdfCache.get(K);
    let cdf;
    if (K === 1) cdf = new Float64Array([1]);
    else {
      const c = 0.1, delta = 0.5, R = c * Math.log(K / delta) * Math.sqrt(K);
      const mu = new Float64Array(K + 1);
      mu[1] = 1 / K; for (let d = 2; d <= K; d++) mu[d] = 1 / (d * (d - 1));
      let s = Math.floor(K / R); if (s < 1) s = 1; if (s > K) s = K;
      for (let d = 1; d < s; d++) mu[d] += R / (d * K);
      const spike = R * Math.log(R / delta) / K; if (spike > 0) mu[s] += spike;
      let Z = 0; for (let d = 1; d <= K; d++) Z += mu[d];
      cdf = new Float64Array(K); let acc = 0;
      for (let d = 1; d <= K; d++) { acc += mu[d] / Z; cdf[d - 1] = acc; }
      cdf[K - 1] = 1;
    }
    cdfCache.set(K, cdf);
    return cdf;
  }
  function sampleDegree(cdf, u) { let lo = 0, hi = cdf.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; } return lo + 1; }
  function neighbours(j, K) {
    if (j < K) return [j];
    const cdf = robustSolitonCdf(K), rng = mulberry32((Math.imul(j, 0x9E3779B1) ^ 0x85EBCA6B) >>> 0);
    const d = sampleDegree(cdf, rng()), set = new Set();
    while (set.size < d) set.add(Math.floor(rng() * K));
    return [...set];
  }
  function xorInto(a, b) {
    if (!(a.length & 3) && !(a.byteOffset & 3) && !(b.byteOffset & 3)) {
      const A = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2), Bv = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
      for (let i = 0; i < A.length; i++) A[i] ^= Bv[i];
    } else for (let i = 0; i < a.length; i++) a[i] ^= b[i];
  }

  /* ---------- helpers ---------- */
  async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
  const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join('');
  function randomId() { return crypto.getRandomValues(new Uint8Array(3)); }
  function blockSize(b) { b = Math.max(8, Math.min(2000, b | 0)); return b + ((4 - (b & 3)) & 3); }  // multiple of 4

  /* ---------- self-describing stream ----------
     The coded stream = "QL" | meta length (u16) | UTF-8 JSON meta | sha256 of the file (32) | file bytes.
     A receiver that gets only data packets (e.g. at a QR size too small for info frames) still learns the
     file name and can verify it; info frames only let it show the name earlier. */
  function wrap(fileBytes, meta, hash) {
    const m = new TextEncoder().encode(JSON.stringify(meta || {})), out = new Uint8Array(4 + m.length + 32 + fileBytes.length);
    out[0] = 0x51; out[1] = 0x4C; new DataView(out.buffer).setUint16(2, m.length); out.set(m, 4); out.set(hash, 4 + m.length); out.set(fileBytes, 36 + m.length);
    return out;
  }
  function unwrap(stream) {
    if (stream.length < 36 || stream[0] !== 0x51 || stream[1] !== 0x4C) return null;
    const ml = new DataView(stream.buffer, stream.byteOffset).getUint16(2); if (36 + ml > stream.length) return null;
    let meta; try { meta = JSON.parse(new TextDecoder().decode(stream.subarray(4, 4 + ml))); } catch (e) { return null; }
    return { meta, hashHex: hex(stream.subarray(4 + ml, 36 + ml)), file: stream.slice(36 + ml) };
  }

  /* ---------- encoder ---------- */
  async function makeEncoder(fileBytes, o) {
    const hash0 = o.hash || await sha256(fileBytes), bytes = wrap(fileBytes, o.meta || {}, hash0);
    const B = blockSize(o.B), K = Math.max(1, Math.ceil(bytes.length / B)), padded = new Uint8Array(K * B);
    padded.set(bytes);
    const blocks = []; for (let i = 0; i < K; i++) blocks.push(padded.subarray(i * B, (i + 1) * B));
    const id = o.id || randomId(), hash = hash0;
    const metaBytes = new TextEncoder().encode(JSON.stringify(o.meta || {}));
    // info: type(0) | id(1..3) | K u24 (4..6) | B u16 (7..8) | size u32 (9..12) | sha256 (13..44) | meta (45..)
    const info = new Uint8Array(45 + metaBytes.length), dv = new DataView(info.buffer);
    info[0] = 2; info.set(id, 1);
    info[4] = (K >> 16) & 255; info[5] = (K >> 8) & 255; info[6] = K & 255;
    dv.setUint16(7, B); dv.setUint32(9, bytes.length); info.set(hash, 13); info.set(metaBytes, 45);
    const enc = {
      id, idHex: hex(id), B, K, size: bytes.length, fileSize: fileBytes.length, hash, hashHex: hex(hash), meta: o.meta || {}, blocks,
      // start with mixed (LT) packets: with frame loss and Gaussian elimination they need ~2 % extra, plain blocks first need ~30 %
      prefix: o.prefix, every: Math.max(2, o.every || 30), j: o.jStart != null ? o.jStart : K, frame: 0,
      infoText() { return this.prefix + b45enc(info); },
      dataText(j) {
        const p = new Uint8Array(17 + B), v = new DataView(p.buffer);
        p[0] = 1; p.set(id, 1); v.setUint32(4, j >>> 0); p[8] = (K >> 16) & 255; p[9] = (K >> 8) & 255; p[10] = K & 255;
        v.setUint16(11, B); v.setUint32(13, bytes.length);
        const out = p.subarray(17);
        for (const i of neighbours(j, K)) xorInto(out, blocks[i]);
        return this.prefix + b45enc(p);
      },
      next() { return (this.frame++ % this.every === 0) ? this.infoText() : this.dataText(this.j++); },
      largestText() { return this.dataText(4000000000); },
    };
    return enc;
  }

  /* ---------- packet parser ---------- */
  function parse(text, prefix) {
    if (typeof text !== 'string' || !text.startsWith(prefix)) return null;
    const p = b45dec(text.slice(prefix.length));
    if (!p || p.length < 17) return null;
    const v = new DataView(p.buffer), type = p[0], id = hex(p.subarray(1, 4));
    if (type === 1) {
      const K = (p[8] << 16) | (p[9] << 8) | p[10], B = v.getUint16(11), size = v.getUint32(13);
      if (!K || !B || p.length !== 17 + B || size > K * B || size <= (K - 1) * B) return null;
      return { type: 'data', id, j: v.getUint32(4), K, B, size, payload: p.slice(17) };
    }
    if (type === 2 && p.length >= 45) {
      const K = (p[4] << 16) | (p[5] << 8) | p[6], B = v.getUint16(7), size = v.getUint32(9);
      let meta = {};
      try { meta = JSON.parse(new TextDecoder().decode(p.subarray(45))); } catch (e) { return null; }
      if (!K || !B || size > K * B) return null;
      return { type: 'info', id, K, B, size, hashHex: hex(p.subarray(13, 45)), meta };
    }
    return null;
  }

  /* ---------- decoder: peeling + Gaussian elimination ---------- */
  class Decoder {
    constructor(id) { this.id = id; this.K = 0; this.recovered = 0; this.seen = new Set(); this.pk = []; this.meta = null; this.hashHex = null; this.reads = 0; this.lastGE = 0; this.geRuns = 0; this.t0 = (g.performance || Date).now(); }
    _init(K, B, size) {
      this.K = K; this.B = B; this.size = size; this.blocks = new Array(K).fill(null);
      this.waiting = Array.from({ length: K }, () => []); this.geStep = Math.max(2, Math.ceil(K * 0.02));
    }
    get complete() { return !!this.blocks && this.recovered === this.K; }
    get ready() { return this.complete; }      // name and checksum travel inside the stream
    add(p) {
      this.reads++;
      if (p.type === 'info') {
        if (!this.meta) { this.meta = p.meta; this.hashHex = p.hashHex; }
        if (!this.blocks) this._init(p.K, p.B, p.size);
        return false;
      }
      if (!this.blocks) this._init(p.K, p.B, p.size);
      if (p.K !== this.K || p.B !== this.B || this.seen.has(p.j)) return false;
      this.seen.add(p.j);
      if (this.complete) return true;
      const nb = neighbours(p.j, this.K);
      this.pk.push({ nb, data: p.payload.slice() });
      this._peel(nb, p.payload);
      if (!this.complete && this.seen.size >= this.K && this.seen.size - this.lastGE >= this.geStep) { this.lastGE = this.seen.size; this._ge(); }
      return true;
    }
    _peel(nb, data) {
      const left = [];
      for (const i of nb) { if (this.blocks[i]) xorInto(data, this.blocks[i]); else left.push(i); }
      if (!left.length) return;
      if (left.length === 1) { this._recover(left[0], data); return; }
      const pkt = { nbrs: new Set(left), data };
      for (const i of left) this.waiting[i].push(pkt);
    }
    _recover(b0, d0) {
      const q = [[b0, d0]];
      while (q.length) {
        const [b, d] = q.pop();
        if (this.blocks[b]) continue;
        this.blocks[b] = d; this.recovered++;
        const list = this.waiting[b]; this.waiting[b] = [];
        for (const p of list) {
          if (!p.nbrs.has(b)) continue;
          xorInto(p.data, d); p.nbrs.delete(b);
          if (p.nbrs.size === 1) { const [nb] = p.nbrs; p.nbrs.clear(); if (!this.blocks[nb]) q.push([nb, p.data]); }
        }
      }
    }
    /* Solve the remaining unknown blocks from all stored packets. Bits-only elimination first
       (cheap rank check); payloads are combined only when the system is solvable. */
    _ge() {
      const K = this.K, col = new Int32Array(K).fill(-1), unk = [];
      for (let i = 0; i < K; i++) if (!this.blocks[i]) { col[i] = unk.length; unk.push(i); }
      const u = unk.length, W = (u + 31) >>> 5, rows = [];
      if (!u) return;
      for (const p of this.pk) {
        const bits = new Uint32Array(W); let any = false;
        for (const i of p.nb) if (col[i] >= 0) { bits[col[i] >>> 5] ^= 1 << (col[i] & 31); any = true; }
        if (any) rows.push({ bits, p });
      }
      if (rows.length < u) return;
      this.geRuns++;
      const elim = (R, withData) => {
        let r = 0;
        for (let c = 0; c < u; c++) {
          const w = c >>> 5, m = 1 << (c & 31);
          let k = -1; for (let i = r; i < R.length; i++) if (R[i].bits[w] & m) { k = i; break; }
          if (k < 0) return false;
          const t = R[r]; R[r] = R[k]; R[k] = t;
          const pb = R[r].bits, pd = withData ? R[r].data : null;
          for (let i = 0; i < R.length; i++) {
            if (i === r || !(R[i].bits[w] & m)) continue;
            const b = R[i].bits; for (let x = w; x < W; x++) b[x] ^= pb[x];
            if (withData) xorInto(R[i].data, pd);
          }
          r++;
        }
        return true;
      };
      if (!elim(rows.map(x => ({ bits: x.bits.slice() })), false)) return;   // not solvable yet
      const full = rows.map(x => {
        const data = x.p.data.slice();
        for (const i of x.p.nb) if (col[i] < 0) xorInto(data, this.blocks[i]);
        return { bits: x.bits, data };
      });
      elim(full, true);
      for (let c = 0; c < u; c++) this.blocks[unk[c]] = full[c].data;
      this.recovered = K;
      for (const w of this.waiting) w.length = 0;
    }
    /* the received file, or null if its SHA-256 does not match; also fills meta from the stream */
    async bytes() {
      const buf = new Uint8Array(this.K * this.B);
      this.blocks.forEach((b, i) => buf.set(b, i * this.B));
      const u = unwrap(buf.subarray(0, this.size));
      if (!u) return null;
      if (!this.meta) this.meta = u.meta;
      this.hashHex = u.hashHex;
      return hex(await sha256(u.file)) === u.hashHex ? u.file : null;
    }
  }

  /* ---------- QR drawing and refresh-locked broadcasting ---------- */
  function makeQR(text, ecc, version) { const q = qrcode(version || 0, ecc || 'L'); q.addData(text, 'Alphanumeric'); q.make(); return q; }
  function paint(canvas, q) {
    const n = q.getModuleCount(), S = canvas.width, cell = Math.floor(S / (n + 8)), off = Math.floor((S - cell * n) / 2);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, S, S); ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) {
      let run = -1;
      for (let c = 0; c <= n; c++) {
        const dark = c < n && q.isDark(r, c);
        if (dark && run < 0) run = c;
        else if (!dark && run >= 0) { ctx.fillRect(off + run * cell, off + r * cell, (c - run) * cell, cell); run = -1; }
      }
    }
    return n;
  }
  function drawQR(canvas, text, ecc) { return paint(canvas, makeQR(text, ecc)); }

  /* Shows a new QR every `hold` screen refreshes, with hold measured from the real refresh rate.
     The next QR is prepared right after drawing, so drawing itself is quick and on time. */
  function broadcast(canvas, o) {
    const st = { running: true, frames: 0, hold: 0, refreshHz: 0, fps: 0 };
    let last = 0, count = 0; const dts = [];
    let nextQ = null;
    const prep = () => { try { const n = o.next(); nextQ = typeof n === 'string' ? makeQR(n, o.ecc) : makeQR(n.text, o.ecc, n.version); st.current = n; } catch (e) { nextQ = null; } };
    prep();
    function loop(t) {
      if (!st.running) return;
      if (last && dts.length < 40) dts.push(t - last);
      last = t;
      if (!st.hold && dts.length >= 12) {
        const s = dts.slice().sort((a, b) => a - b), med = s[s.length >> 1];
        st.refreshHz = 1000 / med; st.hold = Math.max(1, Math.round(1000 / o.fps / med)); st.fps = st.refreshHz / st.hold;
      }
      const hold = st.hold || Math.max(1, Math.round(60 / o.fps));
      if (count % hold === 0) {
        if (nextQ) paint(canvas, nextQ);
        st.frames++; if (o.onFrame) o.onFrame(st);
        prep();
      }
      count++;
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
    st.stop = () => { st.running = false; };
    return st;
  }

  /* Calls fn once per new camera frame (requestVideoFrameCallback when available). */
  function eachVideoFrame(video, fn, isRunning) {
    const useRVFC = typeof video.requestVideoFrameCallback === 'function';
    let busy = false;
    const step = async () => {
      if (!isRunning()) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) { busy = true; try { await fn(); } catch (e) {} busy = false; }
      if (useRVFC) video.requestVideoFrameCallback(step); else requestAnimationFrame(step);
    };
    if (useRVFC) video.requestVideoFrameCallback(step); else requestAnimationFrame(step);
  }

  /* Camera with the settings that help reading from a distance. */
  async function openCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
    const track = stream.getVideoTracks()[0];
    try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}
    let detector = null;
    if ('BarcodeDetector' in g) { try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) {} }
    return { stream, track, detector };
  }
  /* Read QR texts from the current video frame. */
  const scanCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  async function readFrame(video, detector, maxSide) {
    if (detector) { const r = await detector.detect(video); return r.map(x => x.rawValue); }
    const sc = Math.min(1, (maxSide || 1280) / Math.max(video.videoWidth, video.videoHeight)), w = Math.round(video.videoWidth * sc), h = Math.round(video.videoHeight * sc);
    if (scanCanvas.width !== w || scanCanvas.height !== h) { scanCanvas.width = w; scanCanvas.height = h; }
    const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const c = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
    return c ? [c.data] : [];
  }

  /* ---------- QR size levels and the distance test ----------
     Level k shows QR version TEST_VERSIONS[k-1]. A page turns a level into the largest block size whose
     packets still fit that version (maxBlockFor), so "level" fixes the module size seen on the wall. */
  const TEST_VERSIONS = [2, 3, 5, 7, 10, 14, 18];
  function levels() { return TEST_VERSIONS.map((v, i) => ({ level: i + 1, version: v, modules: 17 + 4 * v })); }
  const b45len = n => Math.floor(n / 2) * 3 + (n % 2 ? 2 : 0);
  function maxBlockFor(version, ecc, prefix, header) {
    const fits = B => { try { const q = qrcode(version, ecc); q.addData('0'.repeat(prefix.length + b45len(header + B)), 'Alphanumeric'); q.make(); return true; } catch (e) { return false; } };
    if (!fits(8)) return 0;                 // this QR size is too small to carry a data packet
    let lo = 8, hi = 3000;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (fits(m)) lo = m; else hi = m - 1; }
    return Math.max(8, lo - (lo & 3));
  }
  /* test stream: each level is shown for `per` frames in turn; text = T5 | level | per (2 digits) | counter (7 digits) */
  function testStream(per) {
    const L = levels(); let i = 0;
    return { per, next() { const lv = L[Math.floor(i / per) % L.length], c = i++; this.current = lv; return { text: 'T5' + lv.level + String(per).padStart(2, '0') + String(c).padStart(7, '0'), version: lv.version, level: lv.level, modules: lv.modules }; } };
  }
  function parseTest(text) {
    const m = /^T5([1-7])(\d{2})(\d{7})$/.exec(text || '');
    return m ? { level: +m[1], per: +m[2], counter: +m[3] } : null;
  }
  /* receiver side: share of shown frames read at each level */
  class TestMeter {
    constructor() { this.seen = new Map(); this.min = Infinity; this.max = -Infinity; }
    add(t) { if (!this.seen.has(t.level)) this.seen.set(t.level, new Set()); this.seen.get(t.level).add(t.counter); this.min = Math.min(this.min, t.counter); this.max = Math.max(this.max, t.counter); }
    get cycles() { return this.max >= this.min ? (this.max - this.min + 1) / (7 * this.perGuess()) : 0; }
    perGuess() { return this._per || 1; }
    results() {
      const span = this.max >= this.min ? this.max - this.min + 1 : 0, shown = span / 7;
      return levels().map(l => { const n = this.seen.has(l.level) ? this.seen.get(l.level).size : 0; return { ...l, read: n, rate: shown >= 1 ? Math.min(1, n / shown) : 0 }; });
    }
    /* a level counts when it is read at least `threshold` as often as this phone's best level, so the
       phone's own missed frames (slow decoding, timing) do not count against every QR size */
    best(threshold) {
      const res = this.results(), top = Math.max(0, ...res.map(r => r.rate)); if (top < 0.2) return 0;
      let b = 0; for (const r of res) if (r.rate >= (threshold || 0.8) * top) b = r.level; return b;
    }
  }

  g.QRLink = { wrap, unwrap, levels, maxBlockFor, testStream, parseTest, TestMeter, b45enc, b45dec, neighbours, robustSolitonCdf, makeEncoder, parse, Decoder, makeQR, paint, drawQR, broadcast, eachVideoFrame, openCamera, readFrame, blockSize, hex };
})(typeof window !== 'undefined' ? window : globalThis);
