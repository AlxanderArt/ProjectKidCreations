/* ProjectKidCreations boot field — source-derived ambient loading screen.
   Sequence: two brand actors meet/pulse, hold, retreat, then the globe assembles.
   The network field continues in the ProjectKidCreations orange accent.

   Perf notes: all geometry (arc samples, graticule, coastlines) is precomputed as
   flat typed arrays and only PROJECTED each frame — no per-frame allocation, no
   curve rebuilding. Motion is delta-time based, and packet positions are
   interpolated between samples so slow speeds stay perfectly smooth. */

const DENSITY = {minimal:{grid:[45,45],packets:1,arc:0.85}, balanced:{grid:[30,30],packets:2,arc:1}, 'high-detail':{grid:[20,20],packets:3,arc:1.15}};
const MOTION  = {quiet:{spin:0.028,pulse:0.6}, standard:{spin:0.075,pulse:1}, presentation:{spin:0.13,pulse:1.35}};
const TIER = {core:{r:5.2,glow:12}, hub:{r:3.3,glow:8}, edge:{r:2.4,glow:6}};
const LAND_URL = './pkc-land-topology.json';
const STEPS = 48;                        // smooth at boot-globe scale without overworking mobile frames
const T = {in:0.95, snap:0.28, hold:1.0, out:0.7, assemble:1.45, operationalHold:2.0};
const OPERATIONAL_FPS = 30;
const OPERATIONAL_FRAME_INTERVAL_MS = 1000 / OPERATIONAL_FPS;
const IOS_SAFARI = /iP(hone|ad|od)/.test(navigator.platform || '') && /Safari/.test(navigator.userAgent || '') && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent || '');

function hexRGB(hex){
  const h = (hex || '#FF5F1F').replace('#','');
  const n = h.length === 3 ? h.split('').map(c => c+c).join('') : h;
  return [parseInt(n.slice(0,2),16), parseInt(n.slice(2,4),16), parseInt(n.slice(4,6),16)];
}
/* Seeded procedural network: even blue-noise-grade placement (Fibonacci lattice,
   seeded rotation) → farthest-point hub selection → satellites bound to their
   nearest hub → minimum-spanning-tree backbone between hubs → two dramatic
   long-hauls. Degree is capped, so the graph reads as structure, not a web. */
function mulberry(seed){
  let a = seed >>> 0;
  return () => { a += 0x6D2B79F5; let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function buildNetwork(count, seed){
  const rand = mulberry(seed);
  const gold = Math.PI*(3 - Math.sqrt(5)), spin = rand()*Math.PI*2, nodes = [];
  for(let i = 0; i < count; i++){
    const y = 1 - 2*(i + 0.5)/count, r = Math.sqrt(Math.max(0, 1 - y*y)), th = gold*i + spin;
    nodes.push({id:'n'+i, v:[Math.cos(th)*r, y, Math.sin(th)*r], tier:'edge', deg:0});
  }
  const dotv = (a,b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

  // hubs: seed near the Americas, then farthest-point sampling for even spread
  const tl = 26*Math.PI/180, tg = -92*Math.PI/180;
  const target = [Math.cos(tl)*Math.sin(tg), Math.sin(tl), Math.cos(tl)*Math.cos(tg)];
  const hubCount = Math.max(3, Math.min(7, Math.round(count/6)));
  let core = nodes[0], best = -2;
  for(const n of nodes){ const d = dotv(n.v, target); if(d > best){ best = d; core = n; } }
  const hubs = [core];
  while(hubs.length < hubCount){
    let pick = null, bestMin = -2;
    for(const n of nodes){
      if(hubs.indexOf(n) >= 0) continue;
      let mn = 2;
      for(const h of hubs) mn = Math.min(mn, 1 - dotv(n.v, h.v));
      if(mn > bestMin){ bestMin = mn; pick = n; }
    }
    hubs.push(pick);
  }
  hubs.forEach(h => h.tier = 'hub');
  core.tier = 'core';

  const seen = {}, links = [];
  const add = (a, b, cls) => {
    if(a === b) return;
    const k = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
    if(seen[k]) return;
    seen[k] = 1; a.deg++; b.deg++; links.push({a, b, cls});
  };

  // every node gets its two NEAREST neighbours: short arcs whose partner is
  // almost always on the same visible face, so no node ever looks stranded
  const nearest = (n, k) => nodes.filter(m => m !== n)
    .sort((x, y) => dotv(y.v, n.v) - dotv(x.v, n.v)).slice(0, k);
  for(const n of nodes){
    for(const m of nearest(n, 2)){
      if(n.deg >= 4 || m.deg >= 4) continue;
      add(n, m, 'regional');
    }
  }
  // satellites also home to their hub when it is reasonably close
  const sats = nodes.filter(n => hubs.indexOf(n) < 0);
  for(const s of sats){
    let h = hubs[0], bd = -2;
    for(const cand of hubs){ const d = dotv(s.v, cand.v); if(d > bd){ bd = d; h = cand; } }
    s.hub = h;
    if(bd > 0.35 && s.deg < 4) add(s, h, 'regional');   // ~<69° away
  }
  // hub backbone: minimum spanning tree over hubs
  const inTree = [hubs[0]], out = hubs.slice(1);
  while(out.length){
    let ba = null, bb = null, bd = -2;
    for(const a of inTree) for(const b of out){
      const d = dotv(a.v, b.v);
      if(d > bd){ bd = d; ba = a; bb = b; }
    }
    add(ba, bb, 'backbone');
    inTree.push(bb); out.splice(out.indexOf(bb), 1);
  }
  // two dramatic long-hauls between the most distant unconnected hubs
  const pairs = [];
  for(let i = 0; i < hubs.length; i++) for(let j = i+1; j < hubs.length; j++){
    const k = hubs[i].id < hubs[j].id ? hubs[i].id+'|'+hubs[j].id : hubs[j].id+'|'+hubs[i].id;
    if(!seen[k]) pairs.push([hubs[i], hubs[j], dotv(hubs[i].v, hubs[j].v)]);
  }
  pairs.sort((p, q) => p[2] - q[2]);
  pairs.slice(0, 2).forEach(p => add(p[0], p[1], 'longhaul'));
  return {nodes, links};
}

class PkcBootGlobe {
  constructor(canvas, wrap, props = {}) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.props = props;
    this.start();
  }
  start(){
    this.yaw = -38; this.pitch = 14; this.flowT = 0; this.clock = 0; this.land = null; this.landFade = 0;
    this.assemblyAnnounced = false;
    this.lastOperationalDrawAt = 0;
    this.destroyed = false; this.landTimer = null; this.backgroundTimer = null;
    this.timelineStartedAt = performance.now();
    this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.buildGraph();
    this.buildGraticule();

    const resize = () => {
      const r = this.wrap.getBoundingClientRect(), vv = window.visualViewport, d = Math.min(window.devicePixelRatio||1, 2);
      const preferVV = vv && vv.width > 0 && vv.height > 0 && (IOS_SAFARI || /Safari/.test(navigator.userAgent||'') && !/Chrome|Chromium|CriOS|FxiOS|Edg/.test(navigator.userAgent||''));
      const vw = Math.max(1, (preferVV ? vv.width : r.width) || (vv && vv.width) || window.innerWidth || 1);
      const vh = Math.max(1, (preferVV ? vv.height : r.height) || (vv && vv.height) || window.innerHeight || 1);
      this.canvas.width = Math.max(1, Math.round(vw*d)); this.canvas.height = Math.max(1, Math.round(vh*d));
      this.dpr = d; this.w = vw; this.h = vh;
    };
    resize();
    this.ro = window.ResizeObserver ? new ResizeObserver(resize) : null; if(this.ro) this.ro.observe(this.wrap);
    window.addEventListener('resize', resize, {passive:true});
    if(window.visualViewport){ window.visualViewport.addEventListener('resize', resize, {passive:true}); window.visualViewport.addEventListener('scroll', resize, {passive:true}); }
    this._resize = resize;
    if(this.props.showCoastlines ?? true) this.loadLand();
    const assembledAt = T.in + T.snap + T.hold + T.out + T.assemble;
    this._loop = ts => {
      if(this.destroyed){ this.raf = null; return; }
      const operational = this.clock >= assembledAt;
      if (!operational || ts - this.lastOperationalDrawAt >= OPERATIONAL_FRAME_INTERVAL_MS) {
        this.frame(ts);
        if (operational) this.lastOperationalDrawAt = ts;
      }
      this.raf = requestAnimationFrame(this._loop);
    };
    if(this.reduced){
      this.timelineStartedAt -= T.assemble * 1000;
      this.landFade = 1;
      this.frame(performance.now());
      this.raf = null;
    } else {
      this.raf = requestAnimationFrame(this._loop);
    }
  }
  destroy(){
    if(this.destroyed) return;
    this.destroyed = true;
    if(this.landTimer !== null) clearTimeout(this.landTimer);
    if(this.backgroundTimer !== null) clearTimeout(this.backgroundTimer);
    cancelAnimationFrame(this.raf);
    this.raf = null;
    this.ro?.disconnect();
    window.removeEventListener('resize', this._resize);
    if(window.visualViewport && this._resize){
      window.visualViewport.removeEventListener('resize', this._resize);
      window.visualViewport.removeEventListener('scroll', this._resize);
    }
    if(this.canvas){
      const ctx = this.canvas.getContext('2d');
      ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.canvas.width = 1;
      this.canvas.height = 1;
    }
    this.land = null;
    this.links = [];
    this.nodeList = [];
    this.canvas = null;
    this.wrap = null;
  }

  /* ── precompute ─────────────────────────────────────────────── */
  buildGraph(){
    this.inFlight = 0;
    this.count = Math.max(12, Math.round(this.props.nodeCount ?? 25));
    this.arcH = this.props.arcHeight ?? 1.8;
    this.seed = this.props.seed ?? 7;
    const {nodes, links} = buildNetwork(this.count, Math.round((this.props.seed ?? 7)*1000) + this.count);
    this.nodeList = nodes;
    nodes.forEach((n,i) => { n.order = i; n.flash = 0; });
    this.links = links.map((l,i) => {
      const A = l.a.v, B = l.b.v;
      const d = Math.acos(Math.max(-1, Math.min(1, A[0]*B[0]+A[1]*B[1]+A[2]*B[2])));
      const k = l.cls === 'longhaul' ? 0.15 : l.cls === 'backbone' ? 0.10 : 0.055;
      const lift = 0.004 + (k*Math.min(d, 2.4)) * this.arcH;   // +0.004 keeps arcs off the surface
      const sv = new Float32Array((STEPS+1)*3);        // sampled great-circle, unit * altitude
      const s = Math.sin(d);
      for(let i2 = 0; i2 <= STEPS; i2++){
        const t = i2/STEPS, alt = 1 + lift*Math.sin(Math.PI*t);
        let x, y, z;
        if(s < 1e-6){ x = A[0]; y = A[1]; z = A[2]; }
        else {
          const k1 = Math.sin((1-t)*d)/s, k2 = Math.sin(t*d)/s;
          x = A[0]*k1 + B[0]*k2; y = A[1]*k1 + B[1]*k2; z = A[2]*k1 + B[2]*k2;
        }
        sv[i2*3] = x*alt; sv[i2*3+1] = y*alt; sv[i2*3+2] = z*alt;
      }
      return {a:l.a, b:l.b, cls:l.cls, sv, order:i,
        px:new Float32Array(STEPS+1), py:new Float32Array(STEPS+1), pz:new Float32Array(STEPS+1),
        // ping: -1 = idle (counting down `wait` seconds), 0..1 = in flight
        ping: -1, wait: 0.1 + i*0.12 + Math.random()*0.8,
        carries: true,                                      // every wire can carry traffic
        speed: l.cls === 'longhaul' ? 1.15 : l.cls === 'backbone' ? 0.95 : 0.7};
    });
  }
  buildGraticule(){
    const [dLat, dLon] = (DENSITY[this.props.density] || DENSITY.balanced).grid;
    this.gridKey = dLat + '|' + dLon;
    const lines = [];
    const push = (pts, major) => {
      const f = new Float32Array(pts.length*3);
      pts.forEach((p,i) => { f[i*3] = p[0]; f[i*3+1] = p[1]; f[i*3+2] = p[2]; });
      lines.push({v:f, n:pts.length, major, px:new Float32Array(pts.length), py:new Float32Array(pts.length), pz:new Float32Array(pts.length)});
    };
    const uv = (lat, lon) => { const p = lat*Math.PI/180, l = lon*Math.PI/180;
      return [Math.cos(p)*Math.sin(l), Math.sin(p), Math.cos(p)*Math.cos(l)]; };
    for(let lat = -60; lat <= 60; lat += dLat){
      for(let seg = 0; seg < 2; seg++){
        const pts = [];
        for(let lon = -180 + seg*180; lon <= -180 + (seg+1)*180; lon += 4) pts.push(uv(lat, lon));
        push(pts, lat === 0);
      }
    }
    for(let lon = -180; lon < 180; lon += dLon){
      const pts = [];
      for(let lat = -90; lat <= 90; lat += 3) pts.push(uv(lat, lon));
      push(pts, lon === 0);
    }
    this.grid = lines;
  }
  loadLand(){
    const url = (window.__resources && window.__resources.landTopology) || LAND_URL;
    fetch(url).then(r => r.json()).then(topo => {
      const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
      const land = [];
      let arcIndex = 0;
      const processChunk = () => {
        if (this.destroyed) return;
        const end = Math.min(topo.arcs.length, arcIndex + 10);
        for(; arcIndex < end; arcIndex++){
          const arc = topo.arcs[arcIndex];
          let x = 0, y = 0;
          const points = [];
          for(let i = 0; i < arc.length; i++){
            x += arc[i][0]; y += arc[i][1];
            if (i % 4 !== 0 && i !== arc.length - 1) continue;
            const lon = (x*sx + tx)*Math.PI/180, lat = (y*sy + ty)*Math.PI/180;
            points.push(Math.cos(lat)*Math.sin(lon), Math.sin(lat), Math.cos(lat)*Math.cos(lon));
          }
          const v = Float32Array.from(points);
          const n = points.length / 3;
          land.push({v, n, px:new Float32Array(n), py:new Float32Array(n), pz:new Float32Array(n)});
        }
        if(arcIndex < topo.arcs.length) this.landTimer = window.setTimeout(processChunk, 0);
        else {
          this.landTimer = null;
          this.land = land;
          if(this.reduced){ this.landFade = 1; this.frame(performance.now()); }
        }
      };
      processChunk();
    }).catch(() => { this.land = null; });
  }

  cfg(){
    const den = DENSITY[this.props.density] || DENSITY.balanced;
    const mo = MOTION[this.props.motion] || MOTION.quiet;
    const s = this.reduced ? 0.3 : 1;
    const rgb = hexRGB(this.props.accent ?? '#FF5F1F');
    return {den, mo, rgb,
      accent: 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')',
      accentAlpha: a => 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')',
      spin: (this.props.spinSpeed ?? mo.spin) * s,
      flow: (this.props.flowSpeed ?? 0.0022) * 60 * s,   // per-second rate
      scale: this.props.globeScale ?? 1};
  }

  /* project a precomputed unit/alt buffer into screen space (no allocation) */
  projectBuf(o){
    const {sy, cyw, sp, cp, cx, cy, R} = this.view;
    const v = o.v || o.sv, n = o.n != null ? o.n : STEPS+1;
    for(let i = 0; i < n; i++){
      const x = v[i*3], y = v[i*3+1], z0 = v[i*3+2];
      const X = x*cyw + z0*sy;
      let Z = -x*sy + z0*cyw;
      const Y = y*cp - Z*sp;
      Z = y*sp + Z*cp;
      o.px[i] = cx + R*X; o.py[i] = cy - R*Y; o.pz[i] = Z;
    }
  }
  fade(z){ return z <= 0.02 ? 0 : Math.min(1, (z - 0.02)/0.32); }

  /* ── layers ─────────────────────────────────────────────────── */
  prepareBackground(key, c){
    this.bgPendingKey = key;
    const w = Math.max(1, Math.round(this.w)), h = Math.max(1, Math.round(this.h));
    const oc = document.createElement('canvas'); oc.width = w; oc.height = h;
    const o = oc.getContext('2d');
    const scheduleStage = (stage) => {
      this.backgroundTimer = window.setTimeout(() => {
        if(this.destroyed || this.bgPendingKey !== key) return;
        stage();
      }, 0);
    };

    scheduleStage(() => {
      let g = o.createRadialGradient(w*0.15, 0, 0, w*0.15, 0, Math.hypot(w, h)*1.25);
      g.addColorStop(0, '#26262a'); g.addColorStop(0.45, '#161618'); g.addColorStop(1, '#0C0C0D');
      o.fillStyle = g; o.fillRect(0, 0, w, h);

      scheduleStage(() => {
      const gc = document.createElement('canvas'); gc.width = w; gc.height = h;
      const gx = gc.getContext('2d');
      gx.strokeStyle = 'rgba(255,255,255,' + (0.045*(this.props.gridStrength ?? 1)).toFixed(3) + ')';
      gx.lineWidth = 1;
      for(let x = 0; x <= w; x += 52){ gx.beginPath(); gx.moveTo(x+0.5, 0); gx.lineTo(x+0.5, h); gx.stroke(); }
      for(let y = 0; y <= h; y += 52){ gx.beginPath(); gx.moveTo(0, y+0.5); gx.lineTo(w, y+0.5); gx.stroke(); }
      gx.globalCompositeOperation = 'destination-in';
      const mask = gx.createRadialGradient(w*0.5, 0, 0, w*0.5, 0, Math.max(w*0.75, h*1.15));
      mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(0.42, 'rgba(0,0,0,0.85)'); mask.addColorStop(1, 'rgba(0,0,0,0)');
      gx.fillStyle = mask; gx.fillRect(0, 0, w, h);
      o.drawImage(gc, 0, 0);

      scheduleStage(() => {
      const glow = this.props.glow ?? 1;
      g = o.createRadialGradient(w*1.02, h, 0, w*1.02, h, Math.max(w, h)*0.85);
      g.addColorStop(0, c.accentAlpha(0.20*glow));
      g.addColorStop(0.45, c.accentAlpha(0.07*glow));
      g.addColorStop(1, c.accentAlpha(0));
      o.fillStyle = g; o.fillRect(0, 0, w, h);

      g = o.createRadialGradient(w/2, h/2, Math.min(w,h)*0.32, w/2, h/2, Math.max(w,h)*0.85);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.5)');
      o.fillStyle = g; o.fillRect(0, 0, w, h);
      this.bg = oc; this.bgKey = key; this.bgPendingKey = null; this.backgroundTimer = null;
      });
      });
    });
  }
  background(ctx, c){
    const key = Math.round(this.w) + 'x' + Math.round(this.h) + '|' + (this.props.gridStrength ?? 1) + '|' + (this.props.glow ?? 1) + '|' + c.accent;
    if(this.bgKey !== key && this.bgPendingKey !== key) this.prepareBackground(key, c);
    if(this.bg) ctx.drawImage(this.bg, 0, 0, this.w, this.h);
    else { ctx.fillStyle = '#0C0C0D'; ctx.fillRect(0, 0, this.w, this.h); }
  }

  sphere(ctx){
    const {cx, cy, R} = this.view;
    const mobile = this.w < 720;
    const ha = this.props.haloStrength ?? 0.45;
    let g = ctx.createRadialGradient(cx, cy, R*0.995, cx, cy, R*1.2);
    g.addColorStop(0, 'rgba(255,255,255,' + ((mobile ? 0.16 : 0.10)*ha).toFixed(3) + ')');
    g.addColorStop(0.35, 'rgba(255,255,255,' + ((mobile ? 0.065 : 0.03)*ha).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.arc(cx, cy, R*1.2, 0, Math.PI*2); ctx.fillStyle = g; ctx.fill();

    g = ctx.createRadialGradient(cx - R*0.45, cy - R*0.5, R*0.04, cx + R*0.3, cy + R*0.34, R*1.5);
    g.addColorStop(0, mobile ? '#74747f' : '#54545e'); g.addColorStop(0.42, mobile ? '#373743' : '#282830'); g.addColorStop(1, mobile ? '#1d1d24' : '#15151a');
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.fillStyle = g; ctx.fill();

    g = ctx.createRadialGradient(cx - R*0.75, cy - R*0.8, R*0.35, cx + R*0.7, cy + R*0.75, R*1.75);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.62, 'rgba(0,0,0,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.clip();
    ctx.fillStyle = g; ctx.fillRect(cx-R, cy-R, R*2, R*2); ctx.restore();

    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2);
    ctx.lineWidth = mobile ? 2.1 : 1.6; ctx.strokeStyle = mobile ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.2)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R - 1.4, Math.PI*1.02, Math.PI*1.85);
    ctx.lineWidth = mobile ? 2.8 : 2.2; ctx.strokeStyle = mobile ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.16)'; ctx.stroke();
  }

  polyline(ctx, o, alphaBase){
    this.projectBuf(o);
    const n = o.n;
    ctx.beginPath();
    let on = false, acc = 0, cnt = 0;
    for(let i = 0; i < n; i += 2){
      const f = this.fade(o.pz[i]);
      if(f <= 0){ on = false; continue; }
      acc += f; cnt++;
      if(!on){ ctx.moveTo(o.px[i], o.py[i]); on = true; } else ctx.lineTo(o.px[i], o.py[i]);
    }
    const last = n - 1;
    if(last > 0 && last % 2 !== 0){
      const f = this.fade(o.pz[last]);
      if(f > 0){
        acc += f; cnt++;
        if(!on) ctx.moveTo(o.px[last], o.py[last]); else ctx.lineTo(o.px[last], o.py[last]);
      }
    }
    if(!cnt) return;
    ctx.strokeStyle = 'rgba(255,255,255,' + (alphaBase*(acc/cnt)).toFixed(3) + ')';
    ctx.stroke();
  }

  graticule(ctx){
    const mobile = this.w < 720;
    ctx.lineWidth = mobile ? 1.25 : 1;
    for(const l of this.grid) this.polyline(ctx, l, l.major ? (mobile ? 0.18 : 0.11) : (mobile ? 0.085 : 0.05));
  }
  coastlines(ctx, dt){
    if(!this.land) return;
    this.landFade = Math.min(1, this.landFade + dt*1.1);
    const mobile = this.w < 720;
    ctx.lineWidth = mobile ? 1.25 : 1; ctx.lineJoin = 'round';
    for(const a of this.land) this.polyline(ctx, a, (mobile ? 0.46 : 0.34)*this.landFade);
  }

  /* Accent-only routes. Arc opacity is evaluated per CHUNK from the same depth
     value the nodes use, so a route dissolves at the horizon exactly where its
     node dot does — no arc ever outlives its endpoint. One ping per route,
     launched on a randomised, well-spaced delay. */
  routes(ctx, c, assemble, dt){
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for(const l of this.links){
      this.projectBuf(l);
      const rev = Math.max(0, Math.min(1, (assemble - (l.order % 7)*0.045) / 0.55));
      if(rev <= 0) continue;
      const big = l.cls === 'longhaul', mid = l.cls === 'backbone';
      const mobile = this.w < 720;
      const w = (big ? (mobile ? 2.15 : 1.6) : mid ? (mobile ? 1.85 : 1.4) : (mobile ? 1.45 : 1.15)) * c.den.arc;
      const last = Math.max(1, Math.round(STEPS*rev));

      // A wire exists only while BOTH of its nodes are visible, so it is always
      // drawn end-to-end between two dots — never cut off in mid-air. The fade is
      // applied to the whole line at once (uniform), so no gradient travels along it.
      const va = Math.max(0, Math.min(1, (l.pz[0] - 0.03)/0.16));
      const vb = Math.max(0, Math.min(1, (l.pz[STEPS] - 0.03)/0.16));
      const vis = Math.min(va, vb);
      if(vis <= 0.001) continue;
      ctx.globalAlpha = vis;
      ctx.lineWidth = w; ctx.strokeStyle = c.accent;
      if(mobile){ ctx.shadowColor = c.accentAlpha(0.32); ctx.shadowBlur = 2.5; }
      ctx.beginPath();
      ctx.moveTo(l.px[0], l.py[0]);
      for(let i = 1; i <= last; i++) ctx.lineTo(l.px[i], l.py[i]);
      ctx.stroke();
      if(mobile){ ctx.shadowBlur = 0; }
      ctx.globalAlpha = 1;
      if(!l.carries || rev < 1) continue;

      // ── one ping per route, globally rationed so only a few are ever in flight ──
      const step = c.flow*l.speed*dt;
      const flight = 1 / Math.max(0.004, c.flow*l.speed);         // seconds end-to-end
      if(l.ping < 0){
        l.wait -= dt;
        // only launch on a route the viewer can actually see, and only if a slot is free
        if(l.wait <= 0 && this.inFlight < this.pingCap && vis > 0.5){
          l.ping = 0; l.a.flash = 1; this.inFlight++;
        }
        continue;
      }
      l.ping += step;
      if(l.ping >= 1){
        l.b.flash = 1;                                            // arrival pulse
        l.ping = -1;
        l.wait = flight*(0.15 + Math.random()*0.45);              // idle stays short relative to flight
        this.inFlight = Math.max(0, this.inFlight - 1);
        continue;
      }
      // exactly one circle per route, riding on top of the wire
      const f = l.ping*STEPS;
      const i0 = Math.floor(f), fr = f - i0, i1 = Math.min(STEPS, i0 + 1);
      const x = l.px[i0] + (l.px[i1] - l.px[i0])*fr;
      const y = l.py[i0] + (l.py[i1] - l.py[i0])*fr;
      ctx.globalAlpha = vis;
      ctx.beginPath(); ctx.arc(x, y, 3.1, 0, Math.PI*2);
      ctx.fillStyle = c.accent; ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  nodes(ctx, c, assemble, dt){
    const {sy, cyw, sp, cp, cx, cy, R} = this.view;
    const total = this.nodeList.length;
    for(const n of this.nodeList){
      const x = n.v[0], y = n.v[1], z0 = n.v[2];
      const X = x*cyw + z0*sy;
      let Z = -x*sy + z0*cyw;
      const Y = y*cp - Z*sp;
      Z = y*sp + Z*cp;
      n.flash = Math.max(0, (n.flash || 0) - dt*2.0);
      const f = this.fade(Z);
      if(f <= 0) continue;
      const pop = Math.max(0, Math.min(1, (assemble - 0.25 - (n.order/total)*0.5)/0.35));
      if(pop <= 0) continue;
      const sx = cx + R*X, syy = cy - R*Y;
      const t = TIER[n.tier], core = n.tier === 'core';
      const col = core ? c.accent : '#F4F4F6';
      const pulse = 0.5 + 0.5*Math.sin(this.flowT*7*c.mo.pulse + n.order);
      const e = 1 - Math.pow(1 - pop, 3);
      ctx.globalAlpha = 0.15*f*e;
      ctx.beginPath(); ctx.arc(sx, syy, (t.glow + pulse*4)*e, 0, Math.PI*2);
      ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = f*e;
      ctx.beginPath(); ctx.arc(sx, syy, t.r*(0.6 + 0.4*e), 0, Math.PI*2);
      ctx.fillStyle = col; ctx.fill();
      if(core){
        ctx.globalAlpha = 0.38*f*e; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, syy, t.r + 5 + pulse*4, 0, Math.PI*2);
        ctx.strokeStyle = col; ctx.stroke();
      }
      if(n.flash > 0){                                  // launch / arrival ring
        const q = n.flash;
        ctx.globalAlpha = 0.5*q*f; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(sx, syy, t.r + 3 + (1 - q)*13, 0, Math.PI*2);
        ctx.strokeStyle = c.accent; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  /* ── boot-up logo intro ─────────────────────────────────────── */
  intro(ctx, c, clock){
    const easeOut = t => 1 - Math.pow(1 - t, 3);
    const easeIn = t => t*t*t;
    const cx = this.w/2, cy = this.h/2;
    const size = Math.max(18, Math.min(this.w*0.055, this.h*0.11));
    const tIn = T.in, tSnap = tIn + T.snap, tHold = tSnap + T.hold, tOut = tHold + T.out;
    if(clock > tOut) return;

    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.font = '400 ' + size.toFixed(1) + "px 'Archivo Black', ui-sans-serif, system-ui, sans-serif";
    const w1 = ctx.measureText('PROJECT').width;
    const wKid = ctx.measureText('KID').width;
    const wCreations = ctx.measureText('CREATIONS').width;
    const w2 = wKid + wCreations;
    const total = w1 + w2, x1f = cx - total/2, x2f = x1f + w1;
    const off = this.w*0.75 + total;

    let p, x1, x2, alpha = 1;
    if(clock <= tIn){
      p = easeOut(clock/tIn);
      x1 = x1f - off*(1 - p); x2 = x2f + off*(1 - p);
      alpha = Math.min(1, clock/(tIn*0.35));
    } else if(clock <= tHold){
      x1 = x1f; x2 = x2f;
    } else {
      p = easeIn((clock - tHold)/T.out);
      x1 = x1f - off*p; x2 = x2f + off*p;
      alpha = 1 - Math.pow(p, 1.6);
    }

    // meet flash: scanline sweep + core glow
    const sinceMeet = clock - tIn;
    if(sinceMeet >= 0 && sinceMeet < T.snap*2.2){
      const q = Math.min(1, sinceMeet/(T.snap*2.2));
      const fadeQ = 1 - q;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, total*0.75);
      g.addColorStop(0, c.accentAlpha(0.3*fadeQ)); g.addColorStop(1, c.accentAlpha(0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, this.w, this.h);   // gradient ends at alpha 0 — no edge
      const sweep = total*0.62*q;
      ctx.globalAlpha = fadeQ*0.85;
      ctx.fillStyle = c.accentAlpha(1);
      ctx.fillRect(cx - sweep, cy - size*0.62, 1.5, size*1.24);
      ctx.fillRect(cx + sweep, cy - size*0.62, 1.5, size*1.24);
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = Math.max(0, alpha);

    // technical accent lines, travelling with each word
    const lineY = cy + size*0.62, tick = size*0.2;
    ctx.lineCap = 'butt'; ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    // bracket ticks (white)
    ctx.moveTo(x1 - size*0.9, cy - size*0.5); ctx.lineTo(x1 - size*0.32, cy - size*0.5);
    ctx.lineTo(x1 - size*0.32, cy - size*0.5 + tick);
    ctx.moveTo(x2 + w2 + size*0.32, cy - size*0.5 + tick);
    ctx.lineTo(x2 + w2 + size*0.32, cy - size*0.5); ctx.lineTo(x2 + w2 + size*0.9, cy - size*0.5);
    // one unbroken white rule per word — they join seamlessly at centre
    ctx.moveTo(x1, lineY); ctx.lineTo(x1 + w1, lineY);
    ctx.moveTo(x2, lineY); ctx.lineTo(x2 + w2, lineY);
    ctx.stroke();

    // once joined, that single continuous rule pulses in the accent
    if(clock >= tIn && clock <= tHold){
      const q = 0.3 + 0.7*(0.5 + 0.5*Math.sin((clock - tIn)*7.5));
      ctx.strokeStyle = c.accentAlpha(q); ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(x1, lineY); ctx.lineTo(x2 + w2, lineY); ctx.stroke();
    }

    ctx.fillStyle = '#F6F6F8'; ctx.fillText('PROJECT', x1, cy);
    ctx.fillStyle = c.accent;  ctx.fillText('KID', x2, cy);
    ctx.fillStyle = '#F6F6F8'; ctx.fillText('CREATIONS', x2 + wKid, cy);
    ctx.restore();
  }

  frame(ts){
    const cv = this.canvas; if(!cv) return;
    const ctx = cv.getContext('2d'), c = this.cfg();
    const dt = this.last ? Math.min(0.05, (ts - this.last)/1000) : 0.016;
    this.last = ts;
    this.clock = Math.max(0, (ts - this.timelineStartedAt)/1000);

    if(this.count !== Math.max(12, Math.round(this.props.nodeCount ?? 25))
       || this.arcH !== (this.props.arcHeight ?? 1.8)
       || this.seed !== (this.props.seed ?? 7)) this.buildGraph();
    const wantGrid = (DENSITY[this.props.density] || DENSITY.balanced).grid.join('|');
    if(this.gridKey !== wantGrid) this.buildGraticule();

    this.pingCap = Math.max(1, Math.round(this.props.maxPings ?? 8));
    const introOn = (this.props.showIntro ?? true) && !this.reduced;
    const tOut = T.in + T.snap + T.hold + T.out;
    const mobile = this.w < 720;
    const globeStart = introOn ? tOut : 0;   // source-fidelity: the globe subsystem begins only after the the source identity intro completes
    const assembleDuration = T.assemble;
    const assemble = Math.max(0, Math.min(1, (this.clock - globeStart)/assembleDuration));
    const ease = 1 - Math.pow(1 - assemble, 3);

    this.yaw += c.spin*dt*60;
    this.flowT += c.flow*dt;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.background(ctx, c);

    const narrow = this.w < 720;
    const fitDenom = mobile ? (1.02 + 0.12*this.arcH) : (1.16 + 0.2*this.arcH);
    const fit = Math.min(this.w/2, this.h/2) / fitDenom;
    const R = Math.min(Math.min(this.w, this.h)*(mobile ? 0.48 : 0.36), fit) * c.scale * (0.92 + 0.08*ease);
    const yr = this.yaw*Math.PI/180, pr = this.pitch*Math.PI/180;
    this.view = {sy:Math.sin(yr), cyw:Math.cos(yr), sp:Math.sin(pr), cp:Math.cos(pr), cx:this.w/2, cy:mobile ? this.h*0.485 : this.h/2, R};

    if(assemble > 0){
      ctx.save();
      ctx.globalAlpha = ease;
      this.sphere(ctx);
      this.graticule(ctx);
      this.coastlines(ctx, dt);
      this.routes(ctx, c, ease, dt);
      this.nodes(ctx, c, ease, dt);
      ctx.restore();
    }
    if(assemble >= 1 && !this.assemblyAnnounced){
      this.assemblyAnnounced = true;
      window.parent.postMessage({
        type: 'pkc:boot-globe-assembled',
        rendererRunning: !this.reduced && this.raf !== null,
        assemble: 1,
      }, window.location.origin);
    }
    if(introOn) this.intro(ctx, c, this.clock);
  }
}


const canvas = document.getElementById('pkc-globe-canvas');
const root = document.querySelector('.pkc-globe');
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const globe = new PkcBootGlobe(canvas, root, {
  showIntro: !reduceMotion,
  nodeCount: 25,
  seed: 7,
  arcHeight: 1.8,
  maxPings: reduceMotion ? 1 : 8,
  flowSpeed: reduceMotion ? 0 : 0.0022,
  spinSpeed: reduceMotion ? 0 : 0.028,
  motion: 'quiet',
  accent: '#FF5F1F',
  density: 'balanced',
  globeScale: 1,
  gridStrength: 1,
  glow: 1,
  showCoastlines: true
});

Object.defineProperty(window, '__pkcBootProbe', {
  configurable: false,
  value: Object.freeze({
    get clock() { return globe.clock; },
    get assemble() {
      const introOn = (globe.props.showIntro ?? true) && !globe.reduced;
      const globeStart = introOn ? T.in + T.snap + T.hold + T.out : 0;
      return Math.max(0, Math.min(1, (globe.clock - globeStart) / T.assemble));
    },
    get frameWidth() { return globe.w; },
    get frameHeight() { return globe.h; },
    get radius() { return globe.view?.R ?? 0; },
    get hasLand() { return Array.isArray(globe.land); },
    get running() { return globe.raf !== null; },
  }),
});

const announceReady = () => {
  document.documentElement.dataset.pkcGlobeReady = reduceMotion ? 'reduced' : 'true';
  window.parent.postMessage({
    type: 'pkc:boot-globe-ready',
    reduced: reduceMotion,
    rendererRunning: window.__pkcBootProbe.running,
    assemble: window.__pkcBootProbe.assemble,
  }, window.location.origin);
};

if (document.fonts && document.fonts.ready) document.fonts.ready.then(announceReady, announceReady);
else announceReady();

const onVisibility = () => {
  if (document.hidden) {
    cancelAnimationFrame(globe.raf);
    globe.raf = null;
    globe.last = 0;
    globe.lastOperationalDrawAt = 0;
  } else if (!globe.reduced && !globe.raf) {
    globe.raf = requestAnimationFrame(globe._loop);
  }
};
document.addEventListener('visibilitychange', onVisibility);
window.addEventListener('pagehide', () => {
  document.removeEventListener('visibilitychange', onVisibility);
  globe.destroy();
}, { once: true });
