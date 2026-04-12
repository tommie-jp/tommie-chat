/**
 * RPG Maker character chip sprite-sheet utilities for Babylon.js.
 *
 * Pure functions with no DOM/UI dependencies (canvas usage for image
 * processing is the only browser API relied upon).
 */

// ──────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────

export type SheetFormat = 'MV' | '2003' | 'XP';

export interface SheetInfo {
  format: SheetFormat;
  frameW: number;
  frameH: number;
  charCols: number;
  charRows: number;
  sheetW: number;
  sheetH: number;
  fCols: number;
  scale: number;
}

export interface AnimRange {
  from: number;
  to: number;
  manual: boolean;
}

export interface DirDetectResult {
  dir: string;
  confidence: number;
  raw?: {
    skinTop: number;
    skinMid: number;
    skinL: number;
    skinR: number;
    nonBg: number;
    totalSkin: number;
  };
}

// ──────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────

export const CHAR_COLS = 4;
export const CHAR_ROWS = 2;
export const N_DIRS = 4;
export const N_FRAMES = 3;
export const DIR_LABELS = ['下 (DOWN)', '左 (LEFT)', '右 (RIGHT)', '上 (UP)'];
export const DIR_VALS = ['down', 'left', 'right', 'up'];

// ──────────────────────────────────────────────────────────────────────
// Functions
// ──────────────────────────────────────────────────────────────────────

/**
 * Analyse sheet dimensions and return format / frame info.
 *
 * Based on the original `updateSheetDims()`.  Checks 2003 format first,
 * then a known-size map, then auto-detects from candidate frame sizes.
 */
export function analyzeSheet(w: number, h: number): SheetInfo {
  let fw = 0;
  let fh = 0;
  let cc = 0;
  let cr = 0;
  let format: SheetFormat = 'MV';

  // ── 2003 format detection (first pass) ───────────────────────────
  {
    const fw4 = w / 4;
    const fh4 = h / 4;
    if (
      Number.isInteger(fw4) &&
      Number.isInteger(fh4) &&
      fw4 % N_FRAMES !== 0 &&
      fw4 >= 16 &&
      fh4 >= 16
    ) {
      fw = fw4;
      fh = fh4;
      cc = 1;
      cr = 1;
      format = '2003';
      const scale = fw <= 48 ? 2 : 1;
      return {
        format,
        frameW: fw,
        frameH: fh,
        charCols: 1,
        charRows: 1,
        sheetW: w,
        sheetH: h,
        fCols: 4,
        scale,
      };
    }
  }

  // ── 2003 format detection (second pass, relaxed) ─────────────────
  {
    const fw4 = w / 4;
    const fh4 = h / 4;
    if (
      Number.isInteger(fw4) &&
      Number.isInteger(fh4) &&
      fw4 % N_FRAMES !== 0
    ) {
      fw = fw4;
      fh = fh4;
      cc = 1;
      cr = 1;
      format = '2003';
      const scale = fw <= 56 ? 2 : 1;
      return {
        format,
        frameW: fw,
        frameH: fh,
        charCols: 1,
        charRows: 1,
        sheetW: w,
        sheetH: h,
        fCols: 4,
        scale,
      };
    }
  }

  // ── Known-size map ───────────────────────────────────────────────
  const KNOWN: Record<string, [number, number, number, number, string?]> = {
    // [fw, fh, cc, cr]
    // ── RPG Maker MV / MZ ──────────────────────────────
    '576x384': [48, 48, 4, 2],    // standard 8-char
    '1152x768': [96, 96, 4, 2],   // large 8-char
    '384x256': [32, 32, 4, 2],    // small 8-char
    '144x192': [48, 48, 1, 1],    // $ single
    '288x384': [96, 96, 1, 1],    // $ large single
    '192x256': [64, 64, 1, 1],    // $ medium single
    '96x128': [32, 32, 1, 1],     // $ small single
    '144x256': [48, 64, 1, 1],    // $ single 48x64 (tall)
    // ── RPG Maker XP ───────────────────────────────────
    // 1-char, 4 frames x 4 dirs, frame 48x64
    // Note: 192x256 is already mapped above (MV takes priority in the map)
    // '192x256': [48, 64, 1, 1, 'XP'],  // XP standard
    '128x192': [32, 48, 1, 1, 'XP'],     // XP small (same dims as 2003)
    // ── RPG Maker 2000 / XP ────────────────────────────
    '288x256': [24, 32, 4, 2],    // 2000 standard 8-char (24x32 non-square)
    '144x128': [12, 16, 4, 2],    // 2000 small
    '576x512': [48, 64, 4, 2],    // 2000 large or XP
    '240x160': [20, 20, 4, 2],    // XP small
    '480x320': [40, 40, 4, 2],    // XP standard
  };

  const known = KNOWN[w + 'x' + h];
  if (known) {
    [fw, fh, cc, cr] = known;
    if (known[4] === 'XP') format = 'XP';
  } else {
    // ── Auto-detect from candidate frame sizes ─────────────────────
    const cands = [16, 24, 32, 48, 64, 96, 128];
    let bestPrimary = -Infinity;
    let bestTie = -Infinity;
    for (const tryFw of cands) {
      if (w % (tryFw * N_FRAMES) !== 0) continue;
      const tryCC = w / (tryFw * N_FRAMES);
      if (tryCC < 1 || tryCC > 4) continue;
      for (const tryFh of cands) {
        if (h % (tryFh * N_DIRS) !== 0) continue;
        const tryCR = h / (tryFh * N_DIRS);
        if (tryCR < 1 || tryCR > 4) continue;
        const nC = tryCC * tryCR;
        const sq = -Math.abs(tryFw - tryFh);            // 0 = square (best)
        const pri = sq * 1000 + (nC <= 8 ? nC : -100);  // charCount bonus
        const tie = tryFw + tryFh;                       // prefer larger frames
        if (pri > bestPrimary || (pri === bestPrimary && tie > bestTie)) {
          bestPrimary = pri;
          bestTie = tie;
          fw = tryFw;
          fh = tryFh;
          cc = tryCC;
          cr = tryCR;
        }
      }
    }
  }

  // ── Fallback ─────────────────────────────────────────────────────
  if (fw === 0) {
    cc = CHAR_COLS;
    cr = CHAR_ROWS;
    fw = Math.round(w / (cc * N_FRAMES));
    fh = Math.round(h / (cr * N_DIRS));
  }

  const fCols = cc * N_FRAMES;
  const scale = fw <= 56 ? 2 : 1;

  format = 'MV';

  return {
    format,
    frameW: fw,
    frameH: fh,
    charCols: cc,
    charRows: cr,
    sheetW: w,
    sheetH: h,
    fCols,
    scale,
  };
}

/**
 * Compute the linear cell index for a given character position, direction
 * and animation frame within the sprite sheet.
 */
export function cellIndex(
  info: SheetInfo,
  charCol: number,
  charRow: number,
  dir: number,
  frame: number,
): number {
  if (info.format === '2003' || info.format === 'XP') {
    return dir * 4 + frame;
  }
  return (charRow * N_DIRS + dir) * info.fCols + charCol * N_FRAMES + frame;
}

/**
 * Return the animation range (from/to cell indices) for a character
 * walking in the given direction.
 */
export function animRange(
  info: SheetInfo,
  charCol: number,
  charRow: number,
  dir: number,
): AnimRange {
  if (info.format === '2003') {
    return {
      from: cellIndex(info, 0, 0, dir, 0),
      to: cellIndex(info, 0, 0, dir, 2),
      manual: true,
    };
  }
  return {
    from: cellIndex(info, charCol, charRow, dir, 0),
    to: cellIndex(info, charCol, charRow, dir, 2),
    manual: false,
  };
}

/**
 * Convert a world-space movement vector into a sprite direction index
 * (0=down, 1=left, 2=right, 3=up), accounting for camera rotation.
 */
export function worldDirToSpriteDir(
  mvx: number,
  mvz: number,
  camAlpha: number,
): number {
  const a = camAlpha;
  const sr = -mvx * Math.sin(a) + mvz * Math.cos(a);
  const su = mvx * Math.cos(a) + mvz * Math.sin(a);
  if (Math.abs(sr) >= Math.abs(su)) {
    return sr > 0 ? 2 : 1;
  } else {
    return su > 0 ? 0 : 3;
  }
}

/** Convert a hex colour string (`#rrggbb`) to an `[r, g, b]` tuple. */
export function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** Convert RGB components to a hex colour string (`#rrggbb`). */
export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
  );
}

/** Load an image from a `src` URL and resolve with the `HTMLImageElement`. */
export function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    if (!src.startsWith('data:') && !src.startsWith('blob:')) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

/**
 * Build a transparency-processed, upscaled PNG from a sprite-sheet image.
 *
 * Flood-fills from the sheet edges to remove the background colour, applies
 * edge anti-aliasing, then upscales with nearest-neighbour + light smoothing.
 *
 * @param imageSrc   Data-URL or object-URL of the source sprite sheet.
 * @param bgR        Background red   component (0-255).
 * @param bgG        Background green component (0-255).
 * @param bgB        Background blue  component (0-255).
 * @param thresh     Colour-distance threshold for flood fill.
 * @param scale      Upscale factor, or `'auto'` to use the sheet's own scale.
 * @returns          Processed PNG as a data-URL, the analysed SheetInfo,
 *                   and the final scale factor that was applied.
 */
export async function buildTransparentPNG(
  imageSrc: string,
  bgR: number,
  bgG: number,
  bgB: number,
  thresh: number,
  scale: number | 'auto' = 'auto',
): Promise<{ dataURL: string; info: SheetInfo; finalScale: number }> {
  const img = await loadImageFromSrc(imageSrc);
  const w = img.naturalWidth;
  const h = img.naturalHeight;

  const info = analyzeSheet(w, h);

  // Draw source image to a canvas and grab its pixel data
  const srcCv = document.createElement('canvas');
  srcCv.width = w;
  srcCv.height = h;
  const sctx = srcCv.getContext('2d')!;
  sctx.drawImage(img, 0, 0);
  const id = sctx.getImageData(0, 0, w, h);
  const d = id.data;

  // ── Flood-fill from edges ──────────────────────────────────────
  function colorDist(pi: number): number {
    return Math.sqrt(
      (d[pi] - bgR) ** 2 + (d[pi + 1] - bgG) ** 2 + (d[pi + 2] - bgB) ** 2,
    );
  }

  const VISITED = new Uint8Array(w * h);
  const queue = new Int32Array(w * h * 2);
  let qHead = 0;
  let qTail = 0;

  function enqueue(x: number, y: number): void {
    const vi = y * w + x;
    if (VISITED[vi]) return;
    VISITED[vi] = 1;
    queue[qTail++] = x;
    queue[qTail++] = y;
  }

  // Seed with all border pixels
  for (let x = 0; x < w; x++) {
    enqueue(x, 0);
    enqueue(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    enqueue(0, y);
    enqueue(w - 1, y);
  }

  // BFS
  while (qHead < qTail) {
    const x = queue[qHead++];
    const y = queue[qHead++];
    const pi = (y * w + x) * 4;
    if (colorDist(pi) < thresh) {
      d[pi + 3] = 0; // make transparent
      if (x > 0) enqueue(x - 1, y);
      if (x < w - 1) enqueue(x + 1, y);
      if (y > 0) enqueue(x, y - 1);
      if (y < h - 1) enqueue(x, y + 1);
    }
  }

  // ── Edge extension (fringe removal) ────────────────────────────
  const EDGE_THRESH = thresh * 1.6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * 4;
      if (d[pi + 3] === 0) continue;
      const dist = colorDist(pi);
      if (dist < EDGE_THRESH) {
        const hasTranspNeighbor =
          (x > 0 && d[(y * w + x - 1) * 4 + 3] === 0) ||
          (x < w - 1 && d[(y * w + x + 1) * 4 + 3] === 0) ||
          (y > 0 && d[((y - 1) * w + x) * 4 + 3] === 0) ||
          (y < h - 1 && d[((y + 1) * w + x) * 4 + 3] === 0);
        if (hasTranspNeighbor) {
          d[pi + 3] = Math.round((dist / EDGE_THRESH) * 255);
        }
      }
    }
  }

  sctx.putImageData(id, 0, 0);

  // ── Upscale ────────────────────────────────────────────────────
  const finalScale = scale === 'auto' ? info.scale : scale;

  const dst = document.createElement('canvas');
  dst.width = w * finalScale;
  dst.height = h * finalScale;
  const dctx = dst.getContext('2d')!;
  dctx.imageSmoothingEnabled = false; // nearest-neighbour
  dctx.drawImage(srcCv, 0, 0, w * finalScale, h * finalScale);

  // For scale >= 2: add a light smoothing pass
  if (finalScale >= 2) {
    const smooth = document.createElement('canvas');
    smooth.width = dst.width;
    smooth.height = dst.height;
    const sctx2 = smooth.getContext('2d')!;
    sctx2.imageSmoothingEnabled = true;
    sctx2.imageSmoothingQuality = 'high';
    sctx2.drawImage(dst, 0, 0);

    // Blend smoothed version at low opacity over the crisp nearest-neighbour
    dctx.globalAlpha = 0.15;
    dctx.drawImage(smooth, 0, 0);
    dctx.globalAlpha = 1.0;
  }

  return { dataURL: dst.toDataURL('image/png'), info, finalScale };
}

/**
 * Sample the background colour of a sprite-sheet image by averaging its
 * four corner pixels.
 */
export async function sampleBgColor(
  imageSrc: string,
): Promise<{ r: number; g: number; b: number }> {
  const img = await loadImageFromSrc(imageSrc);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;

  const corners: [number, number][] = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  corners.forEach(([cx, cy]) => {
    const p = (cy * w + cx) * 4;
    r += d[p];
    g += d[p + 1];
    b += d[p + 2];
  });
  return { r: r / 4, g: g / 4, b: b / 4 };
}

/**
 * Heuristic skin-colour test.  Returns `true` when the given RGB values
 * look like human skin tones (used by direction detection).
 */
export function isSkin(r: number, g: number, b: number): boolean {
  return r > 140 && g > 90 && b < 170 && r > b + 20 && r > g - 30;
}

/**
 * Detect the facing direction of each sprite row by analysing skin-colour
 * distribution.  Returns one `DirDetectResult` per direction row (4 total)
 * with conflict resolution so every canonical direction appears exactly once.
 */
export function detectDirOrder(
  imgEl: HTMLImageElement,
  fw: number,
  fh: number,
  charCols: number,
  charRows: number,
): DirDetectResult[] {
  const w = imgEl.naturalWidth;
  const h = imgEl.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.drawImage(imgEl, 0, 0);
  const pxAll = ctx.getImageData(0, 0, w, h).data;

  function px(x: number, y: number): [number, number, number, number] {
    const i = (y * w + x) * 4;
    return [pxAll[i], pxAll[i + 1], pxAll[i + 2], pxAll[i + 3]];
  }

  // Background colour from top-left corner
  const [bgRv, bgGv, bgBv] = px(0, 0);
  function isBg(r: number, g: number, b: number): boolean {
    return Math.sqrt((r - bgRv) ** 2 + (g - bgGv) ** 2 + (b - bgBv) ** 2) < 30;
  }

  const scores: {
    skinTop: number;
    skinMid: number;
    skinL: number;
    skinR: number;
    nonBg: number;
    totalSkin: number;
  }[] = [];

  for (let dir = 0; dir < 4; dir++) {
    let skinTop = 0;
    let skinMid = 0;
    let skinL = 0;
    let skinR = 0;
    let nonBg = 0;

    for (let crIdx = 0; crIdx < charRows; crIdx++) {
      for (let ccIdx = 0; ccIdx < charCols; ccIdx++) {
        // Middle frame (frame index 1)
        const ox = ccIdx * fw * 3 + fw;
        const oy = (crIdx * 4 + dir) * fh;
        const mid = fh >> 1;

        for (let y = 0; y < fh; y++) {
          for (let x = 0; x < fw; x++) {
            const [r, g, b] = px(ox + x, oy + y);
            if (isBg(r, g, b)) continue;
            nonBg++;
            if (isSkin(r, g, b)) {
              if (y < mid) skinTop++;
              else skinMid++;
              if (x < fw / 3) skinL++;
              else if (x > (fw * 2) / 3) skinR++;
            }
          }
        }
      }
    }

    scores.push({
      skinTop,
      skinMid,
      skinL,
      skinR,
      nonBg,
      totalSkin: skinTop + skinMid,
    });
  }

  // Classify each row
  const results: (DirDetectResult & { i?: number })[] = scores.map((s, _i) => {
    const topRatio =
      s.totalSkin > 0 ? s.skinTop / s.totalSkin : 0;
    const sideRatio =
      s.totalSkin > 0 ? Math.abs(s.skinL - s.skinR) / s.totalSkin : 0;
    const leanLeft = s.skinR > s.skinL + 2; // more skin on R = facing left

    let dir: string;
    let confidence: number;

    if (s.totalSkin < 3) {
      // No face visible -> UP (back)
      dir = 'up';
      confidence = s.nonBg > 10 ? 0.75 : 0.4;
    } else if (sideRatio > 0.25) {
      // Asymmetric face -> side view
      dir = leanLeft ? 'left' : 'right';
      confidence = Math.min(0.9, sideRatio);
    } else {
      // Symmetric face visible
      dir = topRatio > 0.55 ? 'down' : 'down';
      confidence = topRatio;
    }
    return { dir, confidence, raw: s };
  });

  // ── Conflict resolution ────────────────────────────────────────
  // Greedily assign by confidence (highest first), ensuring each
  // canonical direction appears at most once.
  const assigned: (DirDetectResult | null)[] = new Array(4).fill(null);
  const used = new Set<string>();
  const sorted = results
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => b.confidence - a.confidence);

  for (const { dir, confidence, raw, i } of sorted) {
    if (!used.has(dir)) {
      assigned[i!] = { dir, confidence, raw };
      used.add(dir);
    }
  }

  // Fill remaining slots with unused directions
  const allDirs = ['down', 'left', 'right', 'up'];
  const unassigned = allDirs.filter(d => !used.has(d));
  let ui = 0;
  for (let i = 0; i < 4; i++) {
    if (!assigned[i]) {
      assigned[i] = { dir: unassigned[ui++], confidence: 0 };
    }
  }

  return assigned as DirDetectResult[];
}
