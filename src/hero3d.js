import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const BASE_YAW = Math.PI * 0.25;
const BASE_PITCH = 0;
const YAW_RANGE = Math.PI * 0.30;
const PITCH_RANGE = Math.PI * 0.12;
// Frame-rate-independent exponential damping. Higher = snappier.
//   ~10  → ~250ms time-constant
//   ~12  → ~210ms, GSAP "power2.out (0.4s)" feel
//   ~16  → ~150ms, very snappy
const TRACK_RATE = 12;
const ACCENT = 0xFF5F1F;

export function mount(el, opts = {}) {
  const { trackPointer = true, onReady = null } = opts;
  const modelUrl = el.dataset.modelUrl || '/assets/models/splatrball-400.glb';

  const getSize = () => ({ w: el.clientWidth || 380, h: el.clientHeight || 380 });
  let { w, h } = getSize();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100);
  camera.position.set(0, 0, 5);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.display = 'block';
  el.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(3, 4, 5);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(ACCENT, 0.55);
  fillLight.position.set(-3, 1, 3);
  scene.add(fillLight);
  const rimLight = new THREE.DirectionalLight(0x88ccff, 0.5);
  rimLight.position.set(0, 2, -5);
  scene.add(rimLight);
  const pointLight = new THREE.PointLight(ACCENT, 0.3, 10);
  pointLight.translateY(-2).translateZ(2);
  scene.add(pointLight);

  // yawPivot rotates around world Y → muzzle azimuth.
  // model.rotation.z → muzzle elevation (muzzle is along model-local -X).
  const yawPivot = new THREE.Group();
  scene.add(yawPivot);

  const target = { yaw: BASE_YAW, pitch: BASE_PITCH };
  const current = { yaw: BASE_YAW, pitch: BASE_PITCH };
  let model = null;
  let running = true;
  let disposed = false;

  // Pointer-tracking is opt-in. When reduced-motion is preferred the caller
  // passes trackPointer=false and the model sits at BASE_YAW.
  const onPointerMove = (e) => {
    const mx = (e.clientX / window.innerWidth) * 2 - 1;
    const my = (e.clientY / window.innerHeight) * 2 - 1;
    target.yaw = BASE_YAW + mx * YAW_RANGE;
    target.pitch = my * PITCH_RANGE;
  };
  if (trackPointer) window.addEventListener('pointermove', onPointerMove);

  const loader = new GLTFLoader();
  loader.load(modelUrl, (gltf) => {
    if (disposed) return;
    model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 0) model.scale.multiplyScalar(2.6 / maxDim);
    box.setFromObject(model);
    box.getCenter(center);
    model.position.sub(center);
    yawPivot.add(model);
    // Force one render so the first paint after fade-in includes the model.
    renderer.render(scene, camera);
    if (onReady) onReady();
  }, undefined, (err) => console.error('[hero-3d] model load failed:', err));

  let prevTime = performance.now() / 1000;
  const animate = () => {
    if (!running) return;
    const now = performance.now() / 1000;
    // Clamp dt so a backgrounded tab returning doesn't jolt the model.
    const dt = Math.min(now - prevTime, 0.1);
    prevTime = now;
    const alpha = 1 - Math.exp(-TRACK_RATE * dt);
    current.yaw   += (target.yaw   - current.yaw)   * alpha;
    current.pitch += (target.pitch - current.pitch) * alpha;
    yawPivot.rotation.y = current.yaw;
    if (model) model.rotation.z = current.pitch;
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(animate);

  const onVisibility = () => {
    if (document.hidden) {
      running = false;
      renderer.setAnimationLoop(null);
    } else if (!disposed) {
      running = true;
      prevTime = performance.now() / 1000;
      renderer.setAnimationLoop(animate);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const resize = () => {
    const s = getSize();
    if (!s.w || !s.h) return;
    camera.aspect = s.w / s.h;
    camera.updateProjectionMatrix();
    renderer.setSize(s.w, s.h);
  };
  window.addEventListener('resize', resize);
  const ro = new ResizeObserver(resize);
  ro.observe(el);

  return function dispose() {
    if (disposed) return;
    disposed = true;
    running = false;
    renderer.setAnimationLoop(null);
    if (trackPointer) window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVisibility);
    ro.disconnect();
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => { if (m && m.dispose) m.dispose(); });
      }
    });
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode === el) {
      el.removeChild(renderer.domElement);
    }
  };
}
