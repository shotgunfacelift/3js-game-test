import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { Capsule } from "three/examples/jsm/math/Capsule.js";

/* ===================== Renderer ===================== */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x7fbfff);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

/* ===================== Scene and Camera ===================== */
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x7fbfff, 30, 120);
scene.fog.near = 10;   // start closer to the camera
scene.fog.far = 50;    // fully opaque sooner


const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 4.6, 5);

// Crosshair
const crosshair = document.createElement("div");
crosshair.style.position = "absolute";
crosshair.style.top = "50%";
crosshair.style.left = "50%";
crosshair.style.width = "4px";
crosshair.style.height = "4px";
crosshair.style.backgroundColor = "white";
crosshair.style.transform = "translate(-50%, -50%)";
crosshair.style.zIndex = "10";
document.body.appendChild(crosshair);


/* ===================== Lights ===================== */
// Sun
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(50, 100, 50);    // high in the sky
sun.castShadow = true;

// Shadow map resolution
sun.shadow.mapSize.width = 4096;
sun.shadow.mapSize.height = 4096;
sun.shadow.bias = -0.001;   // small negative bias
sun.shadow.normalBias = 0.05; // offset along normals

// Shadowcam
const shadowRange = 200;
sun.shadow.camera.left = -shadowRange;
sun.shadow.camera.right = shadowRange;
sun.shadow.camera.top = shadowRange;
sun.shadow.camera.bottom = -shadowRange;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;

// Sun pos
sun.target.position.set(0, 0, 0);
scene.add(sun.target);

scene.add(sun);

// Ambient illum
const skyLight = new THREE.HemisphereLight(0xb1e1ff, 0x444444, 0.6);
scene.add(skyLight);

/* ===================== Ensure all objects use shadows ===================== */
scene.traverse((obj) => {
  if (obj.isMesh) {
    obj.castShadow = true;     // all meshes cast shadows
    obj.receiveShadow = true;  // all meshes receive shadows
  }
});


/* ===================== Shared Geometry and Materials ===================== */
const cubeSize = 1;
const boxGeo = new THREE.BoxGeometry(cubeSize, cubeSize, cubeSize);
const brownMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b }); // Player-placed
const greenMat = new THREE.MeshStandardMaterial({ color: 0x2b7a3a }); // Ground
const ghostMat = new THREE.MeshStandardMaterial({
  color: 0xffff00,
  opacity: 0.5,
  transparent: true
});

/* ===================== Ghost Cube ===================== */
const ghostCube = new THREE.Mesh(boxGeo, ghostMat);
ghostCube.visible = false;
ghostCube.castShadow = false;
scene.add(ghostCube);

/* ===================== Reusable Objects ===================== */
const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpBox = new THREE.Box3();
const tmpClosest = new THREE.Vector3();
const tmpMat = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const forward = new THREE.Vector3();

/* ===================== Player Movement ===================== */
const move = { forward: false, backward: false, left: false, right: false };
let sprinting = false;
let canJump = false;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();

const baseSpeed = 75;
const sprintMultiplier = 1.8;
const gravity = 20;
const jumpSpeed = 8;
const eyeHeight = 1.6;

const capsuleRadius = 0.35;
const capsuleHeight = 1.6;
const playerCollider = new Capsule(
  new THREE.Vector3(0, capsuleRadius, 0),
  new THREE.Vector3(0, capsuleHeight - capsuleRadius, 0),
  capsuleRadius
);

/* ===================== Chunk System ===================== */
const CHUNK_SIZE = 16;
const RENDER_DISTANCE = 2;

const chunks = new Map(); // key -> ChunkRecord
const chunkData = new Map(); // key -> Array<[x,y,z,type]>

const getChunkKey = (pos) =>
  `${Math.floor(pos.x / CHUNK_SIZE)},${Math.floor(pos.y / CHUNK_SIZE)},${Math.floor(
    pos.z / CHUNK_SIZE
  )}`;
const getChunkKeyFromCoords = (cx, cy, cz) => `${cx},${cy},${cz}`;
const getCellKey = (pos) =>
  `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;

function makeEmptyChunkRecord() {
  return {
    occupancy: new Map(),
    meshes: { green: null, brown: null },
    indexMaps: { green: new Map(), brown: new Map() },
    cellsByIndex: { green: [], brown: [] },
    counts: { green: 0, brown: 0 },
    capacities: { green: 0, brown: 0 }
  };
}

function addChunkToScene(key, record) {
  // (Re)add meshes to scene if present
  if (record.meshes.green) scene.add(record.meshes.green);
  if (record.meshes.brown) scene.add(record.meshes.brown);
}
function removeChunkFromScene(record) {
  if (record.meshes.green) scene.remove(record.meshes.green);
  if (record.meshes.brown) scene.remove(record.meshes.brown);
}

/* ===== Instanced helpers ===== */
function createInstancedMesh(material, capacity) {
  const mesh = new THREE.InstancedMesh(boxGeo, material, capacity);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0; // draw 0 initially
  return mesh;
}

function ensureCapacityForType(record, type, needed) {
  if (record.capacities[type] >= needed) return;

  const newCapacity = Math.max(needed, Math.max(8, record.capacities[type] * 2));
  const oldMesh = record.meshes[type];
  const mat = type === "green" ? greenMat : brownMat;
  const newMesh = createInstancedMesh(mat, newCapacity);

  // Make sure shadows are enabled on the new mesh
  newMesh.castShadow = true;
  newMesh.receiveShadow = true;

  // Copy old matrices
  if (oldMesh) {
    for (let i = 0; i < record.counts[type]; i++) {
      oldMesh.getMatrixAt(i, tmpMat);
      newMesh.setMatrixAt(i, tmpMat);
    }
    newMesh.count = record.counts[type];

    // Remove old mesh from scene
    scene.remove(oldMesh);
  }

  // Add the new mesh to the scene
  scene.add(newMesh);

  // Update the record
  record.meshes[type] = newMesh;
  record.capacities[type] = newCapacity;
}

function setInstanceAt(record, type, idx, x, y, z) {
  tmpMat.makeTranslation(x, y, z);
  record.meshes[type].setMatrixAt(idx, tmpMat);
  record.meshes[type].instanceMatrix.needsUpdate = true;
}

/* ===== Chunk create/build from data ===== */
function buildChunkFromArray(key, arr) {
  const rec = makeEmptyChunkRecord();

  // Separate by type
  const greens = [];
  const browns = [];
  for (const [x, y, z, type] of arr) {
    const ck = getCellKey({ x, y, z });
    rec.occupancy.set(ck, type);
    (type === "green" ? greens : browns).push([x, y, z, ck]);
  }

  if (greens.length) {
    ensureCapacityForType(rec, "green", greens.length);
    greens.forEach(([x, y, z, ck], i) => {
      setInstanceAt(rec, "green", i, x, y, z);
      rec.indexMaps.green.set(ck, i);
      rec.cellsByIndex.green[i] = ck;
    });
    rec.counts.green = greens.length;
    rec.meshes.green.count = rec.counts.green;
  }

  if (browns.length) {
    ensureCapacityForType(rec, "brown", browns.length);
    browns.forEach(([x, y, z, ck], i) => {
      setInstanceAt(rec, "brown", i, x, y, z);
      rec.indexMaps.brown.set(ck, i);
      rec.cellsByIndex.brown[i] = ck;
    });
    rec.counts.brown = browns.length;
    rec.meshes.brown.count = rec.counts.brown;
  }

  addChunkToScene(key, rec);
  chunks.set(key, rec);
}

function generateGroundArrayForChunk(cx, cz) {
  const out = [];
  for (let x = 0; x < CHUNK_SIZE; x++) {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      const worldX = cx * CHUNK_SIZE + x + 0.5;
      const worldZ = cz * CHUNK_SIZE + z + 0.5;
      for (let y = 0; y < 3; y++) {
        out.push([worldX, y + 0.5, worldZ, "green"]);
      }
    }
  }
  return out;
}

/* ===================== Controls ===================== */
const controls = new PointerLockControls(camera, renderer.domElement);
const overlay = document.getElementById("overlay");
overlay.addEventListener("click", () => controls.lock());
controls.addEventListener("lock", () => (overlay.style.display = "none"));
controls.addEventListener("unlock", () => (overlay.style.display = ""));

/* ===================== Keyboard Input ===================== */
document.addEventListener("keydown", (e) => {
  switch (e.code) {
    case "KeyW":
    case "ArrowUp":
      move.forward = true;
      break;
    case "KeyA":
    case "ArrowLeft":
      move.left = true;
      break;
    case "KeyS":
    case "ArrowDown":
      move.backward = true;
      break;
    case "KeyD":
    case "ArrowRight":
      move.right = true;
      break;
    case "ShiftLeft":
    case "ShiftRight":
      sprinting = true;
      break;
    case "Space":
      if (canJump) {
        velocity.y = jumpSpeed;
        canJump = false;
      }
      break;
  }
});
document.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW":
    case "ArrowUp":
      move.forward = false;
      break;
    case "KeyA":
    case "ArrowLeft":
      move.left = false;
      break;
    case "KeyS":
    case "ArrowDown":
      move.backward = false;
      break;
    case "KeyD":
    case "ArrowRight":
      move.right = false;
      break;
    case "ShiftLeft":
    case "ShiftRight":
      sprinting = false;
      break;
  }
});

let ghostEnabled = false;

document.addEventListener("keydown", (e) => {
  if (e.code === "Tab") {
    e.preventDefault(); // prevent browser focus change
    ghostEnabled = !ghostEnabled;
    ghostCube.visible = ghostEnabled;
  }
});

let gridVisible = false; // start with grid invisible

// Toggle grid visibility on G
document.addEventListener("keydown", (e) => {
  if (e.code === "KeyG") {
    gridVisible = !gridVisible;
    for (const g of gridTiles) g.visible = gridVisible;
  }
});


/* ===================== Collision ===================== */
function capsuleIntersectCorrection(capsule, box) {
  tmpVec2.subVectors(capsule.end, capsule.start);
  const segLen = tmpVec2.length();
  tmpVec2.normalize();
  const steps = 5;

  for (let i = 0; i <= steps; i++) {
    tmpVec.copy(tmpVec2).multiplyScalar((i / steps) * segLen).add(capsule.start);
    box.clampPoint(tmpVec, tmpClosest);
    const dist = tmpClosest.distanceTo(tmpVec);
    if (dist < capsule.radius) {
      const pushDir = tmpVec.clone().sub(tmpClosest).normalize();
      return { correction: pushDir.multiplyScalar(capsule.radius - dist), normal: pushDir };
    }
  }
  return null;
}

function getChunkRecordAtCell(x, y, z) {
  const key = getChunkKey({ x, y, z });
  return chunks.get(key);
}

function resolveCollisions(vel) {
  const min = playerCollider.start.clone().subScalar(capsuleRadius + cubeSize);
  const max = playerCollider.end.clone().addScalar(capsuleRadius + cubeSize);
  const visited = new Set();

  for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++)
    for (let y = Math.floor(min.y); y <= Math.floor(max.y); y++)
      for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
        const rec = getChunkRecordAtCell(x, y, z);
        if (!rec) continue;
        const ck = getCellKey({ x, y, z });
        if (visited.has(ck)) continue;
        visited.add(ck);

        if (!rec.occupancy.has(ck)) continue;

        // Box is 1x1x1 centered at (x+0.5, y+0.5, z+0.5)
        tmpBox.setFromCenterAndSize(
          tmpPos.set(x + 0.5, y + 0.5, z + 0.5),
          tmpVec.set(1, 1, 1)
        );
        const result = capsuleIntersectCorrection(playerCollider, tmpBox);
        if (result) {
          playerCollider.translate(result.correction);
          vel.sub(result.normal.clone().multiplyScalar(vel.dot(result.normal)));
        }
      }
}

/* ===================== Grid Snap ===================== */
const snapToGrid = (v) => Math.floor(v / cubeSize) * cubeSize + cubeSize / 2;

/* ===================== Prevent Right-click ===================== */
window.addEventListener("contextmenu", (e) => e.preventDefault());

/* ===================== Place / Destroy Cubes (Instanced) ===================== */
function getChunkAtWorld(x, y, z) {
  const key = getChunkKey({ x, y, z });
  return { key, rec: chunks.get(key) };
}

function addBlockAt(x, y, z, type) {
  const { key, rec } = getChunkAtWorld(x, y, z);
  if (!rec) return; // should exist (active chunk)
  const ck = getCellKey({ x, y, z });
  if (rec.occupancy.has(ck)) return; // already occupied

  // Update logical data
  rec.occupancy.set(ck, type);

  // Update persistent data
  if (!chunkData.has(key)) chunkData.set(key, []);
  const arr = chunkData.get(key);
  arr.push([x, y, z, type]);

  // Ensure capacity and write instance
  ensureCapacityForType(rec, type, rec.counts[type] + 1);
  const idx = rec.counts[type];
  setInstanceAt(rec, type, idx, x, y, z);
  rec.cellsByIndex[type][idx] = ck;
  rec.indexMaps[type].set(ck, idx);
  rec.counts[type] += 1;
  rec.meshes[type].count = rec.counts[type];
}

function removeBlockAt(x, y, z) {
  const { key, rec } = getChunkAtWorld(x, y, z);
  if (!rec) return;
  const ck = getCellKey({ x, y, z });
  const type = rec.occupancy.get(ck);
  if (!type) return;

  // Swap-remove from InstancedMesh
  const idx = rec.indexMaps[type].get(ck);
  const last = rec.counts[type] - 1;
  if (idx !== last) {
    // Move last instance into idx
    rec.meshes[type].getMatrixAt(last, tmpMat);
    rec.meshes[type].setMatrixAt(idx, tmpMat);
    const lastCell = rec.cellsByIndex[type][last];
    rec.cellsByIndex[type][idx] = lastCell;
    rec.indexMaps[type].set(lastCell, idx);
  }
  rec.counts[type] = last;
  rec.meshes[type].count = rec.counts[type];
  rec.meshes[type].instanceMatrix.needsUpdate = true;

  // Clean maps
  rec.indexMaps[type].delete(ck);
  rec.cellsByIndex[type].length = rec.counts[type];
  rec.occupancy.delete(ck);

  // Update persistent data
  if (chunkData.has(key)) {
    const arr = chunkData.get(key);
    chunkData.set(
      key,
      arr.filter((c) => !(c[0] === x && c[1] === y && c[2] === z))
    );
  }
}

/* ===== Get nearby instanced meshes for raycasting ===== */
function getNearbyInstancedMeshes(range = 2) {
  const px = Math.floor(camera.position.x / CHUNK_SIZE);
  const pz = Math.floor(camera.position.z / CHUNK_SIZE);
  const nearby = [];
  for (let dx = -range; dx <= range; dx++) {
    for (let dz = -range; dz <= range; dz++) {
      const key = getChunkKeyFromCoords(px + dx, 0, pz + dz);
      const rec = chunks.get(key);
      if (!rec) continue;
      if (rec.meshes.green && rec.counts.green > 0) nearby.push(rec.meshes.green);
      if (rec.meshes.brown && rec.counts.brown > 0) nearby.push(rec.meshes.brown);
    }
  }
  return nearby;
}

/* ===== Helpers to get instance world position by (mesh, instanceId) ===== */
function getInstanceCenter(mesh, instanceId, outVec3) {
  mesh.getMatrixAt(instanceId, tmpMat);
  outVec3.setFromMatrixPosition(tmpMat);
  return outVec3;
}

/* ===================== Mouse interactions ===================== */
window.addEventListener("mousedown", (e) => {
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  raycaster.set(camera.position, forward);

  const intersects = raycaster.intersectObjects(getNearbyInstancedMeshes(2), false);
  if (intersects.length === 0) return;
  const hit = intersects[0];

  // hit.object is an InstancedMesh, hit.instanceId is the block index
  const hitPos = getInstanceCenter(hit.object, hit.instanceId, new THREE.Vector3());

  if (e.button === 2) {
    // place: move one unit along face normal and snap
    const normal = hit.face.normal.clone();
    const pos = hitPos.clone().addScaledVector(normal, cubeSize);
    pos.set(snapToGrid(pos.x), snapToGrid(pos.y), snapToGrid(pos.z));
    addBlockAt(pos.x, pos.y, pos.z, "brown");
  } else if (e.button === 0) {
    // destroy block
    removeBlockAt(hitPos.x, hitPos.y, hitPos.z);
  }
});

/* ===================== Ghost Cube Update ===================== */
function updateGhostCube() {
  if (!controls.isLocked || !ghostEnabled) {
    ghostCube.visible = false;
    return;
  }

  forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  raycaster.set(camera.position, forward);

  const intersects = raycaster.intersectObjects(getNearbyInstancedMeshes(2), false);
  if (intersects.length === 0) {
    ghostCube.visible = false;
    return;
  }

  const hit = intersects[0];
  const hitPos = getInstanceCenter(hit.object, hit.instanceId, new THREE.Vector3());
  const normal = hit.face.normal.clone();

  ghostCube.visible = true;
  ghostCube.position.copy(hitPos).addScaledVector(normal, cubeSize);
  ghostCube.position.set(
    snapToGrid(ghostCube.position.x),
    snapToGrid(ghostCube.position.y),
    snapToGrid(ghostCube.position.z)
  );
}

/* ===================== Chunk Loading / Procedural Generation ===================== */
function loadOrGenerateChunk(cx, cz) {
  const key = getChunkKeyFromCoords(cx, 0, cz);
  if (chunks.has(key)) return;

  let arr;
  if (chunkData.has(key)) {
    arr = chunkData.get(key);
  } else {
    arr = generateGroundArrayForChunk(cx, cz);
    chunkData.set(key, arr.slice());
  }
  buildChunkFromArray(key, arr);
}

function unloadChunk(key) {
  const rec = chunks.get(key);
  if (!rec) return;
  removeChunkFromScene(rec);
  chunks.delete(key);
}

function updateChunks() {
  const px = Math.floor(camera.position.x / CHUNK_SIZE);
  const pz = Math.floor(camera.position.z / CHUNK_SIZE);
  const active = new Set();

  for (let dx = -RENDER_DISTANCE; dx <= RENDER_DISTANCE; dx++) {
    for (let dz = -RENDER_DISTANCE; dz <= RENDER_DISTANCE; dz++) {
      const cx = px + dx;
      const cz = pz + dz;
      const key = getChunkKeyFromCoords(cx, 0, cz);
      active.add(key);
      if (!chunks.has(key)) loadOrGenerateChunk(cx, cz);
    }
  }

  // Unload far chunks
  for (const [key] of chunks) {
    if (!active.has(key)) unloadChunk(key);
  }
}

/* ===================== Animate Loop ===================== */
let prevTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const time = performance.now();
  const delta = (time - prevTime) / 1000;
  prevTime = time;

  if (controls.isLocked) {
    direction.set(0, 0, 0);
    if (move.forward) direction.z -= 1;
    if (move.backward) direction.z += 1;
    if (move.left) direction.x -= 1;
    if (move.right) direction.x += 1;
    direction.normalize();

    tmpVec.set(direction.x, 0, direction.z).applyQuaternion(camera.quaternion);
    const speed = sprinting ? baseSpeed * sprintMultiplier : baseSpeed;
    velocity.x += tmpVec.x * speed * delta;
    velocity.z += tmpVec.z * speed * delta;

    velocity.x -= velocity.x * 10 * delta;
    velocity.z -= velocity.z * 10 * delta;
    velocity.y -= gravity * delta;

    const obj = controls.getObject();
    obj.position.addScaledVector(velocity, delta);

    // Update player hitbox from object position
    const feet = obj.position.clone().setY(obj.position.y - (capsuleHeight - capsuleRadius));
    const head = obj.position.clone();
    playerCollider.start.copy(feet);
    playerCollider.end.copy(head);

    // Collisions against occupied cells (axis-aligned boxes)
    resolveCollisions(velocity);
    obj.position.copy(playerCollider.end);

    // Ground check
    canJump = false;
    const min = playerCollider.start.clone().subScalar(capsuleRadius + cubeSize);
    const max = playerCollider.end.clone().addScalar(capsuleRadius + cubeSize);
    outer: for (let x = Math.floor(min.x); x <= Math.floor(max.x); x++)
      for (let y = Math.floor(min.y); y <= Math.floor(max.y); y++)
        for (let z = Math.floor(min.z); z <= Math.floor(max.z); z++) {
          const rec = getChunkRecordAtCell(x, y, z);
          if (!rec) continue;
          const ck = getCellKey({ x, y, z });
          if (!rec.occupancy.has(ck)) continue;

          tmpBox.setFromCenterAndSize(
            tmpPos.set(x + 0.5, y + 0.5, z + 0.5),
            tmpVec.set(1, 1, 1)
          );
          tmpBox.clampPoint(playerCollider.start, tmpClosest);
          if (
            playerCollider.start.distanceTo(tmpClosest) <= capsuleRadius + 0.01 &&
            velocity.y <= 0
          ) {
            canJump = true;
            velocity.y = Math.max(0, velocity.y);
            break outer;
          }
        }

    if (obj.position.y < eyeHeight) {
      velocity.y = 0;
      obj.position.y = eyeHeight;
      canJump = true;
    }
  }

  updateGhostCube();
  updateChunks();
  updateGridTiles()
  updateSolidGrayPlanes();
  renderer.render(scene, camera);
}

/* ===================== Grid Helper ===================== */
const GRID_TILE_SIZE = 64;   // size of each grid tile
const GRID_SUBDIVISIONS = 64; // subdivisions per tile
const GRID_HEIGHT = 3;        // Y offset

const gridTiles = [];

// Create 3x3 grid tiles around origin
for (let dx = -1; dx <= 1; dx++) {
  for (let dz = -1; dz <= 1; dz++) {
    const g = new THREE.GridHelper(GRID_TILE_SIZE, GRID_SUBDIVISIONS, 0x444444, 0x444444);
    g.position.set(dx * GRID_TILE_SIZE, GRID_HEIGHT, dz * GRID_TILE_SIZE);
    g.visible = false;
    scene.add(g);
    gridTiles.push(g);
  }
}

// Update grid tile positions to follow player
function updateGridTiles() {
  const px = Math.floor(camera.position.x / GRID_TILE_SIZE);
  const pz = Math.floor(camera.position.z / GRID_TILE_SIZE);

  let i = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      gridTiles[i].position.x = (px + dx) * GRID_TILE_SIZE;
      gridTiles[i].position.z = (pz + dz) * GRID_TILE_SIZE;
      i++;
    }
  }
}

/* ===================== Base Floor ===================== */
const solidGrayPlanes = [];
const GRAY_PLANE_Y = GRID_HEIGHT - 3; // 3 layers down
const planeSize = GRID_TILE_SIZE;     // same size as grid tiles
const planeSegments = 1;              // flat plane
const grayMat = new THREE.MeshStandardMaterial({ color: 0x888888 });

for (let dx = -1; dx <= 1; dx++) {
  for (let dz = -1; dz <= 1; dz++) {
    const geo = new THREE.PlaneGeometry(planeSize, planeSize, planeSegments, planeSegments);
    const plane = new THREE.Mesh(geo, grayMat);
    plane.rotation.x = -Math.PI / 2; // rotate so it lies flat on XZ
    plane.position.set(dx * planeSize, GRAY_PLANE_Y, dz * planeSize);
    plane.receiveShadow = true;
    scene.add(plane);
    solidGrayPlanes.push(plane);
  }
}

// Update positions to follow player
function updateSolidGrayPlanes() {
  const px = Math.floor(camera.position.x / planeSize);
  const pz = Math.floor(camera.position.z / planeSize);

  let i = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      solidGrayPlanes[i].position.x = (px + dx) * planeSize;
      solidGrayPlanes[i].position.z = (pz + dz) * planeSize;
      i++;
    }
  }
}


/* ===================== Shadows ===================== */
scene.traverse((obj) => {
  if (obj.isMesh) obj.castShadow = true;
});

/* ===================== Resize ===================== */
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ===================== Start ===================== */
animate();
