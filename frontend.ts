import { uuidv7 } from "uuidv7";

type Corner = { x: number; y: number };
type NormCorners = {
  tl: Corner;
  tr: Corner;
  bl: Corner;
  br: Corner;
};

const PROCESS_WIDTH = 480;
const STABLE_FRAMES = 10;
const STABLE_THRESHOLD_NORM = 6 / 480;
const COOLDOWN_MS = 1500;
const FOCUS_DELAY_MS = 300;
const DETECT_MIN_INTERVAL_MS = 60;

const video = document.getElementById("video") as HTMLVideoElement;
const overlay = document.getElementById("overlay") as HTMLCanvasElement;
const queueEl = document.getElementById("queue") as HTMLOListElement;
const hintEl = document.getElementById("hint-text") as HTMLSpanElement;
const connEl = document.getElementById("conn-state") as HTMLSpanElement;
const flashEl = document.getElementById("flash") as HTMLDivElement;
const captureBtn = document.getElementById("capture") as HTMLButtonElement | null;
const modeButtons = document.querySelectorAll<HTMLButtonElement>("#mode-toggle button[data-mode]");
const draftSection = document.getElementById("draft") as HTMLElement;
const draftPagesEl = document.getElementById("draft-pages") as HTMLOListElement;
const draftCountEl = document.getElementById("draft-count") as HTMLSpanElement;
const confirmGroupBtn = document.getElementById("confirm-group") as HTMLButtonElement;

const overlayCtx = overlay.getContext("2d")!;

type Mode = "single" | "group";
let mode: Mode = "single";

type DraftPage = {
  id: string;
  fullBlob: Blob;
  width: number;
  height: number;
  thumbUrl: string;
  liEl: HTMLLIElement;
};
let draft: DraftPage[] = [];

let currentStrict: NormCorners | null = null;
let currentLoose: NormCorners | null = null;
let prevStableSeed: NormCorners | null = null;
let stableCount = 0;
let cooldownUntil = 0;
let needsClearFrame = false;
let inFlightUploads = 0;
let detectInFlight = false;
let lastDetectAt = 0;
let cvReady = false;
let procW = PROCESS_WIDTH;
let procH = Math.round((9 / 16) * PROCESS_WIDTH);

const worker = new Worker("/vendor/frontend.worker.js");

let msgId = 0;
const pending = new Map<number, (data: any) => void>();

worker.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (data.kind === "ready") return;
  if (data.kind === "cv-ready") {
    cvReady = true;
    return;
  }
  if (data.kind === "detect") {
    detectInFlight = false;
    if (data.error) console.error("[detect]", data.error);
    onDetectResult(data.strict ?? null, data.loose ?? null);
    return;
  }
  if (typeof data.id === "number") {
    const cb = pending.get(data.id);
    if (cb) {
      pending.delete(data.id);
      cb(data);
    }
  }
};

worker.onerror = (e) => {
  console.error("[worker error]", e.message, e.filename, e.lineno);
  setHint(`worker error: ${e.message}`);
};

function ask<T = any>(payload: any, transfer?: Transferable[]): Promise<T> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, (data) => {
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    });
    worker.postMessage({ ...payload, id }, transfer ?? []);
  });
}

setHint("loading scanner…");
main().catch((e) => {
  console.error(e);
  setHint(`error: ${e.message ?? e}`);
});

async function main() {
  setHint("starting camera…");
  await startCamera();
  await waitForCv();
  setHint("point at a document");
  setConn("ready", "ok");

  captureBtn?.addEventListener("click", manualCapture);
  modeButtons.forEach((b) =>
    b.addEventListener("click", () => setMode((b.dataset.mode as Mode) ?? "single")),
  );
  confirmGroupBtn.addEventListener("click", confirmGroup);
  document.addEventListener("keydown", onKeydown);

  updateDraftUI();
  requestAnimationFrame(tick);
}

async function waitForCv() {
  while (!cvReady) await sleep(50);
}

function setMode(m: Mode) {
  mode = m;
  modeButtons.forEach((b) => {
    if (b.dataset.mode === m) b.dataset.active = "true";
    else delete b.dataset.active;
  });
}

function onKeydown(e: KeyboardEvent) {
  if (draft.length === 0) return;
  if (e.key !== "Enter" && e.key !== " ") return;
  const t = e.target as HTMLElement | null;
  if (t) {
    const tag = t.tagName;
    if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) {
      return;
    }
  }
  e.preventDefault();
  confirmGroup();
}

async function startCamera() {
  const videoConstraints: MediaTrackConstraints = {
    facingMode: { ideal: "environment" },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
    ...({
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
    } catch {}
  }

  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.onloadedmetadata = () => resolve();
  });
  await video.play();

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  console.log(`[camera] delivered ${vw}×${vh}`);

  overlay.width = vw;
  overlay.height = vh;
  procW = PROCESS_WIDTH;
  procH = Math.max(1, Math.round((vh / vw) * PROCESS_WIDTH));
}

function tick() {
  if (video.readyState >= 2 && cvReady) {
    const now = performance.now();
    if (detectInFlight && now - lastDetectAt > 2000) {
      console.warn("[detect] watchdog reset — no response in 2s");
      detectInFlight = false;
    }
    if (!detectInFlight && now - lastDetectAt >= DETECT_MIN_INTERVAL_MS) {
      lastDetectAt = now;
      detectInFlight = true;
      createImageBitmap(video)
        .then((bitmap) => {
          worker.postMessage(
            { kind: "detect", id: 0, bitmap, procWidth: procW, procHeight: procH },
            [bitmap],
          );
        })
        .catch((err) => {
          detectInFlight = false;
          console.error("createImageBitmap (detect) failed", err);
        });
    }
  }
  requestAnimationFrame(tick);
}

function onDetectResult(strict: NormCorners | null, loose: NormCorners | null) {
  currentStrict = strict;
  currentLoose = loose;
  drawOverlay(strict, loose);

  if (!strict) {
    stableCount = 0;
    prevStableSeed = null;
    needsClearFrame = false;
    if (Date.now() > cooldownUntil) {
      setHint(loose ? "tap shutter to confirm" : "point at a document");
    }
    return;
  }

  if (needsClearFrame || Date.now() < cooldownUntil) {
    setHint(needsClearFrame ? "remove document to re-arm" : "captured ✓");
    return;
  }

  if (prevStableSeed && cornersClose(strict, prevStableSeed, STABLE_THRESHOLD_NORM)) {
    stableCount++;
  } else {
    stableCount = 1;
  }
  prevStableSeed = strict;

  if (stableCount >= STABLE_FRAMES) {
    stableCount = 0;
    cooldownUntil = Date.now() + COOLDOWN_MS + FOCUS_DELAY_MS;
    needsClearFrame = true;
    scheduleCapture(strict);
  } else {
    setHint(`hold steady (${stableCount}/${STABLE_FRAMES})`);
  }
}

function manualCapture() {
  if (Date.now() < cooldownUntil) return;
  const corners = currentStrict ?? currentLoose ?? fullFrameCorners();
  cooldownUntil = Date.now() + COOLDOWN_MS + FOCUS_DELAY_MS;
  stableCount = 0;
  needsClearFrame = true;
  scheduleCapture(corners);
}

async function scheduleCapture(initialCorners: NormCorners) {
  setHint("focusing…");
  await sleep(FOCUS_DELAY_MS);
  const corners = currentStrict ?? currentLoose ?? initialCorners;
  await capture(corners);
}

async function capture(corners: NormCorners) {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(video);
  } catch (err) {
    console.error("createImageBitmap (capture) failed", err);
    setHint("capture failed");
    return;
  }
  flash();

  let res: { fullBlob: Blob; thumbBlob: Blob; width: number; height: number };
  try {
    res = await ask({ kind: "capture", bitmap, corners }, [bitmap]);
  } catch (err: any) {
    console.error("worker capture failed", err);
    setHint(`capture failed: ${err.message ?? err}`);
    return;
  }

  if (mode === "group") {
    addDraftPage(res.fullBlob, res.thumbBlob, res.width, res.height);
    setHint(`page added (${draft.length}) — enter to upload`);
    return;
  }

  const id = uuidv7();
  const thumbUrl = URL.createObjectURL(res.thumbBlob);
  try {
    const buildRes = await ask<{ pdfBlob: Blob }>({
      kind: "build-pdf",
      pages: [{ blob: res.fullBlob, width: res.width, height: res.height }],
    });
    enqueue(buildRes.pdfBlob, `${id}.pdf`, thumbUrl, 1);
  } catch (err) {
    console.error("pdf wrap failed, falling back to png", err);
    enqueue(res.fullBlob, `${id}.png`, thumbUrl, 1);
  }
}

function addDraftPage(fullBlob: Blob, thumbBlob: Blob, width: number, height: number) {
  const id = uuidv7();
  const thumbUrl = URL.createObjectURL(thumbBlob);

  const li = document.createElement("li");
  li.dataset.id = id;

  const img = document.createElement("img");
  img.src = thumbUrl;

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = `page ${draft.length + 1}`;
  meta.appendChild(name);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "delete";
  del.title = "Remove page";
  del.textContent = "✕";
  del.addEventListener("click", () => removeDraftPage(id));

  li.append(img, meta, del);
  draftPagesEl.appendChild(li);

  draft.push({ id, fullBlob, width, height, thumbUrl, liEl: li });
  updateDraftUI();
}

function removeDraftPage(id: string) {
  const idx = draft.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const [removed] = draft.splice(idx, 1);
  if (removed) {
    URL.revokeObjectURL(removed.thumbUrl);
    removed.liEl.remove();
  }
  draft.forEach((p, i) => {
    const nameEl = p.liEl.querySelector(".name");
    if (nameEl) nameEl.textContent = `page ${i + 1}`;
  });
  updateDraftUI();
}

function updateDraftUI() {
  const n = draft.length;
  draftSection.hidden = n === 0;
  draftCountEl.textContent = `${n} page${n === 1 ? "" : "s"}`;
  confirmGroupBtn.disabled = n === 0;
  confirmGroupBtn.textContent = n > 0 ? `Upload group (${n})` : "Upload group";
}

async function confirmGroup() {
  if (draft.length === 0) return;
  const pages = draft.slice();
  draft = [];
  draftPagesEl.replaceChildren();
  updateDraftUI();

  const id = uuidv7();
  const filename = `${id}.pdf`;
  const firstThumb = pages[0]!.thumbUrl;

  try {
    const res = await ask<{ pdfBlob: Blob }>({
      kind: "build-pdf",
      pages: pages.map((p) => ({ blob: p.fullBlob, width: p.width, height: p.height })),
    });
    for (let i = 1; i < pages.length; i++) URL.revokeObjectURL(pages[i]!.thumbUrl);
    enqueue(res.pdfBlob, filename, firstThumb, pages.length);
  } catch (err) {
    console.error("group pdf build failed", err);
    draft = pages;
    for (const p of pages) draftPagesEl.appendChild(p.liEl);
    updateDraftUI();
    setHint(`group upload failed: ${(err as Error).message ?? err}`);
  }
}

function enqueue(blob: Blob, filename: string, thumbUrl: string, pageCount = 1) {
  const li = document.createElement("li");
  li.dataset.state = "uploading";

  const img = document.createElement("img");
  img.src = thumbUrl;

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = pageCount > 1 ? `${filename} · ${pageCount} pages` : filename;
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
    URL.revokeObjectURL(thumbUrl);
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

function fullFrameCorners(): NormCorners {
  return {
    tl: { x: 0, y: 0 },
    tr: { x: 1, y: 0 },
    bl: { x: 0, y: 1 },
    br: { x: 1, y: 1 },
  };
}

function drawOverlay(strict: NormCorners | null, loose: NormCorners | null) {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  const corners = strict ?? loose;
  if (!corners) return;

  const W = overlay.width;
  const H = overlay.height;

  const pts: Corner[] = [
    corners.tl,
    corners.tr,
    corners.br,
    corners.bl,
  ];

  const stroke = strict ? "rgba(56, 189, 248, 0.95)" : "rgba(251, 191, 36, 0.85)";
  const fill = strict ? "rgba(56, 189, 248, 0.18)" : "rgba(251, 191, 36, 0.10)";

  overlayCtx.lineWidth = Math.max(3, W / 400);
  overlayCtx.strokeStyle = stroke;
  overlayCtx.fillStyle = fill;
  overlayCtx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x * W;
    const y = p.y * H;
    if (i === 0) overlayCtx.moveTo(x, y);
    else overlayCtx.lineTo(x, y);
  });
  overlayCtx.closePath();
  overlayCtx.fill();
  overlayCtx.stroke();

  overlayCtx.fillStyle = strict ? "rgba(56, 189, 248, 1)" : "rgba(251, 191, 36, 1)";
  for (const p of pts) {
    overlayCtx.beginPath();
    overlayCtx.arc(p.x * W, p.y * H, overlayCtx.lineWidth * 1.4, 0, Math.PI * 2);
    overlayCtx.fill();
  }
}

function flash() {
  flashEl.classList.add("fire");
  setTimeout(() => flashEl.classList.remove("fire"), 80);
}

function cornersClose(a: NormCorners, b: NormCorners, thresh: number) {
  const keys = ["tl", "tr", "bl", "br"] as const;
  for (const k of keys) {
    const dx = a[k].x - b[k].x;
    const dy = a[k].y - b[k].y;
    if (Math.hypot(dx, dy) > thresh) return false;
  }
  return true;
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
