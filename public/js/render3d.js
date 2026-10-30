// 3D表示（Three.js）。ゲームの中身（engine/）はそのままで、同じ盤面を立体で描く。
// キャラクターとスタンドは今のドット絵（キャラチップ）を、カメラの方を向く板（ビルボード）に貼って立たせる。
// 2D版の Renderer と同じ呼び方（draw / resize / toWorld / toggleZoom / kick / closeUp）で使える
import * as THREE from '../vendor/three.module.min.js';
import { FLOOR_H } from './engine/world.js';
import { RULES } from './engine/data.js';
import { colorsOf, teamColor, BUILDING_FLOOR } from './render.js';

const CELL = 48; // キャラチップ1コマの大きさ（px）
const DIRS = [2, 1, 0, 7, 6, 5, 4, 3]; // 向き（東から時計回り8方向）→ シートの列（南・南東・東・北東・北・北西・西・南西）

// 盤面の座標（x, y, 高さ z）→ 3D空間（x, 高さ, 奥行き）
const V = (x, y, z = 0) => new THREE.Vector3(x, z, y);

// "rgba(…)" や "#…" を色と不透明度に分ける
function parseColor(css) {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return { color: new THREE.Color(r / 255, g / 255, b / 255), opacity: a };
  }
  return { color: new THREE.Color(css), opacity: 1 };
}

// 文字を板にする（名前・ダメージの数字）
function textTexture(text, color = '#fff', size = 40) {
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  ctx.font = `bold ${size}px sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  cv.width = w; cv.height = size + 16;
  ctx.font = `bold ${size}px sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 8, cv.height / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: cv.width / cv.height };
}

export class Renderer3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.gl.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#15121b');
    this.camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.5, 400);
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#3a3028', 1.6));
    const sun = this.sun = new THREE.DirectionalLight('#fff4dd', 1.6);
    sun.position.set(-20, 40, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(sun, sun.target);
    this.chips = null;
    this.sheet = null;
    this.cine = null;
    this.zoom = 'near';
    this.yaw = 0; // カメラの向き（0＝南から北を見る。2D版と同じ向き）
    this.dist = 13;
    this.tps = false; // TPS視点：自分の肩越しに、向いている方向を見る
    this.tpsOffset = 0; // TPS視点でドラッグして見回した分
    this.shakeAmp = 0; this.shakeAt = 0;
    this.target = null;
    this.mats = new Map();
    this.objMeshes = new Map();
    this.dyn = new THREE.Group(); // 毎フレーム作り直す物（弾・音の輪・数字など）
    this.scene.add(this.dyn);
    this.chars = new Map();
    this.texts = new Map();
    this.world = null;
    this.raycaster = new THREE.Raycaster();
    this.occluders = new Set(); // カメラと人物の間にあって、透かして見せる物
    // 横にドラッグするとカメラが回る（スマホでも回せるように）。ドラッグした時はクリック扱いにしない
    let down = null, dragged = false;
    canvas.addEventListener('pointerdown', e => { down = e.clientX; dragged = false; });
    canvas.addEventListener('pointermove', e => {
      if (down === null) return;
      const dx = e.clientX - down;
      if (Math.abs(dx) > 6) dragged = true;
      if (dragged) { if (this.tps) this.tpsOffset -= dx * 0.008; else this.yaw -= dx * 0.008; down = e.clientX; }
    });
    const up = () => { down = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointerleave', up);
    canvas.addEventListener('click', e => { if (dragged) { e.stopImmediatePropagation(); dragged = false; } }, true);
  }

  // ---------- 2D版と同じ呼び方 ----------

  resize() {
    const wrap = this.canvas.parentElement;
    const w = Math.max(200, wrap.clientWidth), h = Math.max(150, wrap.clientHeight || Math.round(w * 0.6));
    this.gl.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  toggleZoom() {
    this.zoom = this.zoom === 'near' ? 'fit' : 'near';
    return this.zoom;
  }

  rotate(d) {
    if (this.tps) this.tpsOffset += d;
    else this.yaw += d;
  }

  kick(amp) {
    this.shakeAmp = Math.max(this.shakeAmp * this.decay(), amp * 0.025);
    this.shakeAt = performance.now();
  }

  decay() {
    return Math.exp(-(performance.now() - this.shakeAt) / 110);
  }

  closeUp(x, y, z, scale, dur) {
    this.cine = { x, y, z, scale, start: performance.now(), dur: dur * 1000 };
  }

  // 画面の点 → 盤面の座標（高さ z の床の上）
  toWorld(clientX, clientY, z = 0) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -z);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return { x: 0, y: 0 };
    const w = this.world;
    return { x: Math.max(0, Math.min(w ? w.w : 60, p.x)), y: Math.max(0, Math.min(w ? w.h : 40, p.z)) };
  }

  // ---------- 材質・地形 ----------

  mat(css, ghost = false) {
    const key = `${css}|${ghost}`;
    if (!this.mats.has(key)) {
      const { color, opacity } = parseColor(css);
      const op = ghost ? Math.min(opacity, 0.18) : opacity;
      this.mats.set(key, new THREE.MeshLambertMaterial({ color, transparent: op < 1, opacity: op, depthWrite: op >= 1 }));
    }
    return this.mats.get(key);
  }

  // 戦闘が変わったら、地面・建物の床を作り直す
  buildStatic(b) {
    if (this.static) this.scene.remove(this.static);
    for (const m of this.objMeshes.values()) this.scene.remove(m);
    this.objMeshes.clear();
    for (const s of this.chars.values()) this.scene.remove(s.group);
    this.chars.clear();
    const g = this.static = new THREE.Group();
    const w = b.world;
    this.world = w;
    const plane = (x, y, ww, hh, css, z = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(ww, hh), this.mat(css));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(V(x + ww / 2, y + hh / 2, z));
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    plane(0, 0, w.w, w.h, '#2f2f34');
    const groundColor = { ruin: '#5e5850', anomaly: '#3d2f4f', road: '#3b3b40', site: '#6e5e46', lot: '#505055', park: '#3d5a34', crosswalk: '#9a9aa0', grass: '#4a6b3a', plaza: '#6d6a66', field: '#9b8463', parking: '#505055', rail: '#5b554d' };
    for (const gr of w.ground) {
      if (gr.kind === 'crosswalk') {
        for (let yy = gr.y + 0.3; yy < gr.y + gr.h - 0.3; yy += 0.9) plane(gr.x, yy, gr.w, 0.45, '#8c8c92', 0.012);
      } else plane(gr.x, gr.y, gr.w, gr.h, groundColor[gr.kind] || '#444', 0.005);
    }
    for (const bd of w.buildings) {
      plane(bd.x, bd.y, bd.w, bd.h, BUILDING_FLOOR[bd.kind] || '#6b5848', 0.02);
    }
    this.scene.add(g);
    // 2階の床（自分が1階にいる時は透ける）
    this.slabs = w.buildings.filter(bd => (bd.floors || 1) > 1).map(bd => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bd.w, 0.12, bd.h), this.mat('#6b5848'));
      m.position.copy(V(bd.x + bd.w / 2, bd.y + bd.h / 2, FLOOR_H - 0.06));
      m.receiveShadow = true;
      this.scene.add(m);
      return { m, bd };
    });
    // 安全地帯の壁（半径1の円柱を広げて使う）
    if (this.zoneWall) this.scene.remove(this.zoneWall);
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 6, 96, 1, true), new THREE.MeshBasicMaterial({ color: '#b66dff', transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    this.scene.add(this.zoneWall);
    this.sun.position.set(w.w * 0.3, 45, w.h * 1.1);
    this.sun.target.position.set(w.w / 2, 0, w.h / 2);
    const sc = this.sun.shadow.camera;
    sc.left = -w.w * 0.8; sc.right = w.w * 0.8; sc.top = w.h * 0.9; sc.bottom = -w.h * 0.9; sc.far = 150;
    sc.updateProjectionMatrix();
    this.battleRef = b;
  }

  // 物体の形（木は幹と葉、電柱は細い柱、それ以外は箱）
  makeObject(o, b) {
    const [top] = colorsOf(o, b);
    const h = Math.max(0.04, o.z1 - o.z0);
    let mesh;
    if (o.kind === 'tree') {
      mesh = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 2.2), this.mat('#5b3e24'));
      trunk.position.y = 1.1;
      const crown = new THREE.Mesh(new THREE.SphereGeometry(Math.max(o.w, o.h) * 0.75, 12, 10), this.mat(top));
      crown.position.y = 3.2;
      trunk.castShadow = crown.castShadow = true;
      mesh.add(trunk, crown);
      mesh.position.copy(V(o.x + o.w / 2, o.y + o.h / 2, o.z0));
      return mesh;
    }
    if (o.kind === 'pole') {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, h), this.mat(top));
    } else if (o.kind === 'drum' || o.kind === 'cone' || o.kind === 'trashcan') {
      const r = Math.min(o.w, o.h) / 2;
      mesh = new THREE.Mesh(o.kind === 'cone' ? new THREE.ConeGeometry(r, h, 12) : new THREE.CylinderGeometry(r, r, h, 16), this.mat(top));
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, h, o.h), this.mat(top));
    }
    mesh.castShadow = !/window|bush|hole|water|stairs/.test(o.kind);
    mesh.receiveShadow = true;
    return mesh;
  }

  // 物体の増減・移動・開閉を反映する
  syncObjects(b, me) {
    const seen = new Set();
    const myBuilding = b.buildingOf(me);
    for (const o of b.world.objects) {
      if (o.id.startsWith('outer_') || o.kind === 'stairs') continue;
      seen.add(o.id);
      const key = `${o.kind}|${o.open}|${o.broken}|${o.w}|${o.h}`;
      let m = this.objMeshes.get(o.id);
      if (m && m.userData.key !== key) { this.scene.remove(m); m = null; }
      if (!m) {
        m = this.makeObject(o, b);
        m.userData.key = key;
        m.userData.obj = o;
        this.objMeshes.set(o.id, m);
        this.scene.add(m);
      }
      const h = Math.max(0.04, o.z1 - o.z0);
      if (o.kind !== 'tree') m.position.copy(V(o.x + o.w / 2, o.y + o.h / 2, o.z0 + h / 2));
      // 開いた扉・割れた窓は見せない。2階の物は自分が1階にいる時は透ける。自分のいる建物の壁も透かす
      m.visible = !((o.kind === 'door' && o.open) || (o.kind === 'window' && o.broken));
      const ghost = (o.floor > me.floor) || this.occluders.has(o.id) || (myBuilding && o.building === myBuilding.id && o.floor === me.floor && (o.kind === 'wall' || o.kind === 'door' || o.kind === 'window') && (this.zoom === 'near' || this.tps));
      if (m.isMesh && m.userData.ghost !== ghost) {
        m.material = this.mat(colorsOf(o, b)[0], ghost);
        m.userData.ghost = ghost;
      }
    }
    for (const [id, m] of this.objMeshes) if (!seen.has(id)) { this.scene.remove(m); this.objMeshes.delete(id); }
    for (const { m } of this.slabs) {
      const ghost = me.floor === 0;
      m.material = this.mat('#6b5848', ghost);
    }
  }

  // ---------- キャラクター（ビルボード） ----------

  charSprite(c) {
    let s = this.chars.get(c.id);
    if (s) return s;
    const cv = document.createElement('canvas');
    cv.width = cv.height = CELL;
    const tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.2 }));
    sprite.center.set(0.5, 0.05);
    sprite.scale.set(2.1, 2.1, 1);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 32), new THREE.MeshBasicMaterial({ color: '#fff', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 24), new THREE.MeshBasicMaterial({ color: '#000', transparent: true, opacity: 0.35, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    const label = textTexture(c.name, '#fff', 30);
    const name = new THREE.Sprite(new THREE.SpriteMaterial({ map: label.tex, transparent: true, depthTest: false }));
    name.scale.set(0.42 * label.aspect, 0.42, 1);
    name.center.set(0.5, 0);
    name.renderOrder = 10;
    // スタンド（体の外に出した時）
    const scv = document.createElement('canvas');
    scv.width = scv.height = CELL;
    const stex = new THREE.CanvasTexture(scv);
    stex.magFilter = stex.minFilter = THREE.NearestFilter;
    stex.colorSpace = THREE.SRGBColorSpace;
    const stand = new THREE.Sprite(new THREE.SpriteMaterial({ map: stex, transparent: true, alphaTest: 0.2, opacity: 0.9 }));
    stand.center.set(0.5, 0.05);
    // 頭の上の体力ゲージ（観戦中だけ出す）
    const hcv = document.createElement('canvas');
    hcv.width = 64; hcv.height = 8;
    const htex = new THREE.CanvasTexture(hcv);
    htex.colorSpace = THREE.SRGBColorSpace;
    const hpBar = new THREE.Sprite(new THREE.SpriteMaterial({ map: htex, transparent: true, depthTest: false }));
    hpBar.scale.set(1.1, 0.14, 1);
    hpBar.center.set(0.5, 0);
    hpBar.renderOrder = 11;
    const group = new THREE.Group();
    group.add(shadow, ring, sprite, name, hpBar);
    this.scene.add(group);
    this.scene.add(stand);
    s = { group, sprite, ring, shadow, name, cv, tex, stand, scv, stex, hpBar, hcv, htex, lastHp: null, lastFrame: '' };
    this.chars.set(c.id, s);
    return s;
  }

  // キャラチップの1コマを板に描く（向きはカメラから見た向き）
  paintChip(cv, tex, chip, facing, fps, t, fallbackColor, memo) {
    const rel = facing - this.yaw;
    const k = ((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8;
    let sx = DIRS[k] * CELL, sy = 0;
    if (chip && fps && chip.rows >= 5) {
      const run = { 0: 1, 1: 1, 2: 0, 3: 3, 4: 3, 5: 3, 6: 2, 7: 1 }[k];
      sx = (Math.floor(t * fps) % 8) * CELL;
      sy = (run + 1) * CELL;
    }
    const key = `${sx},${sy},${chip ? 1 : 0}`;
    if (memo.last === key) return;
    memo.last = key;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, CELL, CELL);
    ctx.imageSmoothingEnabled = false;
    if (chip) ctx.drawImage(chip.img, sx, sy, CELL, CELL, 0, 0, CELL, CELL);
    else {
      // 素材が無い時は人型のシルエット
      ctx.fillStyle = fallbackColor;
      ctx.beginPath(); ctx.arc(24, 12, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(16, 20, 16, 22);
    }
    tex.needsUpdate = true;
  }

  drawChars(b, me, see, debug) {
    const live = new Set();
    for (const c of b.chars) {
      const s = this.charSprite(c);
      live.add(c.id);
      const visible = c === me || c.team === me.team || debug || see(c.x, c.y, b.baseZ(c) + 1);
      s.group.visible = visible;
      const z = b.baseZ(c);
      s.group.position.copy(V(c.x, c.y, z));
      s.shadow.position.y = c.floor * FLOOR_H - z + 0.03;
      s.ring.position.y = c.floor * FLOOR_H - z + 0.04;
      // 体の外に出したスタンド
      const sb = c.standBody;
      // 体に重なっている（先行させていない）スタンドは描かない：本体の板に隠れて端だけがはみ出して見えるため
      const apart = sb && (c.def.standBlind || Math.hypot(sb.x - c.x, sb.y - c.y) > 1.0);
      s.ring.scale.setScalar(sb && c.alive && !apart ? 1.35 : 1); // スタンドを出している間は足元の輪を大きく
      s.ring.material.color.set(this.spectate ? teamColor(c.team) : c === me ? '#06d6a0' : c.team === me.team ? '#4cc9f0' : '#ff6b6b');
      const st = c.status;
      const moving = Math.hypot(c.vx, c.vy) > 0.4;
      const fps = moving ? (Math.hypot(c.vx, c.vy) > c.def.walk + 0.3 ? 14 : 9) : 0;
      const chip = this.chips && this.chips[c.charId];
      s.memo ||= {};
      this.paintChip(s.cv, s.tex, chip, c.facing, fps, b.t, c.color, s.memo);
      const mat = s.sprite.material;
      mat.rotation = !c.alive || st.proneUntil > b.t ? Math.PI / 2 : 0;
      mat.opacity = (c.floor === 0 && b.bushAt(c.x, c.y)) || st.hideUntil > b.t ? 0.5 : 1;
      mat.color.set(!c.alive ? '#777' : c.windup ? '#ffb0b0' : st.invulnUntil > b.t ? '#ffffcc' : '#ffffff');
      s.name.position.y = this.spectate ? 2.45 : 2.35;
      s.name.visible = !(this.tps && c === me); // TPS視点では自分の名前は出さない（画面を覆うので）
      s.hpBar.visible = !!this.spectate && c.alive;
      if (s.hpBar.visible) {
        s.hpBar.position.y = 2.25;
        const k = Math.max(0, c.hp / c.maxHp);
        if (s.lastHp !== k) {
          s.lastHp = k;
          const ctx = s.hcv.getContext('2d');
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 64, 8);
          ctx.fillStyle = k > 0.5 ? '#06d6a0' : k > 0.25 ? '#ffd166' : '#ff5d73';
          ctx.fillRect(1, 1, Math.round(62 * k), 6);
          s.htex.needsUpdate = true;
        }
      }
      const showStand = c.alive && sb && apart && (c.team === me.team || debug || see(sb.x, sb.y, sb.floor * FLOOR_H + 1));
      s.stand.visible = !!showStand;
      if (showStand) {
        const car = c.def.standBlind;
        const sz = car ? 1.0 : 2.0;
        s.stand.scale.set(sz, sz, 1);
        s.stand.position.copy(V(sb.x, sb.y, sb.floor * FLOOR_H + (car ? 0.02 : 0.35 + Math.sin(b.t * 4) * 0.06)));
        s.smemo ||= {};
        this.paintChip(s.scv, s.stex, this.chips && this.chips[`${c.charId}_stand`], sb.facing, 0, b.t, c.color, s.smemo);
      }
    }
    for (const [id, s] of this.chars) if (!live.has(id)) { this.scene.remove(s.group, s.stand); this.chars.delete(id); }
  }

  // ---------- 毎フレーム作り直す物 ----------

  text(text, color) {
    const key = `${text}|${color}`;
    if (!this.texts.has(key)) {
      if (this.texts.size > 200) this.texts.clear();
      this.texts.set(key, textTexture(text, color, 40));
    }
    return this.texts.get(key);
  }

  addDisc(x, y, z, r, color, opacity = 0.5) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 32), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(V(x, y, z + 0.03));
    this.dyn.add(m);
    return m;
  }

  addRing(x, y, z, r, color, opacity = 0.8, width = 0.12) {
    const m = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.01, r - width), r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.copy(V(x, y, z + 0.04));
    this.dyn.add(m);
    return m;
  }

  drawDynamic(b, me, see, debug, hover) {
    for (const o of this.dyn.children) { o.geometry?.dispose(); if (o.material && !o.material.map) o.material.dispose?.(); }
    this.dyn.clear();
    const mine = z => z.team === me.team || debug;
    // 場の仕掛け
    for (const z of b.world.zones) {
      const zz = (z.floor ?? 0) * FLOOR_H;
      if (z.kind === 'smoke') {
        const m = new THREE.Mesh(new THREE.SphereGeometry(z.r, 16, 12), new THREE.MeshBasicMaterial({ color: '#e1e4e8', transparent: true, opacity: 0.45 * Math.min(1, (z.until - b.t) / 2), depthWrite: false }));
        m.position.copy(V(z.x, z.y, zz + 1));
        this.dyn.add(m);
      } else if (z.kind === 'caltrops' && (mine(z) || see(z.x, z.y, zz + 0.1))) this.addDisc(z.x, z.y, zz, z.r, '#e8e8f0', 0.35);
      else if (z.kind === 'silence' && mine(z)) this.addRing(z.x, z.y, zz, z.r, '#7ad1c5');
      else if (z.kind === 'powder_trap' && mine(z)) this.addRing(z.x, z.y, zz, z.r, '#f28ab2', 0.7, 0.08);
      else if (z.kind === 'hazard') this.addDisc(z.x, z.y, zz, z.r, '#ff783c', 0.35 + Math.sin(b.t * 6) * 0.06);
      else if (z.kind === 'slow') this.addDisc(z.x, z.y, zz, z.r, '#5aa0ff', 0.3);
      else if (z.kind === 'hum') this.addRing(z.x, z.y, zz, z.r * (0.3 + ((b.t * 1.2) % 1) * 0.7), '#e8c547', 0.5);
    }
    // 通過中の列車と、その予告（線路が赤く点滅）
    for (const tr of b.world.trains || []) {
      if (tr.active && tr.x0 != null) {
        const x0 = Math.max(0, tr.x0), x1 = Math.min(b.world.w, tr.x1);
        if (x1 > x0) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 3.4, tr.h - 0.7), this.mat('#d9dde3'));
          m.position.copy(V((x0 + x1) / 2, tr.y + tr.h / 2, 1.7));
          m.castShadow = true;
          this.dyn.add(m);
          const band = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 0.02, 0.15, tr.h - 0.68), this.mat('#e8c547'));
          band.position.copy(V((x0 + x1) / 2, tr.y + tr.h / 2, 1.2));
          this.dyn.add(band);
        }
      } else if (tr.warned) {
        const on = Math.floor(b.t * 4) % 2 === 0;
        const m = new THREE.Mesh(new THREE.PlaneGeometry(b.world.w, tr.h), new THREE.MeshBasicMaterial({ color: '#ff2828', transparent: true, opacity: on ? 0.35 : 0.12, depthWrite: false }));
        m.rotation.x = -Math.PI / 2;
        m.position.copy(V(b.world.w / 2, tr.y + tr.h / 2, 0.06));
        this.dyn.add(m);
      }
    }
    // 異常区域の脈動の兆し：縮んでいく輪
    const an = b.world.anomaly;
    if (an && an.pending) {
      const p = an.pending, k = Math.max(0, Math.min(1, (p.at - b.t) / 2));
      const col = p.kind === 'hazard' ? '#ff7850' : '#aa78ff';
      this.addRing(p.x, p.y, 0, p.r * (1 + k), col, 0.9, 0.15);
      this.addDisc(p.x, p.y, 0, p.r, col, 0.15 + (1 - k) * 0.2);
    }
    // 粉の山・瓦礫
    for (const p of b.world.piles || []) this.addDisc(p.x + p.w / 2, p.y + p.h / 2, p.floor * FLOOR_H, Math.max(p.w, p.h) / 2 * (p.scattered ? 1.3 : 0.75), p.material === '鉄粉' ? '#5a5c62' : p.material === 'ガラス粉' ? '#cde8f0' : '#d6d0c4', p.scattered ? 0.25 : 0.75);
    for (const r of b.world.rubble) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(r.w, 0.15, r.h), this.mat(r.kind === 'gravel' ? 'rgba(170,150,110,0.9)' : '#6e655c'));
      m.position.copy(V(r.x + r.w / 2, r.y + r.h / 2, (r.floor ?? 0) * FLOOR_H + 0.07));
      this.dyn.add(m);
    }
    // 拾える物
    for (const it of b.world.items) {
      const z = (it.floor ?? 0) * FLOOR_H;
      if (!debug && !see(it.x, it.y, z + 0.2)) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.18, 0.35), this.mat('#f2c14e'));
      m.position.copy(V(it.x, it.y, z + 0.09 + Math.sin(b.t * 3 + it.x) * 0.03));
      m.rotation.y = b.t + it.x;
      this.dyn.add(m);
    }
    // 密室の炎
    for (const bd of b.world.buildings) {
      if (!bd.sealed) continue;
      const hh = (bd.floors || 1) * FLOOR_H;
      const m = new THREE.Mesh(new THREE.BoxGeometry(bd.w + 0.3, hh, bd.h + 0.3), new THREE.MeshBasicMaterial({ color: '#ff9b3d', transparent: true, opacity: 0.25 + Math.sin(b.t * 8) * 0.05, side: THREE.DoubleSide, depthWrite: false }));
      m.position.copy(V(bd.x + bd.w / 2, bd.y + bd.h / 2, hh / 2));
      this.dyn.add(m);
    }
    // 飛来物
    for (const p of b.world.projectiles) {
      if (!debug && !see(p.x, p.y, p.z)) continue;
      const m = new THREE.Mesh(new THREE.SphereGeometry(p.kind === 'ball' ? 0.09 : p.bolt ? 0.22 : 0.18, 10, 8), new THREE.MeshBasicMaterial({ color: p.bolt ? (p.color || '#ffb347') : p.kind === 'ball' ? '#e8e8ff' : '#ffcf6b' }));
      m.position.copy(V(p.x, p.y, p.z));
      this.dyn.add(m);
    }
    // エコー・ビーチの個体・コルベットの口
    for (const c of b.chars) {
      if (c.units) {
        for (const u of c.units) {
          if (u.state === 'dead' || u.state === 'home' || u.state === 'attached') continue;
          if (!(c.team === me.team || debug || (u.floor === me.floor && Math.hypot(u.x - me.x, u.y - me.y) <= 2.5))) continue;
          const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), new THREE.MeshBasicMaterial({ color: b.isLoud(u.sound) ? '#ff7b54' : u.sound ? '#ffe08a' : '#7ad1c5' }));
          m.position.copy(V(u.x, u.y, (u.floor ?? 0) * FLOOR_H + 0.4));
          this.dyn.add(m);
        }
      }
      if (c.mouths && c.mouths.length) {
        for (const mo of b.mouthSpots(c)) {
          const near = mo.floor === me.floor && Math.hypot(mo.x - me.x, mo.y - me.y) <= 2.5;
          if (!(c.team === me.team || debug || near || mo.revealedUntil > b.t)) continue;
          const m = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 6), new THREE.MeshBasicMaterial({ color: '#c81d25' }));
          m.scale.set(1.4, 0.6, 1);
          m.position.copy(V(mo.x, mo.y, (mo.floor ?? 0) * FLOOR_H + (mo.on ? 1.25 : 0.06)));
          this.dyn.add(m);
        }
      }
    }
    // 音の輪・ダメージの数字・打撃の光
    const now = b.t;
    for (const f of b.fx) {
      if (f.visibleTo && !debug && !f.visibleTo.has(me.id)) continue;
      const age = now - f.t;
      if (f.kind === 'sound' && age < 1.2) this.addRing(f.x, f.y, (f.z ?? 0) - 0.3, Math.min(f.radius, 6) * (0.2 + age / 1.2), '#ffd166', 0.8 * (1 - age / 1.2), 0.08);
      else if (f.kind === 'num' && age < 1.1) {
        const { tex, aspect } = this.text(f.text, f.color || '#ff5d73');
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, opacity: 1 - age / 1.1 }));
        const sz = f.big ? 0.8 : 0.55;
        s.scale.set(sz * aspect, sz, 1);
        s.position.copy(V(f.x, f.y + 0.6, (f.z ?? 1.8) + 0.6 + age * 1.2));
        s.renderOrder = 20;
        this.dyn.add(s);
      } else if (f.kind === 'hit' && age < 0.2) {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.3 + f.dmg * 0.02, 12, 8), new THREE.MeshBasicMaterial({ color: f.guarded ? '#cccccc' : '#ffffff', transparent: true, opacity: 1 - age / 0.2 }));
        s.position.copy(V(f.x, f.y, f.z ?? 1.1));
        this.dyn.add(s);
      }
    }
    // 安全地帯
    const z = b.safeZone;
    this.zoneWall.visible = !!z;
    if (z) {
      const r = b.zoneRadius();
      this.zoneWall.scale.set(r, 1, r);
      this.zoneWall.position.copy(V(z.x, z.y, 3));
      const next = this.nextZone(b);
      if (next < r - 0.5) this.addRing(z.x, z.y, 0, next, '#ffffff', 0.5, 0.1);
    }
    // カーソルの位置
    if (hover) this.addRing(hover.x, hover.y, me.floor * FLOOR_H, 0.35, '#f2c14e', 0.9, 0.08);
  }

  // 次に縮み終わった時の半径
  nextZone(b) {
    const ph = RULES.zonePhases.find(([, t1]) => b.t < t1);
    return ph ? b.zoneRadius(ph[1]) : b.zoneRadius();
  }

  // カメラから自分・味方（見えている敵も）への線を遮る物は、次のフレームから透かす
  findOccluders(b, me, debug) {
    const occ = new Set();
    const meshes = [...this.objMeshes.values()].filter(m => m.visible);
    const from = this.camera.position;
    for (const c of b.chars) {
      if (!c.alive || !(c === me || c.team === me.team || debug || b.canSee(me, c.x, c.y))) continue;
      for (const h of [0.4, 1.4]) {
        const to = V(c.x, c.y, b.baseZ(c) + h);
        const dir = to.clone().sub(from);
        const len = dir.length();
        this.raycaster.set(from, dir.normalize());
        this.raycaster.far = len - 0.3;
        for (const hit of this.raycaster.intersectObjects(meshes, true)) {
          let m = hit.object;
          while (m && !m.userData.obj) m = m.parent;
          if (m) occ.add(m.userData.obj.id);
        }
      }
    }
    this.raycaster.far = Infinity;
    this.occluders = occ;
  }

  // ---------- 描く ----------

  draw(b, { debug = false, hover = null, viewer = null, spectate = false, preview = null } = {}) {
    if (this.battleRef !== b) this.buildStatic(b);
    this.spectate = spectate;
    const me = viewer || b.player;
    const see = (x, y, z) => debug || b.canSee(me, x, y, z);
    this.syncObjects(b, me);
    this.drawChars(b, me, see, debug);
    this.drawDynamic(b, me, see, debug, hover);
    // 組み立て中の計画：移動の経路と、手順の番号つきの印
    if (preview && preview.length) {
      const z = me.floor * FLOOR_H + 0.06;
      const line = [V(me.x, me.y, z), ...preview.filter(p => p.move).map(p => V(p.x, p.y, z))];
      if (line.length > 1) this.dyn.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), new THREE.LineBasicMaterial({ color: '#f2c14e' })));
      for (const p of preview) {
        this.addDisc(p.x, p.y, me.floor * FLOOR_H, 0.35, p.move ? '#f2c14e' : '#9be7ff', 0.9);
        const { tex, aspect } = this.text(String(p.n), '#f2c14e');
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
        s.scale.set(0.5 * aspect, 0.5, 1);
        s.position.copy(V(p.x, p.y, me.floor * FLOOR_H + 0.9));
        s.renderOrder = 20;
        this.dyn.add(s);
      }
    }

    if (this.tps && me.alive) {
      this.drawTps(b, me, debug);
      return;
    }
    if (this.camera.fov !== 45) { this.camera.fov = 45; this.camera.updateProjectionMatrix(); }
    // カメラ：近くでは自分を後ろ斜め上から追い、全体では真上寄りから全体を見る
    const w = b.world;
    let tx, ty, tz, dist, pitch;
    if (this.zoom === 'near') {
      tx = me.x; ty = me.y; tz = b.baseZ(me) + 1; dist = this.dist; pitch = 1.05;
    } else {
      tx = w.w / 2; ty = w.h / 2; tz = 0; dist = Math.max(w.w, w.h) * 1.05; pitch = 1.12;
    }
    // クローズアップ（大ダメージ・近接の決め技）
    const now = performance.now();
    if (this.cine) {
      const c = this.cine;
      const k = (now - c.start) / c.dur;
      if (k >= 1) this.cine = null;
      else {
        const a = Math.min(1, k * 5, (1 - k) * 4);
        tx += (c.x - tx) * a; ty += (c.y - ty) * a; tz += ((c.z ?? 1) - tz) * a;
        dist /= 1 + (c.scale - 1) * a;
      }
    }
    const want = new THREE.Vector3(tx, tz, ty);
    this.target = this.target ? this.target.lerp(want, 0.18) : want.clone();
    const cam = this.camera;
    cam.position.set(
      this.target.x - Math.sin(this.yaw) * Math.cos(pitch) * dist,
      this.target.y + Math.sin(pitch) * dist,
      this.target.z + Math.cos(this.yaw) * Math.cos(pitch) * dist,
    );
    const shake = this.shakeAmp * this.decay();
    if (shake > 0.01) cam.position.add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake));
    cam.lookAt(this.target);
    this.findOccluders(b, me, debug);
    this.gl.render(this.scene, cam);
  }

  // TPS視点：自分の後ろ・少し右上から、向いている方向を見る。向きが変わるとカメラもゆっくり回り込む
  drawTps(b, me, debug) {
    const cam = this.camera;
    if (cam.fov !== 62) { cam.fov = 62; cam.updateProjectionMatrix(); }
    const wantYaw = me.facing + Math.PI / 2 + this.tpsOffset;
    let dy = ((wantYaw - this.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.yaw += dy * 0.15;
    const fx = Math.sin(this.yaw), fy = -Math.cos(this.yaw); // 前（盤面の座標）
    const rx = Math.cos(this.yaw), ry = Math.sin(this.yaw); // 右
    const z = b.baseZ(me);
    const want = V(me.x - fx * 4.2 + rx * 0.7, me.y - fy * 4.2 + ry * 0.7, z + 2.3);
    const look = V(me.x + fx * 6, me.y + fy * 6, z + 1.2);
    this.tpsPos = this.tpsPos ? this.tpsPos.lerp(want, 0.3) : want.clone();
    this.tpsLook = this.tpsLook ? this.tpsLook.lerp(look, 0.3) : look.clone();
    cam.position.copy(this.tpsPos);
    const shake = this.shakeAmp * this.decay();
    if (shake > 0.01) cam.position.add(new THREE.Vector3((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake));
    cam.lookAt(this.tpsLook);
    this.target = this.tpsLook.clone();
    this.findOccluders(b, me, debug);
    this.gl.render(this.scene, cam);
  }
}
