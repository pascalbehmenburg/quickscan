/// <reference lib="webworker" />

declare const self: DedicatedWorkerGlobalScope & {
  cv: any;
  PDFLib: { PDFDocument: any };
};

// OpenCV.js does `img instanceof HTMLImageElement` / `HTMLCanvasElement`
// inside imread/imshow. Firefox workers don't expose those DOM classes as
// globals, so the identifier itself throws ReferenceError before the
// `OffscreenCanvas` branch can match. Shim them as no-op classes so the
// instanceof returns false and execution falls through to the OffscreenCanvas
// case.
const g = self as any;
if (typeof g.HTMLImageElement === "undefined") g.HTMLImageElement = class {};
if (typeof g.HTMLCanvasElement === "undefined") g.HTMLCanvasElement = class {};

self.importScripts("/vendor/pdf-lib.js");
self.importScripts("/vendor/opencv.js");

const PDFDocument = self.PDFLib.PDFDocument;

type Corner = { x: number; y: number };
type NormCorners = {
  tl: Corner;
  tr: Corner;
  bl: Corner;
  br: Corner;
};

const QUAD_EPSILON_FACTOR = 0.02;
const ANGLE_TOLERANCE_DEG = 25;
const SIDE_RATIO_MAX = 4;
const MIN_AREA_RATIO = 0.12;
const MIN_LOOSE_AREA_RATIO = 0.05;
const OUTPUT_MIN_LONG_DIM = 3000;
const THUMB_WIDTH = 256;

let cv: any = null;
const cvReady = new Promise<void>((resolve) => {
  const tryInit = () => {
    const c = (self as any).cv;
    if (c && c.Mat) {
      cv = c;
      resolve();
    } else if (c) {
      c.onRuntimeInitialized = () => {
        cv = c;
        resolve();
      };
    } else {
      setTimeout(tryInit, 10);
    }
  };
  tryInit();
});

// willReadFrequently is unreliable on OffscreenCanvas 2D contexts in Firefox —
// drop the options dict to keep us on the well-trodden path. cv.imread will
// pull pixels via a plain getImageData regardless.
const procCanvas = new OffscreenCanvas(1, 1);
const procCtx = procCanvas.getContext("2d")!;
const workCanvas = new OffscreenCanvas(1, 1);
const workCtx = workCanvas.getContext("2d")!;
const outCanvas = new OffscreenCanvas(1, 1);
const thumbCanvas = new OffscreenCanvas(1, 1);
const thumbCtx = thumbCanvas.getContext("2d")!;

self.onmessage = async (e: MessageEvent) => {
  await cvReady;
  const msg = e.data;
  try {
    switch (msg.kind) {
      case "detect":
        handleDetect(msg);
        break;
      case "capture":
        await handleCapture(msg);
        break;
      case "build-pdf":
        await handleBuildPdf(msg);
        break;
    }
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const stack = err?.stack ?? "";
    self.postMessage({
      kind: msg.kind,
      id: msg.id,
      error: stack ? `${message}\n${stack}` : message,
    });
  }
};

function handleDetect(msg: {
  id: number;
  bitmap: ImageBitmap;
  procWidth: number;
  procHeight: number;
}) {
  const bm = msg.bitmap;
  const w = Math.max(1, msg.procWidth | 0);
  const h = Math.max(1, msg.procHeight | 0);
  if (procCanvas.width !== w || procCanvas.height !== h) {
    procCanvas.width = w;
    procCanvas.height = h;
  }
  // Downscale on the worker side via drawImage — sidesteps Firefox quirks with
  // createImageBitmap resize options on a HTMLVideoElement source.
  procCtx.drawImage(bm, 0, 0, w, h);
  bm.close();

  let src: any = null;
  let strict: NormCorners | null = null;
  let loose: NormCorners | null = null;
  try {
    src = cv.imread(procCanvas);
    const out = detectQuads(src, procCanvas.width, procCanvas.height);
    strict = out.strict;
    loose = out.loose;
  } finally {
    if (src && typeof src.delete === "function") src.delete();
  }

  self.postMessage({ kind: "detect", id: msg.id, strict, loose });
}

async function handleCapture(msg: {
  id: number;
  bitmap: ImageBitmap;
  corners: NormCorners;
}) {
  const bm = msg.bitmap;
  const W = bm.width;
  const H = bm.height;
  if (workCanvas.width !== W || workCanvas.height !== H) {
    workCanvas.width = W;
    workCanvas.height = H;
  }
  workCtx.drawImage(bm, 0, 0);
  bm.close();

  const c = denorm(msg.corners, W, H);
  const { width: outW, height: outH } = computeOutputSize(c);

  outCanvas.width = outW;
  outCanvas.height = outH;

  warpInto(workCanvas, outCanvas, c, outW, outH);

  const fullBlob = await outCanvas.convertToBlob({ type: "image/png" });

  const thumbW = THUMB_WIDTH;
  const thumbH = Math.max(1, Math.round((outH / outW) * thumbW));
  if (thumbCanvas.width !== thumbW || thumbCanvas.height !== thumbH) {
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
  }
  thumbCtx.imageSmoothingEnabled = true;
  thumbCtx.imageSmoothingQuality = "high";
  thumbCtx.clearRect(0, 0, thumbW, thumbH);
  thumbCtx.drawImage(outCanvas, 0, 0, thumbW, thumbH);
  const thumbBlob = await thumbCanvas.convertToBlob({ type: "image/png" });

  self.postMessage({
    kind: "capture",
    id: msg.id,
    fullBlob,
    thumbBlob,
    width: outW,
    height: outH,
  });
}

async function handleBuildPdf(msg: {
  id: number;
  pages: { blob: Blob; width: number; height: number }[];
}) {
  const pdf = await PDFDocument.create();
  for (const p of msg.pages) {
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const png = await pdf.embedPng(bytes);
    const page = pdf.addPage([p.width, p.height]);
    page.drawImage(png, { x: 0, y: 0, width: p.width, height: p.height });
  }
  const pdfBytes = await pdf.save();
  const pdfBlob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
  self.postMessage({ kind: "build-pdf", id: msg.id, pdfBlob });
}

function denorm(n: NormCorners, W: number, H: number) {
  return {
    tl: { x: n.tl.x * W, y: n.tl.y * H },
    tr: { x: n.tr.x * W, y: n.tr.y * H },
    bl: { x: n.bl.x * W, y: n.bl.y * H },
    br: { x: n.br.x * W, y: n.br.y * H },
  };
}

function norm(c: { tl: Corner; tr: Corner; bl: Corner; br: Corner }, W: number, H: number): NormCorners {
  return {
    tl: { x: c.tl.x / W, y: c.tl.y / H },
    tr: { x: c.tr.x / W, y: c.tr.y / H },
    bl: { x: c.bl.x / W, y: c.bl.y / H },
    br: { x: c.br.x / W, y: c.br.y / H },
  };
}

function detectQuads(src: any, W: number, H: number): { strict: NormCorners | null; loose: NormCorners | null } {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let strict: { quad: NormCorners; area: number } | null = null;
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
              strict = { quad: norm(orderCorners(pts), W, H), area };
            }
          } finally {
            approx.delete();
          }
        }
      } finally {
        c.delete();
      }
    }

    let loose: NormCorners | null = null;
    if (bestLooseIdx >= 0) {
      const c = contours.get(bestLooseIdx);
      try {
        loose = norm(extremalCorners(c), W, H);
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

function orderCorners(pts: Corner[]) {
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
  return { tl, tr, bl, br };
}

function extremalCorners(contour: any) {
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
    tl: { x: tl.x, y: tl.y },
    tr: { x: tr.x, y: tr.y },
    bl: { x: bl.x, y: bl.y },
    br: { x: br.x, y: br.y },
  };
}

function computeOutputSize(c: { tl: Corner; tr: Corner; bl: Corner; br: Corner }) {
  const d = (a: Corner, b: Corner) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = (d(c.tl, c.tr) + d(c.bl, c.br)) / 2;
  const h = (d(c.tl, c.bl) + d(c.tr, c.br)) / 2;
  const long = Math.max(w, h);
  const scale = long > 0 && long < OUTPUT_MIN_LONG_DIM ? OUTPUT_MIN_LONG_DIM / long : 1;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function warpInto(
  srcCanvas: OffscreenCanvas,
  dstCanvas: OffscreenCanvas,
  corners: { tl: Corner; tr: Corner; bl: Corner; br: Corner },
  outW: number,
  outH: number,
) {
  const src = cv.imread(srcCanvas);
  const dst = new cv.Mat();
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners.tl.x, corners.tl.y,
    corners.tr.x, corners.tr.y,
    corners.bl.x, corners.bl.y,
    corners.br.x, corners.br.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outW, 0,
    0, outH,
    outW, outH,
  ]);
  let M: any = null;
  try {
    M = cv.getPerspectiveTransform(srcTri, dstTri);
    cv.warpPerspective(
      src,
      dst,
      M,
      new cv.Size(outW, outH),
      cv.INTER_LANCZOS4,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    );
    // cv.imshow rejects OffscreenCanvas (HTMLCanvasElement instanceof check).
    // Mirror its body manually: copy the RGBA pixels into ImageData.
    const imgData = new ImageData(
      new Uint8ClampedArray(dst.data),
      dst.cols,
      dst.rows,
    );
    const ctx = dstCanvas.getContext("2d")!;
    ctx.putImageData(imgData, 0, 0);
  } finally {
    if (M && typeof M.delete === "function") M.delete();
    srcTri.delete();
    dstTri.delete();
    src.delete();
    dst.delete();
  }
}

self.postMessage({ kind: "ready" });
cvReady.then(() => self.postMessage({ kind: "cv-ready" }));
