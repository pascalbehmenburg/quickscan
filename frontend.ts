import { uuidv7 } from "uuidv7";
import { PDFDocument } from "pdf-lib";

declare global {
  interface Window {
    cv: any;
    jscanify: any;
  }
}

type Corner = { x: number; y: number };
type Corners = {
  topLeftCorner: Corner;
  topRightCorner: Corner;
  bottomLeftCorner: Corner;
  bottomRightCorner: Corner;
};

const PROCESS_WIDTH = 480;
const STABLE_FRAMES = 10;
const STABLE_THRESHOLD_PX = 6;
const MIN_AREA_RATIO = 0.12;          // strict: doc must cover ≥12% of frame
const MIN_LOOSE_AREA_RATIO = 0.05;    // loose fallback for manual button
const COOLDOWN_MS = 1500;
const FOCUS_DELAY_MS = 500;           // give camera autofocus time to lock before grabbing frame
const QUAD_EPSILON_FACTOR = 0.02;     // approxPolyDP epsilon as fraction of perimeter
const ANGLE_TOLERANCE_DEG = 25;       // reject quads with corners outside 90°±25°
const SIDE_RATIO_MAX = 4;             // reject quads where opposite sides differ >4×

const video = document.getElementById("video") as HTMLVideoElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const work = document.getElementById("work") as HTMLCanvasElement;
const queueEl = document.getElementById("queue") as HTMLOListElement;
const hintEl = document.getElementById("hint-text") as HTMLSpanElement;
const connEl = document.getElementById("conn-state") as HTMLSpanElement;
const flashEl = document.getElementById("flash") as HTMLDivElement;
const captureBtn = document.getElementById("capture") as HTMLButtonElement | null;
if (!captureBtn) {
  console.warn("capture button missing in DOM — hard-reload the page to pick up new HTML");
}

const overlayCtx = overlay.getContext("2d")!;
const workCtx = work.getContext("2d", { willReadFrequently: true })!;

const proc = document.createElement("canvas");
const procCtx = proc.getContext("2d", { willReadFrequently: true })!;

let scanner: any = null;
let cv: any = null;
let currentStrict: Corners | null = null;
let currentLoose: Corners | null = null;
let prevStableSeed: Corners | null = null;
let stableCount = 0;
let cooldownUntil = 0;
let inFlightUploads = 0;

setHint("loading scanner…");

main().catch((e) => {
  console.error(e);
  setHint(`error: ${e.message ?? e}`);
});

async function main() {
  await waitForGlobals();
  cv = window.cv;
  scanner = new window.jscanify();

  setHint("starting camera…");
  await startCamera();
  setHint("point at a document");
  setConn("ready", "ok");

  captureBtn?.addEventListener("click", manualCapture);

  requestAnimationFrame(tick);
}

async function waitForGlobals() {
  while (!window.cv || !window.jscanify) {
    await sleep(50);
  }
  if (!window.cv.Mat) {
    await new Promise<void>((resolve) => {
      window.cv["onRuntimeInitialized"] = () => resolve();
    });
  }
}

async function startCamera() {
  const videoConstraints: MediaTrackConstraints = {
    facingMode: { ideal: "environment" },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    ...({
      resizeMode: "none",
      focusMode: "continuous",
      whiteBalanceMode: "continuous",
      exposureMode: "continuous",
      advanced: [
        { focusMode: "continuous" },
        { whiteBalanceMode: "continuous" },
        { exposureMode: "continuous" },
      ],
    } as object),
  };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });
  video.srcObject = stream;

  const track = stream.getVideoTracks()[0];
  if (track) {
    try {
      await track.applyConstraints({
        advanced: [
          { focusMode: "continuous" },
          { whiteBalanceMode: "continuous" },
          { exposureMode: "continuous" },
        ],
      } as unknown as MediaTrackConstraints);
    } catch {
      // not all browsers/cameras honor these; ignore
    }
  }

  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.onloadedmetadata = () => resolve();
  });
  await video.play();

  const vw = video.videoWidth;
  const vh = video.videoHeight;

  overlay.width = vw;
  overlay.height = vh;

  proc.width = PROCESS_WIDTH;
  proc.height = Math.round((vh / vw) * PROCESS_WIDTH);

  work.width = vw;
  work.height = vh;
}

function tick() {
  try {
    detectFrame();
  } catch (e) {
    console.error("detect error", e);
  }
  requestAnimationFrame(tick);
}

function detectFrame() {
  if (video.readyState < 2) return;

  procCtx.drawImage(video, 0, 0, proc.width, proc.height);

  let src: any = null;
  try {
    src = cv.imread(proc);
    const { strict, loose } = detectQuads(src);
    currentStrict = strict;
    currentLoose = loose;
  } finally {
    if (src && typeof src.delete === "function") src.delete();
  }

  drawOverlay(currentStrict, currentLoose);

  if (!currentStrict) {
    stableCount = 0;
    prevStableSeed = null;
    if (Date.now() > cooldownUntil) {
      setHint(currentLoose ? "tap shutter to confirm" : "point at a document");
    }
    return;
  }

  if (Date.now() < cooldownUntil) {
    setHint("captured ✓");
    return;
  }

  if (prevStableSeed && cornersClose(currentStrict, prevStableSeed, STABLE_THRESHOLD_PX)) {
    stableCount++;
  } else {
    stableCount = 1;
  }
  prevStableSeed = currentStrict;

  if (stableCount >= STABLE_FRAMES) {
    stableCount = 0;
    cooldownUntil = Date.now() + COOLDOWN_MS + FOCUS_DELAY_MS;
    scheduleCapture(currentStrict);
  } else {
    setHint(`hold steady (${stableCount}/${STABLE_FRAMES})`);
  }
}

function manualCapture() {
  if (Date.now() < cooldownUntil) return;
  const corners = currentStrict ?? currentLoose ?? fullFrameCorners();
  cooldownUntil = Date.now() + COOLDOWN_MS + FOCUS_DELAY_MS;
  stableCount = 0;
  scheduleCapture(corners);
}

async function scheduleCapture(initialCorners: Corners) {
  setHint("focusing…");
  await sleep(FOCUS_DELAY_MS);
  // detection has been running during the delay against newly-focused frames;
  // prefer the latest detected corners and fall back to what we had at trigger time.
  const corners = currentStrict ?? currentLoose ?? initialCorners;
  capture(corners);
}

function detectQuads(src: any): { strict: Corners | null; loose: Corners | null } {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let strict: { quad: Corners; area: number } | null = null;
  let bestLooseIdx = -1;
  let bestLooseArea = 0;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 75, 200);
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    cv.dilate(edges, edges, kernel);
    kernel.delete();

    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const frameArea = src.rows * src.cols;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      try {
        const area = cv.contourArea(c);
        const ratio = area / frameArea;
        if (ratio < MIN_LOOSE_AREA_RATIO) continue;

        if (area > bestLooseArea) {
          bestLooseArea = area;
          bestLooseIdx = i;
        }

        if (ratio >= MIN_AREA_RATIO) {
          const peri = cv.arcLength(c, true);
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(c, approx, QUAD_EPSILON_FACTOR * peri, true);
            const pts = validateQuad(approx);
            if (pts && (!strict || area > strict.area)) {
              strict = { quad: orderCorners(pts), area };
            }
          } finally {
            approx.delete();
          }
        }
      } finally {
        c.delete();
      }
    }

    let loose: Corners | null = null;
    if (bestLooseIdx >= 0) {
      const c = contours.get(bestLooseIdx);
      try {
        loose = extremalCorners(c);
      } finally {
        c.delete();
      }
    }

    return { strict: strict?.quad ?? null, loose };
  } finally {
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
  }
}

function validateQuad(approx: any): Corner[] | null {
  if (approx.rows !== 4) return null;
  if (!cv.isContourConvex(approx)) return null;

  const pts: Corner[] = [];
  for (let i = 0; i < 4; i++) {
    pts.push({
      x: approx.data32S[i * 2],
      y: approx.data32S[i * 2 + 1],
    });
  }

  for (let i = 0; i < 4; i++) {
    const p0 = pts[(i + 3) % 4]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % 4]!;
    const v1x = p0.x - p1.x;
    const v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x;
    const v2y = p2.y - p1.y;
    const m1 = Math.hypot(v1x, v1y);
    const m2 = Math.hypot(v2x, v2y);
    if (m1 === 0 || m2 === 0) return null;
    const cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
    const angle = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (Math.abs(angle - 90) > ANGLE_TOLERANCE_DEG) return null;
  }

  const d = (a: Corner, b: Corner) => Math.hypot(a.x - b.x, a.y - b.y);
  const top = d(pts[0]!, pts[1]!);
  const right = d(pts[1]!, pts[2]!);
  const bottom = d(pts[2]!, pts[3]!);
  const left = d(pts[3]!, pts[0]!);
  if (Math.max(top, bottom) / Math.min(top, bottom) > SIDE_RATIO_MAX) return null;
  if (Math.max(left, right) / Math.min(left, right) > SIDE_RATIO_MAX) return null;

  return pts;
}

function orderCorners(pts: Corner[]): Corners {
  let tl = pts[0]!, tr = pts[0]!, br = pts[0]!, bl = pts[0]!;
  let tlSum = Infinity, brSum = -Infinity, trDiff = -Infinity, blDiff = Infinity;
  for (const p of pts) {
    const sum = p.x + p.y;
    const diff = p.x - p.y;
    if (sum < tlSum) { tlSum = sum; tl = p; }
    if (sum > brSum) { brSum = sum; br = p; }
    if (diff > trDiff) { trDiff = diff; tr = p; }
    if (diff < blDiff) { blDiff = diff; bl = p; }
  }
  return {
    topLeftCorner: tl,
    topRightCorner: tr,
    bottomLeftCorner: bl,
    bottomRightCorner: br,
  };
}

function extremalCorners(contour: any): Corners {
  const data = contour.data32S;
  const n = data.length / 2;
  let tl = { x: 0, y: 0, key: Infinity };
  let br = { x: 0, y: 0, key: -Infinity };
  let tr = { x: 0, y: 0, key: -Infinity };
  let bl = { x: 0, y: 0, key: Infinity };
  for (let i = 0; i < n; i++) {
    const x = data[i * 2]!;
    const y = data[i * 2 + 1]!;
    const sum = x + y;
    const diff = x - y;
    if (sum < tl.key) tl = { x, y, key: sum };
    if (sum > br.key) br = { x, y, key: sum };
    if (diff > tr.key) tr = { x, y, key: diff };
    if (diff < bl.key) bl = { x, y, key: diff };
  }
  return {
    topLeftCorner: { x: tl.x, y: tl.y },
    topRightCorner: { x: tr.x, y: tr.y },
    bottomLeftCorner: { x: bl.x, y: bl.y },
    bottomRightCorner: { x: br.x, y: br.y },
  };
}

function fullFrameCorners(): Corners {
  return {
    topLeftCorner: { x: 0, y: 0 },
    topRightCorner: { x: proc.width, y: 0 },
    bottomLeftCorner: { x: 0, y: proc.height },
    bottomRightCorner: { x: proc.width, y: proc.height },
  };
}

function capture(procCorners: Corners) {
  const sx = work.width / proc.width;
  const sy = work.height / proc.height;
  const fullCorners: Corners = {
    topLeftCorner: { x: procCorners.topLeftCorner.x * sx, y: procCorners.topLeftCorner.y * sy },
    topRightCorner: { x: procCorners.topRightCorner.x * sx, y: procCorners.topRightCorner.y * sy },
    bottomLeftCorner: {
      x: procCorners.bottomLeftCorner.x * sx,
      y: procCorners.bottomLeftCorner.y * sy,
    },
    bottomRightCorner: {
      x: procCorners.bottomRightCorner.x * sx,
      y: procCorners.bottomRightCorner.y * sy,
    },
  };

  workCtx.drawImage(video, 0, 0, work.width, work.height);

  const { width: outW, height: outH } = computeOutputSize(fullCorners);
  const result: HTMLCanvasElement = scanner.extractPaper(work, outW, outH, fullCorners);

  flash();

  result.toBlob(async (pngBlob) => {
    if (!pngBlob) return;
    const id = uuidv7();
    try {
      const pdfBlob = await pngCanvasToPdf(result, pngBlob);
      enqueue(pdfBlob, `${id}.pdf`, result);
    } catch (err) {
      console.error("pdf wrap failed, falling back to png", err);
      enqueue(pngBlob, `${id}.png`, result);
    }
  }, "image/png");
}

async function pngCanvasToPdf(canvas: HTMLCanvasElement, pngBlob: Blob): Promise<Blob> {
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(pngBytes);
  const page = pdf.addPage([canvas.width, canvas.height]);
  page.drawImage(png, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  const pdfBytes = await pdf.save();
  return new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
}

function enqueue(blob: Blob, filename: string, previewCanvas: HTMLCanvasElement) {
  const li = document.createElement("li");
  li.dataset.state = "uploading";

  const img = document.createElement("img");
  img.src = previewCanvas.toDataURL("image/png");

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = filename;
  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "uploading…";
  meta.append(name, status);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "delete";
  deleteBtn.title = "Remove";
  deleteBtn.textContent = "✕";
  deleteBtn.disabled = true;

  let taskId: string | null = null;

  deleteBtn.addEventListener("click", async () => {
    if (deleteBtn.disabled) return;
    deleteBtn.disabled = true;

    if (taskId) {
      const prevState = li.dataset.state;
      const prevText = status.textContent;
      li.dataset.state = "uploading";
      status.textContent = "deleting…";
      try {
        const res = await fetch(`/api/scan/${encodeURIComponent(taskId)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`${res.status} ${text.slice(0, 200)}`);
        }
      } catch (err: any) {
        li.dataset.state = prevState ?? "err";
        status.textContent = `delete failed: ${err.message ?? err}`;
        deleteBtn.disabled = false;
        console.error(err);
        return;
      }
    }
    li.remove();
  });

  li.append(img, meta, deleteBtn);
  queueEl.prepend(li);

  upload(blob, filename)
    .then((id) => {
      taskId = id;
      li.dataset.state = "ok";
      status.textContent = "stored";
      deleteBtn.disabled = false;
    })
    .catch((err) => {
      li.dataset.state = "err";
      status.textContent = `failed: ${err.message ?? err}`;
      deleteBtn.disabled = false;
      console.error(err);
    })
    .finally(updateConn);

  inFlightUploads++;
  updateConn();
}

async function upload(blob: Blob, filename: string): Promise<string | null> {
  const form = new FormData();
  form.append("document", blob, filename);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  inFlightUploads--;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return text.trim() || null;
  }
}

function updateConn() {
  if (inFlightUploads > 0) {
    setConn(`syncing ${inFlightUploads}`, "busy");
  } else {
    setConn("ready", "ok");
  }
}

function drawOverlay(strict: Corners | null, loose: Corners | null) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  const corners = strict ?? loose;
  if (!corners) return;

  const sx = overlay.width / proc.width;
  const sy = overlay.height / proc.height;

  const pts: Corner[] = [
    corners.topLeftCorner,
    corners.topRightCorner,
    corners.bottomRightCorner,
    corners.bottomLeftCorner,
  ];

  const stroke = strict ? "rgba(56, 189, 248, 0.95)" : "rgba(251, 191, 36, 0.85)";
  const fill = strict ? "rgba(56, 189, 248, 0.18)" : "rgba(251, 191, 36, 0.10)";

  overlayCtx.lineWidth = Math.max(3, overlay.width / 400);
  overlayCtx.strokeStyle = stroke;
  overlayCtx.fillStyle = fill;
  overlayCtx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x * sx;
    const y = p.y * sy;
    if (i === 0) overlayCtx.moveTo(x, y);
    else overlayCtx.lineTo(x, y);
  });
  overlayCtx.closePath();
  overlayCtx.fill();
  overlayCtx.stroke();

  overlayCtx.fillStyle = strict ? "rgba(56, 189, 248, 1)" : "rgba(251, 191, 36, 1)";
  for (const p of pts) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x * sx, p.y * sy, overlayCtx.lineWidth * 1.4, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

function flash() {
  flashEl.classList.add("fire");
  setTimeout(() => flashEl.classList.remove("fire"), 80);
}

function cornersClose(a: Corners, b: Corners, thresh: number) {
  const keys = [
    "topLeftCorner",
    "topRightCorner",
    "bottomLeftCorner",
    "bottomRightCorner",
  ] as const;
  for (const k of keys) {
    const dx = a[k].x - b[k].x;
    const dy = a[k].y - b[k].y;
    if (Math.hypot(dx, dy) > thresh) return false;
  }
  return true;
}

function computeOutputSize(c: Corners) {
  const d = (a: Corner, b: Corner) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = (d(c.topLeftCorner, c.topRightCorner) + d(c.bottomLeftCorner, c.bottomRightCorner)) / 2;
  const h = (d(c.topLeftCorner, c.bottomLeftCorner) + d(c.topRightCorner, c.bottomRightCorner)) / 2;
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

function setHint(text: string) {
  hintEl.textContent = text;
}

function setConn(label: string, state: "ok" | "busy" | "err" | "idle") {
  connEl.textContent = label;
  connEl.dataset.state = state;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
