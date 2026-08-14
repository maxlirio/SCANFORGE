import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type LightingMode = 'studio' | 'neutral' | 'unlit';

interface Props {
  url: string;
  wireframe: boolean;
  lighting: LightingMode;
  showGrid: boolean;
  resetSignal: number;
  onLoaded(info: { triangles: number; vertices: number; textured: boolean }): void;
  onError(message: string): void;
}

/**
 * three.js viewer. Owns its own renderer/scene and is driven by props; loading
 * progress comes from the loader's real byte counts, not a timer.
 */
export function ModelViewer({
  url, wireframe, lighting, showGrid, resetSignal, onLoaded, onError,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const modelRef = useRef<THREE.Object3D | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const envRef = useRef<THREE.Texture | null>(null);
  const originalMaterials = useRef(new Map<THREE.Mesh, THREE.Material | THREE.Material[]>());
  const frameRef = useRef(0);

  const [progress, setProgress] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);

  // --- one-time scene setup -------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1117);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.01, 100);
    camera.position.set(1.6, 1.1, 1.6);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.05;
    controls.maxDistance = 20;
    controlsRef.current = controls;

    const pmrem = new THREE.PMREMGenerator(renderer);
    envRef.current = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 3, 2);
    const fill = new THREE.HemisphereLight(0xbfd4ff, 0x30302c, 0.9);
    scene.add(key, fill);

    const grid = new THREE.GridHelper(4, 40, 0x2a3346, 0x1b2233);
    grid.position.y = -0.5;
    gridRef.current = grid;
    scene.add(grid);

    const resize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      observer.disconnect();
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, []);

  // --- load the model -------------------------------------------------------
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return undefined;
    setLoading(true);
    setProgress(0);

    const loader = new GLTFLoader();
    let cancelled = false;

    loader.load(
      url,
      (gltf) => {
        if (cancelled) return;
        if (modelRef.current) {
          scene.remove(modelRef.current);
          disposeObject(modelRef.current);
        }
        originalMaterials.current.clear();

        const model = gltf.scene;
        let triangles = 0;
        let vertices = 0;
        let textured = false;
        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          originalMaterials.current.set(mesh, mesh.material);
          const geo = mesh.geometry as THREE.BufferGeometry;
          const position = geo.getAttribute('position');
          vertices += position ? position.count : 0;
          triangles += geo.index ? geo.index.count / 3 : (position?.count ?? 0) / 3;
          const material = mesh.material as THREE.MeshStandardMaterial;
          if (material?.map) {
            textured = true;
            material.map.colorSpace = THREE.SRGBColorSpace;
          }
        });

        // Frame it: the pipeline normalises scale, but other providers may not.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z) || 1;
        model.scale.setScalar(1 / longest);
        model.position.copy(center.multiplyScalar(-1 / longest));

        scene.add(model);
        modelRef.current = model;
        if (gridRef.current) {
          const scaled = new THREE.Box3().setFromObject(model);
          gridRef.current.position.y = scaled.min.y;
        }
        setLoading(false);
        setProgress(1);
        resetCamera();
        onLoaded({ triangles: Math.round(triangles), vertices, textured });
      },
      (event) => {
        if (cancelled) return;
        // Only report a fraction when the server sent a length we can trust.
        setProgress(event.lengthComputable && event.total > 0 ? event.loaded / event.total : null);
      },
      (err) => {
        if (cancelled) return;
        setLoading(false);
        onError(`Could not load the model: ${(err as Error).message}`);
      },
    );

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // --- prop-driven view state ----------------------------------------------
  useEffect(() => {
    modelRef.current?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      materials.forEach((m) => {
        const mat = m as THREE.MeshStandardMaterial;
        if ('wireframe' in mat) mat.wireframe = wireframe;
      });
    });
  }, [wireframe]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.environment = lighting === 'studio' ? envRef.current : null;
    modelRef.current?.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const original = originalMaterials.current.get(mesh);
      if (!original) return;
      const source = (Array.isArray(original) ? original[0] : original) as THREE.MeshStandardMaterial;
      if (lighting === 'unlit') {
        // Show the photographic texture exactly as captured, with no shading.
        const flat = new THREE.MeshBasicMaterial({
          map: source.map ?? null,
          color: source.map ? 0xffffff : source.color,
          vertexColors: source.vertexColors,
          side: THREE.DoubleSide,
          wireframe,
        });
        mesh.material = flat;
      } else {
        mesh.material = original;
        (source as THREE.MeshStandardMaterial).envMapIntensity = lighting === 'studio' ? 1 : 0.25;
      }
    });
  }, [lighting, wireframe]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = showGrid;
  }, [showGrid]);

  const resetCamera = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const model = modelRef.current;
    if (!camera || !controls || !model) return;
    const box = new THREE.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = (sphere.radius * 1.6) / Math.sin((camera.fov * Math.PI) / 360);
    camera.position.copy(sphere.center).add(new THREE.Vector3(0.6, 0.45, 0.9).normalize().multiplyScalar(distance));
    controls.target.copy(sphere.center);
    controls.update();
  };

  useEffect(() => {
    if (resetSignal > 0) resetCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  return (
    <div className="viewer3d" ref={mountRef}>
      {loading && (
        <div className="viewer3d__loading">
          <div className="spinner" />
          <p>
            {progress === null
              ? 'Loading model…'
              : `Loading model… ${Math.round(progress * 100)}%`}
          </p>
        </div>
      )}
    </div>
  );
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      const mat = material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.dispose();
    });
  });
}
