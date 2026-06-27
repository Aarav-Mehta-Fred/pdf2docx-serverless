/**
 * @fileoverview Core Heuristic Analysis Engine for PDF-to-DOCX Converter
 *
 * Merged and improved from both previous attempts ("AI attempt + Old Heuristics"
 * and "Heuristics Try 2"). Runs on the MAIN THREAD. Pure ES module with no
 * external dependencies and no DOM access.
 *
 * Key capabilities:
 *   - PDF.js operator list parsing (lines, rectangles, curves, images, colors)
 *   - Text style extraction (font, size, bold, italic, color, underline)
 *   - Recursive XY-Cut column / region detection
 *   - Reading order assembly
 *   - Header / footer detection
 *   - AI + heuristic bounding box merge
 *   - Picture → Chart / Icon reclassification
 *   - Page dimension + margin detection
 *   - Background element detection
 *
 * @module heuristics
 */

// ─────────────────────────────────────────────────────────────────────────────
// PDF.js Operator Codes (defined locally — DO NOT import pdf.js)
// ─────────────────────────────────────────────────────────────────────────────

/** @enum {number} */
const OPS = {
  // Graphics state
  save: 10, restore: 11, transform: 12,

  // Path construction
  moveTo: 13, lineTo: 14, rectangle: 15, curveTo: 16,
  closePath: 17,

  // Path painting
  stroke: 18, closeStroke: 19,
  fill: 20, eoFill: 21, fillStroke: 22, eoFillStroke: 23,
  endPath: 24,

  // Line state
  setLineWidth: 1, setLineCap: 2, setLineJoin: 3, setDash: 4,

  // Color
  setStrokeGray: 32, setFillGray: 33,
  setStrokeRGBColor: 34, setFillRGBColor: 35,
  setStrokeCMYKColor: 36, setFillCMYKColor: 37,

  // Text
  beginText: 9, endText: 40, setFont: 42, setTextMatrix: 43,
  showText: 44, showSpacedText: 45,

  // Images
  paintImageXObject: 85, paintJpegXObject: 86, paintImageMaskXObject: 87,

  // Bundled path (pdf.js v3+)
  constructPath: 91
};

// ─────────────────────────────────────────────────────────────────────────────
// Transform Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Multiply two 6-element affine transform matrices.
 * Result = m2 applied in the coordinate system of m1.
 *
 * @param {number[]} m1 - Outer (existing) transform [a,b,c,d,e,f]
 * @param {number[]} m2 - Inner (new) transform [a,b,c,d,e,f]
 * @returns {number[]} Combined transform
 */
function multiplyTransform(m1, m2) {
  return [
    m2[0] * m1[0] + m2[1] * m1[2],
    m2[0] * m1[1] + m2[1] * m1[3],
    m2[2] * m1[0] + m2[3] * m1[2],
    m2[2] * m1[1] + m2[3] * m1[3],
    m2[4] * m1[0] + m2[5] * m1[2] + m1[4],
    m2[4] * m1[1] + m2[5] * m1[3] + m1[5]
  ];
}

/**
 * Apply a 6-element affine transform to a point.
 *
 * @param {number} x
 * @param {number} y
 * @param {number[]} t - Transform [a,b,c,d,e,f]
 * @returns {{ x: number, y: number }}
 */
function applyTransform(x, y, t) {
  return {
    x: t[0] * x + t[2] * y + t[4],
    y: t[1] * x + t[3] * y + t[5]
  };
}

/**
 * Convert CMYK values (each 0-1) to RGB (each 0-1).
 *
 * @param {number} c @param {number} m @param {number} y @param {number} k
 * @returns {number[]} [r, g, b] each 0-1
 */
function cmykToRgb(c, m, y, k) {
  return [
    (1 - c) * (1 - k),
    (1 - m) * (1 - k),
    (1 - y) * (1 - k)
  ];
}

/**
 * Convert [r,g,b] (each 0-1) to a hex colour string like '000000'.
 *
 * @param {number[]} rgb
 * @returns {string}
 */
function rgbToHex(rgb) {
  if (!rgb || !Array.isArray(rgb) || rgb.length < 3) return '000000';
  return rgb.map(v => {
    const n = Math.max(0, Math.min(255, Math.round(v * 255)));
    return n.toString(16).padStart(2, '0');
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Operator List Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the PDF.js operator list to extract drawn lines, rectangles, images,
 * vector paths, and a mapping of Y-ranges to active fill colours (for
 * associating text colour with its draw context).
 *
 * @param {{ fnArray: Uint8Array, argsArray: any[][] }} ops - From page.getOperatorList()
 * @param {{ transform: number[], width: number, height: number }} viewport
 * @returns {{
 *   drawnLines: Array,
 *   rectangles: Array,
 *   images: Array,
 *   paths: Array,
 *   fillColorMap: Array<{ yMin: number, yMax: number, color: number[] }>
 * }}
 */
export function analyzeOperatorList(ops, viewport) {
  if (!ops || !ops.fnArray) {
    return { drawnLines: [], rectangles: [], images: [], paths: [], fillColorMap: [], textColors: [] };
  }

  const vt = viewport.transform || [1, 0, 0, -1, 0, viewport.height];

  const drawnLines = [];
  const rectangles = [];
  const images = [];
  const paths = [];
  const fillColorMap = [];
  const textColors = []; // Track text colors

  // Track the current CTM and path state
  let ctm = [...viewport.transform]; // Current transformation matrix
  const ctmStack = [];
  let lineWidth = 1;
  let strokeColor = [0, 0, 0];
  let fillColor = [0, 0, 0];

  // Current path accumulator
  let pathPoints = [];
  let pathMinX = Infinity, pathMinY = Infinity;
  let pathMaxX = -Infinity, pathMaxY = -Infinity;

  /** Add a point to the current path, updating bounding box. */
  function addPathPoint(px, py) {
    // PDF coords → viewport coords
    const p1 = applyTransform(px, py, ctm);
    pathPoints.push(p1);
    if (p1.x < pathMinX) pathMinX = p1.x;
    if (p1.x > pathMaxX) pathMaxX = p1.x;
    if (p1.y < pathMinY) pathMinY = p1.y;
    if (p1.y > pathMaxY) pathMaxY = p1.y;
  }

  /** Reset path accumulator. */
  function resetPath() {
    pathPoints = [];
    pathMinX = Infinity; pathMinY = Infinity;
    pathMaxX = -Infinity; pathMaxY = -Infinity;
  }

  /** Commit current path as a drawn element. */
  function commitPath(paintType) {
    if (pathMinX === Infinity || pathMaxX === -Infinity) { resetPath(); return; }

    const w = pathMaxX - pathMinX;
    const h = pathMaxY - pathMinY;

    // Skip tiny noise
    if (w < 1 && h < 1) { resetPath(); return; }

    // Check if this is a single line segment
    if (pathPoints.length === 2) {
      const [p0, p1] = pathPoints;
      const isH = Math.abs(p0.y - p1.y) < 2;
      const isV = Math.abs(p0.x - p1.x) < 2;
      drawnLines.push({
        start: { x: p0.x, y: p0.y },
        end: { x: p1.x, y: p1.y },
        lineWidth,
        color: paintType === 'stroke' ? [...strokeColor] : [...fillColor],
        isHorizontal: isH,
        isVertical: isV
      });
    }

    // Rectangles: 4 corners forming an axis-aligned box
    if (pathPoints.length >= 4) {
      const isRect = w > 2 && h > 2;
      if (isRect) {
        rectangles.push({
          x: pathMinX, y: pathMinY, width: w, height: h,
          fillColor: [...fillColor],
          strokeColor: [...strokeColor],
          lineWidth
        });
      }
    }

    // General paths (vector shapes)
    if (pathPoints.length > 2) {
      const pc = paintType === 'stroke' ? [...strokeColor] : [...fillColor];
      paths.push({
        points: pathPoints.map(p => ({ x: p.x, y: p.y })),
        type: paintType,
        color: pc,
        lineWidth
      });
    }

    // Record fill color at this Y range for text color mapping
    if (paintType !== 'stroke' && h > 5) {
      fillColorMap.push({
        yMin: pathMinY, yMax: pathMaxY,
        color: [...fillColor]
      });
    }

    resetPath();
  }

  /**
   * Process sub-operations inside a constructPath bundle (pdf.js v3+).
   * pathOps: array of op codes (13=moveTo,14=lineTo,15=rect,16=curveTo)
   * pathArgs: flat array of numeric arguments consumed sequentially.
   */
  function processConstructPath(pathOps, pathArgs) {
    let idx = 0;
    for (let j = 0; j < pathOps.length; j++) {
      const op = pathOps[j];
      switch (op) {
        case OPS.moveTo:
          addPathPoint(pathArgs[idx], pathArgs[idx + 1]);
          idx += 2;
          break;
        case OPS.lineTo:
          addPathPoint(pathArgs[idx], pathArgs[idx + 1]);
          idx += 2;
          break;
        case OPS.rectangle: {
          const rx = pathArgs[idx], ry = pathArgs[idx + 1];
          const rw = pathArgs[idx + 2], rh = pathArgs[idx + 3];
          addPathPoint(rx, ry);
          addPathPoint(rx + rw, ry);
          addPathPoint(rx + rw, ry + rh);
          addPathPoint(rx, ry + rh);
          idx += 4;
          break;
        }
        case OPS.curveTo:
          // Cubic bezier: add control points + endpoint for bbox
          addPathPoint(pathArgs[idx], pathArgs[idx + 1]);     // cp1
          addPathPoint(pathArgs[idx + 2], pathArgs[idx + 3]); // cp2
          addPathPoint(pathArgs[idx + 4], pathArgs[idx + 5]); // endpoint
          idx += 6;
          break;
        default:
          // curveTo2/curveTo3 use 4 args
          if (idx + 3 < pathArgs.length) {
            addPathPoint(pathArgs[idx + 2], pathArgs[idx + 3]);
            idx += 4;
          }
          break;
      }
    }
  }

  // Main loop
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] || [];

    switch (fn) {
      // --- Graphics state ---
      case OPS.save:
        ctmStack.push([...ctm]);
        break;
      case OPS.restore:
        if (ctmStack.length) ctm = ctmStack.pop();
        break;
      case OPS.transform:
        ctm = multiplyTransform(ctm, args);
        break;

      // --- Line state ---
      case OPS.setLineWidth:
        lineWidth = args[0];
        break;

      // --- Colour ---
      case OPS.setStrokeRGBColor:
        if (args[0] && args[0].length >= 3) strokeColor = [args[0][0], args[0][1], args[0][2]];
        else strokeColor = [args[0], args[1], args[2]];
        break;
      case OPS.setFillRGBColor:
        if (args[0] && args[0].length >= 3) fillColor = [args[0][0], args[0][1], args[0][2]];
        else fillColor = [args[0], args[1], args[2]];
        break;
      case OPS.setStrokeGray:
        strokeColor = [args[0], args[0], args[0]];
        break;
      case OPS.setFillGray:
        fillColor = [args[0], args[0], args[0]];
        break;
      case OPS.setStrokeCMYKColor:
        strokeColor = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      case OPS.setFillCMYKColor:
        fillColor = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;

      // --- Bundled path (pdf.js v3+) ---
      case OPS.constructPath:
        processConstructPath(args[0], args[1]);
        break;

      // --- Individual path ops (older pdf.js / fallback) ---
      case OPS.moveTo:
        addPathPoint(args[0], args[1]);
        break;
      case OPS.lineTo:
        addPathPoint(args[0], args[1]);
        break;
      case OPS.rectangle: {
        const rx = args[0], ry = args[1], rw = args[2], rh = args[3];
        addPathPoint(rx, ry);
        addPathPoint(rx + rw, ry);
        addPathPoint(rx + rw, ry + rh);
        addPathPoint(rx, ry + rh);
        break;
      }
      case OPS.curveTo:
        addPathPoint(args[0], args[1]);
        addPathPoint(args[2], args[3]);
        addPathPoint(args[4], args[5]);
        break;

      // --- Path painting ---
      case OPS.stroke:
      case OPS.closeStroke:
        commitPath('stroke');
        break;
      case OPS.fill:
      case OPS.eoFill:
        commitPath('fill');
        break;
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        commitPath('fillStroke');
        break;
      case OPS.endPath:
      case OPS.closePath:
        resetPath();
        break;

      case OPS.showText:
      case OPS.showSpacedText:
        textColors.push([...fillColor]);
        break;

      // --- Images ---
      case OPS.paintImageXObject:
      case OPS.paintJpegXObject: {
        // Images are drawn into the unit square [0,0]-[1,1] in user space.
        const tl = applyTransform(0, 0, ctm);
        const tr = applyTransform(1, 0, ctm);
        const bl = applyTransform(0, 1, ctm);
        const br = applyTransform(1, 1, ctm);

        const xs = [tl.x, tr.x, bl.x, br.x];
        const ys = [tl.y, tr.y, bl.y, br.y];
        const ix = Math.min(...xs), iy = Math.min(...ys);
        const iw = Math.max(...xs) - ix, ih = Math.max(...ys) - iy;

        if (iw > 2 && ih > 2) {
          images.push({
            name: args[0] || 'unknown',
            transform: [...ctm],
            x: ix, y: iy, width: iw, height: ih
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return { drawnLines, rectangles, images, paths, fillColorMap, textColors };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Style Extraction
// ─────────────────────────────────────────────────────────────────────────────

/** Common PDF font name → system font mapping */
const FONT_MAP = {
  'TimesNewRoman': 'Times New Roman',
  'Times': 'Times New Roman',
  'TimesNewRomanPS': 'Times New Roman',
  'TimesNewRomanPSMT': 'Times New Roman',
  'Helvetica': 'Arial',
  'HelveticaNeue': 'Helvetica Neue',
  'ArialMT': 'Arial',
  'Arial': 'Arial',
  'Courier': 'Courier New',
  'CourierNew': 'Courier New',
  'CourierNewPSMT': 'Courier New',
  'Symbol': 'Symbol',
  'ZapfDingbats': 'Wingdings',
  'Calibri': 'Calibri',
  'Cambria': 'Cambria',
  'Georgia': 'Georgia',
  'Verdana': 'Verdana',
  'Tahoma': 'Tahoma',
  'TrebuchetMS': 'Trebuchet MS',
  'CenturySchoolbook': 'Century Schoolbook',
  'Century': 'Century',
  'serif': 'Times New Roman',
  'sans-serif': 'Arial',
  'sans': 'Arial',
  'monospace': 'Courier New'
};

/**
 * Extract styling information from a PDF.js text item.
 *
 * @param {{ str: string, transform: number[], width: number, height: number, fontName: string }} item
 * @param {Array<{ yMin: number, yMax: number, color: number[] }>} [fillColorMap=[]]
 * @returns {{ fontFamily: string, fontSize: number, bold: boolean, italic: boolean, color: string, underline: boolean }}
 */
function extractColorFromCanvas(ctx, item, scale) {
  if (!ctx || !item.str.trim()) return null;
  try {
    const t = item.transform;
    const fontSize = Math.max(8, Math.abs(t[3]));
    // Bounding box in 1.0x coords
    const x = t[4];
    const y = t[5] - fontSize; // ty is baseline, top is roughly ty - fontSize
    const w = item.width || fontSize;
    const h = fontSize;

    const sx = Math.floor(x * scale);
    const sy = Math.floor(y * scale);
    const sw = Math.ceil(w * scale);
    const sh = Math.ceil(h * scale);
    
    if (sw <= 0 || sh <= 0) return null;
    
    const imgData = ctx.getImageData(sx, sy, sw, sh).data;
    let bestColor = null;
    let maxDarkness = 0;
    
    // Find the pixel that is furthest from white/transparent
    for (let i = 0; i < imgData.length; i += 4) {
      const r = imgData[i], g = imgData[i+1], b = imgData[i+2], a = imgData[i+3];
      if (a < 128) continue;
      const darkness = (255 - r) + (255 - g) + (255 - b);
      if (darkness > maxDarkness && darkness > 30) {
        maxDarkness = darkness;
        bestColor = [r, g, b];
      }
    }
    
    if (bestColor) {
      return bestColor.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0').toUpperCase()).join('');
    }
  } catch (e) {}
  return null;
}

export function extractStyles(item, fillColorMap = [], styles = {}, ctx = null, renderScale = 1.0, embeddedFonts = [], trueFontNames = {}) {
  const fontName = item.fontName || '';
  const t = item.transform || [1, 0, 0, 1, 0, 0];

  // --- Font size ---
  let fontSize = Math.abs(t[3]);
  if (fontSize < 1) fontSize = Math.abs(t[0]);
  if (fontSize < 1) fontSize = 12; // fallback

  // --- Font family ---
  const fontStyle = styles[fontName];
  // Prefer the actual PDF font name (fontStyle.name) over the browser CSS fallback string
  let rawFamily = fontStyle && fontStyle.name ? fontStyle.name : (fontStyle && fontStyle.fontFamily ? fontStyle.fontFamily : fontName);
  
  if (trueFontNames && trueFontNames[fontName]) {
    rawFamily = trueFontNames[fontName];
  }

  // Track if the CSS font family string explicitly requested a serif fallback
  const cssFamilyStr = fontStyle && fontStyle.fontFamily ? fontStyle.fontFamily.toLowerCase() : '';
  const isGenericSerif = cssFamilyStr.includes(', serif') || cssFamilyStr === 'serif' || cssFamilyStr.includes('times');
  
  // Base sanitized name without subset prefix (matching app.js extraction logic)
  let sanitizedFamily = rawFamily.includes('+') ? rawFamily.split('+')[1].trim() : rawFamily.trim();
  
  let family = sanitizedFamily;

  if (embeddedFonts && embeddedFonts.includes(rawFamily)) {
    // If the font is actively embedded, it was pushed under its raw prefixed name.
    family = rawFamily;
  } else if (embeddedFonts && embeddedFonts.includes(sanitizedFamily)) {
    // If the font was skipped (e.g., locally available or broken OS/2 table),
    // it was pushed under its clean name. Use the exact clean name so Word can find it!
    family = sanitizedFamily;
  } else {
    // Suffix-stripped family for standard system fonts fallback
    let baseFamily = sanitizedFamily
      .replace(/-(Bold|Italic|Regular|Light|Medium|SemiBold|BoldItalic|Black|Heavy|Thin|ExtraLight|ExtraBold|Condensed|Expanded).*/i, '')
      .replace(/,.*/, '')
      .trim();

    family = baseFamily;

    if (family.toLowerCase().includes('times') || family.toLowerCase().includes('century')) family = 'Times New Roman';
    else if (family.toLowerCase().includes('arial')) family = 'Arial';
    else if (family.toLowerCase().includes('helvetica')) family = 'Arial';
    else if (family.toLowerCase().includes('courier')) family = 'Courier New';
    
    family = FONT_MAP[family] || family;

    // Ultimate fallback for weird internal IDs (like g_d0_f1)
    if (!family || /^(g_d|f\d+|font)/i.test(family) || family.length < 3 || family === 'Unknown') {
      family = isGenericSerif ? 'Times New Roman' : 'Arial';
    }
    
    // DOCX defaults to serif (Calibri/Times) if it doesn't recognize a font. 
    if (!/^[a-zA-Z0-9\s-]+$/.test(family)) {
      family = isGenericSerif ? 'Times New Roman' : 'Arial';
    }
  }

  // --- Bold ---
  const fontWeight = fontStyle ? fontStyle.fontWeight : '';
  const originalFontName = rawFamily; // now accurately maps to true PDF font name
  const bold = /bold|black|heavy|semibold|demibold/i.test(originalFontName) || 
               (typeof fontWeight === 'number' && fontWeight >= 600) || 
               /bold/i.test(String(fontWeight));

  // --- Italic ---
  const fontStyleProp = fontStyle ? fontStyle.fontStyle : '';
  const italic = /italic|oblique|slant/i.test(originalFontName) || 
                 /italic|oblique/i.test(String(fontStyleProp)) || 
                 (t[2] !== 0 && t[1] === 0);

  // We always apply bold and italic flags to the TextRun. 
  // If Word fails to load the embedded subsetted font, it will fall back to a system font
  // and we want it to natively apply the italic/bold slant.
  let finalBold = bold;
  let finalItalic = italic;

  // --- Colour ---
  let color = '000000';
  
  const parseColor = (arr) => {
    if (!arr || !Array.isArray(arr) || arr.length < 3) return '000000';
    // If all values are <= 1, they are probably 0-1 scale floats instead of 0-255
    const needsScale = arr.every(v => v >= 0 && v <= 1) && arr.some(v => v > 0);
    const hex = arr.slice(0, 3).map(c => {
      let val = parseFloat(c);
      if (isNaN(val)) return '00';
      if (needsScale) val *= 255;
      return Math.max(0, Math.min(255, Math.round(val))).toString(16).padStart(2, '0').toUpperCase();
    }).join('');
    return hex.length === 6 ? hex : '000000';
  };

  if (ctx) {
    const canvasColor = extractColorFromCanvas(ctx, item, renderScale);
    if (canvasColor) {
      color = canvasColor;
    }
  }

  // Fallback to item colors if canvas color wasn't found
  if (color === '000000') {
    if (item.color && Array.isArray(item.color) && item.color.length === 3) {
      color = parseColor(item.color);
    } else if (item.opColor && Array.isArray(item.opColor) && item.opColor.length === 3) {
      color = parseColor(item.opColor);
    } else if (item.fillColor) {
      color = parseColor(item.fillColor);
    }
  }

  return {
    fontFamily: family,
    fontSize: fontSize,
    bold: finalBold,
    italic: finalItalic,
    color,
    underline: false // detected separately via detectUnderlines()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Page Dimensions
// ─────────────────────────────────────────────────────────────────────────────

/** Standard page sizes in PDF points (72pt = 1 inch) */
const PAGE_SIZES = {
  'Letter':  { w: 612,    h: 792 },
  'A4':      { w: 595.28, h: 841.89 },
  'Legal':   { w: 612,    h: 1008 },
  'A3':      { w: 841.89, h: 1190.55 },
  'A5':      { w: 419.53, h: 595.28 },
  'Tabloid': { w: 792,    h: 1224 }
};

/**
 * Determine page dimensions and detect standard page size.
 *
 * @param {number[]} pageView - The page.view array [x0, y0, x1, y1]
 * @returns {{ width: number, height: number, size: string, widthInches: number, heightInches: number, orientation: string }}
 */
export function extractPageDimensions(pageView) {
  if (!pageView || pageView.length < 4) {
    return { width: 612, height: 792, size: 'Letter', widthInches: 8.5, heightInches: 11, orientation: 'portrait' };
  }
  let width = pageView[2] - pageView[0];
  let height = pageView[3] - pageView[1];

  let detectedSize = 'Custom';
  const tolerance = 5;

  for (const [name, sz] of Object.entries(PAGE_SIZES)) {
    // Portrait
    if (Math.abs(width - sz.w) < tolerance && Math.abs(height - sz.h) < tolerance) {
      detectedSize = name;
      width = sz.w;
      height = sz.h;
      break;
    }
    // Landscape
    if (Math.abs(width - sz.h) < tolerance && Math.abs(height - sz.w) < tolerance) {
      detectedSize = name + ' Landscape';
      width = sz.h;
      height = sz.w;
      break;
    }
  }

  return {
    width,
    height,
    size: detectedSize,
    widthInches: width / 72,
    heightInches: height / 72,
    orientation: width > height ? 'landscape' : 'portrait'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Margin Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect page margins from the bounding box of outermost text elements.
 *
 * @param {Array<{ transform: number[], width: number }>} items
 * @param {number} pageWidth  - In PDF points
 * @param {number} pageHeight - In PDF points
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function detectMargins(items, pageWidth, pageHeight) {
  const validItems = (items || []).filter(it => it.str && it.str.trim().length > 0);
  if (!validItems.length) {
    return { top: 72, right: 72, bottom: 72, left: 72 };
  }

  const lefts = [];
  const rights = [];
  let minY = Infinity, maxY = -Infinity;

  for (const item of validItems) {
    const t = item.transform;
    if (!t) continue;
    const x = t[4];
    const y = t[5];
    const w = item.width || 0;
    const h = Math.abs(t[3]) || 0;

    lefts.push(x);
    rights.push(x + w);
    minY = Math.min(minY, y - h);
    maxY = Math.max(maxY, y);
  }

  if (!lefts.length) {
    return { top: 72, right: 72, bottom: 72, left: 72 };
  }

  const minX = Math.min(...lefts);
  const maxX = Math.max(...rights);

  return {
    top: Math.max(0, minY),
    right: Math.max(0, pageWidth - maxX),
    bottom: Math.max(0, pageHeight - maxY),
    left: Math.max(0, minX)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Header / Footer Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect headers and footers using AI bounding boxes.
 *
 * @param {Array} items
 * @param {Array} aiBoxes
 * @returns {{ headers: Array, footers: Array, body: Array }}
 */
export function detectHeaderFooter(items, aiBoxes, pageWidth) {
  const headers = [];
  const footers = [];
  const body = [];
  const assigned = new Set();
  
  let headerBottomY = 0;
  let footerTopY = Infinity;

  if (aiBoxes && aiBoxes.length > 0) {
    const headerLabels = ['header', 'header_image'];
    const footerLabels = ['footer', 'footer_image', 'number'];

    for (const box of aiBoxes) {
      const isHeader = headerLabels.includes(box.label);
      const isFooter = footerLabels.includes(box.label);
      
      if (!isHeader && !isFooter) continue;
      
      if (isHeader) headerBottomY = Math.max(headerBottomY, box.y1);
      if (isFooter) footerTopY = Math.min(footerTopY, box.y0);
      
      const boxItems = items.filter(item => {
        const t = item.transform;
        const x = t[4];
        const y = t[5] - Math.abs(t[3]);
        const w = item.width || Math.abs(t[3]);
        const h = Math.abs(t[3]);
        
        const cx = x + w / 2;
        const cy = y + h / 2;
        
        return cx >= (box.x0 - 50) && cx <= (box.x1 + 50) && cy >= box.y0 && cy <= box.y1;
      });
      
      boxItems.forEach(i => assigned.add(i));
      if (boxItems.length > 0) {
        const lines = groupIntoLines(boxItems);
        const paras = groupIntoParagraphs(lines, 2.5, pageWidth);
        paras.forEach(p => p.label = box.label);
        if (isHeader) headers.push(...paras);
        else footers.push(...paras);
      }
    }
  }

  for (const item of items) {
    if (!assigned.has(item)) body.push(item);
  }

  return { headers, footers, body, headerBottomY, footerTopY };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Text Grouping — Lines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group text items that share the same baseline into lines.
 *
 * @param {Array} items - Text items with .transform
 * @param {number} [yTolerance=3] - Max Y-difference to consider same line
 * @returns {Array<{ items: Array, y: number }>}
 */
export function groupIntoLines(items) {
  if (!items || !items.length) return [];

  const sorted = [...items].sort((a, b) => {
    const yDiff = a.transform[5] - b.transform[5];
    if (Math.abs(yDiff) < 1.0) {
      return a.transform[4] - b.transform[4];
    }
    return yDiff;
  });

  const lines = [];
  let currentLine = { items: [sorted[0]], y: sorted[0].transform[5] };

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const fontSize = Math.abs(item.transform[3]) || 12;
    let dynamicTolerance = Math.max(3, Math.min(10, fontSize * 0.4));
    
    // Widen tolerance for small decorative characters (bullets, dots, icons)
    // These often have slightly different baselines in PDFs
    const str = (item.str || '').trim();
    if (str.length <= 2 && /^[◦•●○◉◎▪▫■□★☆♦♠♣♥\-–—\*·˙\u2022\u25CF\u25CB\u25A0\u25A1\u2605\u2606]+$/.test(str)) {
      dynamicTolerance = Math.max(dynamicTolerance, fontSize * 0.65);
    }
    
    if (Math.abs(item.transform[5] - currentLine.y) <= dynamicTolerance) {
      currentLine.items.push(item);
    } else {
      currentLine.items.sort((a, b) => a.transform[4] - b.transform[4]);
      lines.push(currentLine);
      currentLine = { items: [item], y: item.transform[5] };
    }
  }
  currentLine.items.sort((a, b) => a.transform[4] - b.transform[4]);
  lines.push(currentLine);

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Text Grouping — Paragraphs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get average font size of a line.
 * @param {{ items: Array }} line
 * @returns {number}
 */
function getLineFontSize(line) {
  if (!line.items || !line.items.length) return 12;
  const sizes = line.items.map(it => Math.abs(it.transform[3]) || 12);
  return sizes.reduce((a, b) => a + b, 0) / sizes.length;
}

/**
 * Detect alignment of a line relative to page width.
 * @param {{ items: Array }} line
 * @param {number} [pageWidth=612]
 * @returns {'left'|'center'|'right'}
 */
export function getLineAlignment(line, pageWidth = 612, margins = {left: 72, right: 72}) {
  if (!line.items || !line.items.length) return 'left';
  const firstX = line.items[0].transform[4];
  const lastItem = line.items[line.items.length - 1];
  const lastX = lastItem.transform[4] + (lastItem.width || 0);
  
  const textWidth = Math.max(10, pageWidth - margins.left - margins.right);
  const leftSpace = firstX - margins.left;
  const rightSpace = (pageWidth - margins.right) - lastX;

  // A full line is almost as wide as the text area
  if (leftSpace < textWidth * 0.05 && rightSpace < textWidth * 0.05) return 'left';

  if (Math.abs(leftSpace - rightSpace) < textWidth * 0.05 && leftSpace > textWidth * 0.1) return 'center';
  if (rightSpace < textWidth * 0.15 && leftSpace > textWidth * 0.25) return 'right';
  return 'left';
}

function detectParagraphAlignment(lines, pageWidth, margins = {left: 72, right: 72}) {
  if (lines.length === 1) return getLineAlignment(lines[0], pageWidth, margins);
  
  let lefts = [];
  let rights = [];
  for (const line of lines) {
    if (!line.items || !line.items.length) continue;
    
    // Find first non-whitespace item for left edge
    let firstItem = line.items[0];
    for (let j = 0; j < line.items.length; j++) {
      if (line.items[j].str && line.items[j].str.trim().length > 0) {
        firstItem = line.items[j];
        break;
      }
    }
    lefts.push(firstItem.transform[4]);
    
    // Find last non-whitespace item for right edge
    let lastItem = line.items[line.items.length - 1];
    for (let j = line.items.length - 1; j >= 0; j--) {
      if (line.items[j].str && line.items[j].str.trim().length > 0) {
        lastItem = line.items[j];
        break;
      }
    }
    rights.push(lastItem.transform[4] + (lastItem.width || 0));
  }
  
  if (lefts.length < 2) return getLineAlignment(lines[0], pageWidth, margins);
  
  const maxLeft = Math.max(...lefts);
  const minLeft = Math.min(...lefts);
  const leftVariance = maxLeft - minLeft;
  
  const maxRight = Math.max(...rights);
  
  // If the left edge is perfectly straight (variance < 25) and it's a wide paragraph,
  // it's almost certainly body text that should be justified to match PDF flow.
  if (leftVariance < 25 && rights.length > 1 && maxRight > pageWidth * 0.65) {
     return 'justify';
  }
  
  return getLineAlignment(lines[0], pageWidth, margins);
}

/**
 * Group lines into paragraphs based on spacing, font changes, and alignment.
 *
 * @param {Array<{ items: Array, y: number }>} lines
 * @param {number} [spacingThreshold=1.5] - Line-spacing multiplier to detect paragraph break
 * @param {number} [pageWidth=612]
 * @returns {Array<{ lines: Array, alignment: string }>}
 */
function buildColumnBlock(lines, spacingThreshold, pageWidth, margins) {
  const colDefs = detectColumnsFromLines(lines, pageWidth);
  
  if (colDefs.length <= 1) {
    return groupIntoParagraphs(lines, spacingThreshold, pageWidth, margins);
  }

  const columns = colDefs.map(c => ({
    box: c,
    items: []
  }));

  for (const line of lines) {
    for (const item of line.items) {
      const xCenter = item.transform[4] + (item.width || 0) / 2;
      let found = false;
      for (const col of columns) {
        if (xCenter >= col.box.x0 && xCenter <= col.box.x1) {
          col.items.push(item);
          found = true;
          break;
        }
      }
      if (!found) {
        let closest = columns[0];
        let minDist = Infinity;
        for (const col of columns) {
          const dist = Math.min(Math.abs(xCenter - col.box.x0), Math.abs(xCenter - col.box.x1));
          if (dist < minDist) { minDist = dist; closest = col; }
        }
        closest.items.push(item);
      }
    }
  }

  const columnData = columns.map(col => {
    const colLines = groupIntoLines(col.items);
    const paras = groupIntoParagraphs(colLines, spacingThreshold, pageWidth, margins);
    return {
      width: col.box.x1 - col.box.x0,
      paragraphs: paras
    };
  });

  // Validate: each column needs meaningful content (at least 2 paragraphs)
  // Otherwise fall back to regular paragraph grouping with tab stops
  const hasEnoughContent = columnData.every(c => c.paragraphs.length >= 2);
  if (!hasEnoughContent) {
    return groupIntoParagraphs(lines, spacingThreshold, pageWidth, margins);
  }

  return [{
    type: 'column_block',
    columns: columnData,
    count: columnData.length
  }];
}

export function groupIntoBlocks(lines, spacingThreshold = 2.5, pageWidth = 612, margins = {left: 72, right: 72}) {
  if (!lines || !lines.length) return [];

  const blocks = [];
  let currentNormalLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    let hasHugeGap = false;
    if (line.items && line.items.length > 1) {
      const avgFS = getLineFontSize(line);
      for (let j = 1; j < line.items.length; j++) {
        const itemPrev = line.items[j - 1];
        const itemCurr = line.items[j];
        const gap = itemCurr.transform[4] - (itemPrev.transform[4] + (itemPrev.width || 0));
        if (gap > avgFS * 3) {
          hasHugeGap = true;
          break;
        }
      }
    }

    if (hasHugeGap) {
      if (currentNormalLines.length > 0) {
        blocks.push(...groupIntoParagraphs(currentNormalLines, spacingThreshold, pageWidth, margins));
        currentNormalLines = [];
      }
      
      const columnLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        const nextFS = getLineFontSize(nextLine);
        let nextHasHugeGap = false;
        if (nextLine.items && nextLine.items.length > 1) {
          for (let k = 1; k < nextLine.items.length; k++) {
            const itemPrev = nextLine.items[k - 1];
            const itemCurr = nextLine.items[k];
            const gap = itemCurr.transform[4] - (itemPrev.transform[4] + (itemPrev.width || 0));
            if (gap > nextFS * 3) {
              nextHasHugeGap = true;
              break;
            }
          }
        }
        
        const prevLineInCol = lines[j-1];
        const prevFS = getLineFontSize(prevLineInCol);
        const spacing = Math.abs(nextLine.y - prevLineInCol.y);
        if (spacing > ((prevFS + nextFS) / 2) * spacingThreshold * 1.5) {
           break; 
        }
        
        if (nextHasHugeGap) {
          columnLines.push(nextLine);
          j++;
        } else {
          break;
        }
      }
      
      // Only attempt column block if we have enough consecutive huge-gap lines.
      // Isolated label-content lines (< 3) should be treated as normal paragraphs
      // and will use tab stops in the DOCX builder instead.
      if (columnLines.length >= 3) {
        blocks.push(...buildColumnBlock(columnLines, spacingThreshold, pageWidth, margins));
      } else {
        // Fall back to normal paragraph grouping for these lines
        currentNormalLines.push(...columnLines);
      }
      i = j - 1; 
    } else {
      // Single line with huge gap or too few consecutive lines — 
      // treat as regular paragraphs (will use tab stops instead of columns)
      currentNormalLines.push(line);
    }
  }

  if (currentNormalLines.length > 0) {
    blocks.push(...groupIntoParagraphs(currentNormalLines, spacingThreshold, pageWidth, margins));
  }

  return blocks;
}

export function groupIntoParagraphs(lines, spacingThreshold = 2.0, pageWidth = 612, margins = {left: 72, right: 72}) {
  if (!lines || !lines.length) return [];

  const paragraphs = [];
  let current = { lines: [lines[0]], alignment: getLineAlignment(lines[0], pageWidth, margins) };

  const lineHasHugeGap = (line) => {
    if (!line.items || line.items.length < 2) return false;
    const fs = getLineFontSize(line);
    for (let i = 1; i < line.items.length; i++) {
      const prev = line.items[i - 1];
      const curr = line.items[i];
      const gap = curr.transform[4] - (prev.transform[4] + (prev.width || 0));
      if (gap > fs * 3) return true;
    }
    return false;
  };

  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const curr = lines[i];

    const prevFS = getLineFontSize(prev);
    const currFS = getLineFontSize(curr);
    const spacing = Math.abs(curr.y - prev.y);
    const avgFS = (prevFS + currFS) / 2;

    const prevAlign = getLineAlignment(prev, pageWidth, margins);
    const currAlign = getLineAlignment(curr, pageWidth, margins);
    let alignDiff = prevAlign !== currAlign;
    if (prevAlign === 'justify' && currAlign === 'left') {
      alignDiff = false;
    }

    const prevHasGap = lineHasHugeGap(prev);
    const currHasGap = lineHasHugeGap(curr);

    const textWidth = Math.max(10, pageWidth - margins.left - margins.right);
    const prevFirstItem = prev.items[0];
    const prevLastItem = prev.items[prev.items.length - 1];
    const prevLeftSpace = prevFirstItem.transform[4] - margins.left;
    const prevRightSpace = (pageWidth - margins.right) - (prevLastItem.transform[4] + (prevLastItem.width || 0));
    const isPrevShort = prevAlign === 'left' && prevRightSpace > textWidth * 0.4;
    
    const isPrevCenterShort = prevAlign === 'center' && prevRightSpace > textWidth * 0.15;
    const isCenterOrRight = isPrevCenterShort || prevAlign === 'right';

    const currFirstStr = curr.items && curr.items.length > 0 ? curr.items[0].str.trim() : '';
    const isCurrBullet = /^(•|-|–|—|\*|\d+\.)/.test(currFirstStr);
    const isCurrTip = currFirstStr.startsWith('(Tip:');

    const isNewPara =
      spacing > avgFS * spacingThreshold ||
      Math.abs(prevFS - currFS) > 2 ||
      alignDiff ||
      prevHasGap ||
      currHasGap ||
      isPrevShort ||
      isCenterOrRight ||
      isCurrBullet ||
      isCurrTip;

    if (isNewPara) {
      current.alignment = detectParagraphAlignment(current.lines, pageWidth, margins);
      paragraphs.push(current);
      current = { lines: [curr], alignment: getLineAlignment(curr, pageWidth, margins) };
    } else {
      current.lines.push(curr);
    }
  }
  current.alignment = detectParagraphAlignment(current.lines, pageWidth, margins);
  paragraphs.push(current);

  return paragraphs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. XY-Cut Region Detection
// ─────────────────────────────────────────────────────────────────────────────

// XY-Cut and legacy assembleReadingOrder removed in favor of native ppu-doclayout reading order.

// ─────────────────────────────────────────────────────────────────────────────
// 10. AI + Heuristic Merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate overlap ratio of box a covered by box b.
 * @param {{ x0:number, y0:number, x1:number, y1:number }} a
 * @param {{ x0:number, y0:number, x1:number, y1:number }} b
 * @returns {number} 0-1
 */
function overlapRatio(a, b) {
  const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
  if (ix0 >= ix1 || iy0 >= iy1) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  const aArea = (a.x1 - a.x0) * (a.y1 - a.y0);
  return aArea > 0 ? inter / aArea : 0;
}

/**
 * Check if a point falls inside a bounding box.
 * @param {{ x:number, y:number }} pt
 * @param {{ x0:number, y0:number, x1:number, y1:number }} bbox
 * @returns {boolean}
 */
function pointInBBox(pt, bbox) {
  return pt.x >= bbox.x0 && pt.x <= bbox.x1 && pt.y >= bbox.y0 && pt.y <= bbox.y1;
}

/**
 * Merge AI-detected bounding boxes with heuristic-detected objects.
 *
 * @param {Array} aiBoxes - From layout-worker.js { x0,y0,x1,y1,confidence,classId,label }
 * @param {{ drawnLines: Array, rectangles: Array, images: Array, paths: Array }} heuristicData
 * @param {{ width: number, height: number }} viewport
 * @returns {Array} Merged array with `source` field
 */
export function mergeResults(aiBoxes, heuristicData, viewport) {
  const merged = [];

  // 1. Add AI boxes (reclassify pictures)
  for (const box of aiBoxes) {
    let label = box.label;
    if (label === 'image') {
      label = reclassifyPicture(
        box, heuristicData.drawnLines || [], heuristicData.paths || []
      );
    }
    merged.push({ ...box, label, source: 'ai' });
  }

  // 2. Add heuristic images not covered by AI boxes
  for (const img of (heuristicData.images || [])) {
    const imgBox = { x0: img.x, y0: img.y, x1: img.x + img.width, y1: img.y + img.height };
    const covered = merged.some(m => overlapRatio(imgBox, m) > 0.5);
    if (!covered) {
      merged.push({
        ...imgBox,
        label: 'image', confidence: 1.0,
        source: 'heuristic', imageName: img.name
      });
    }
  }

  // 3. Add significant drawn lines not covered
  for (const line of (heuristicData.drawnLines || [])) {
    const lineBox = {
      x0: Math.min(line.start.x, line.end.x),
      y0: Math.min(line.start.y, line.end.y),
      x1: Math.max(line.start.x, line.end.x),
      y1: Math.max(line.start.y, line.end.y)
    };
    const covered = merged.some(m => pointInBBox(line.start, m) && pointInBBox(line.end, m));
    if (!covered) {
      merged.push({
        ...lineBox, label: 'Line', confidence: 1.0,
        source: 'heuristic', lineData: line
      });
    }
  }

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. Picture Reclassification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a "Picture" region should be reclassified as Chart, Graph, or Icon.
 *
 * @param {{ x0:number, y0:number, x1:number, y1:number }} bbox
 * @param {Array} drawnLines
 * @param {Array} paths
 * @returns {'Picture'|'Chart'|'Icon'}
 */
export function reclassifyPicture(bbox, drawnLines, paths) {
  if (!drawnLines) drawnLines = [];
  if (!paths) paths = [];

  const linesInBox = drawnLines.filter(l =>
    pointInBBox(l.start, bbox) && pointInBBox(l.end, bbox)
  );

  const hLines = linesInBox.filter(l => l.isHorizontal);
  const vLines = linesInBox.filter(l => l.isVertical);

  // Grid pattern: ≥3 horizontal AND ≥3 vertical
  if (hLines.length >= 3 && vLines.length >= 3) return 'chart';

  // Axis pattern: L-shaped at bottom-left
  const bboxH = bbox.y1 - bbox.y0;
  const bboxW = bbox.x1 - bbox.x0;
  const bottomH = hLines.filter(l =>
    Math.abs(l.start.y - bbox.y1) < bboxH * 0.15 ||
    Math.abs(l.end.y - bbox.y1) < bboxH * 0.15
  );
  const leftV = vLines.filter(l =>
    Math.abs(l.start.x - bbox.x0) < bboxW * 0.15 ||
    Math.abs(l.end.x - bbox.x0) < bboxW * 0.15
  );
  if (bottomH.length > 0 && leftV.length > 0) return 'chart';

  // Regular spacing: evenly-spaced lines
  function hasRegularSpacing(arr) {
    if (arr.length < 3) return false;
    const positions = arr.map(l => l.isHorizontal ? l.start.y : l.start.x).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return avg > 1 && gaps.every(g => Math.abs(g - avg) < avg * 0.2);
  }
  if (hasRegularSpacing(hLines) || hasRegularSpacing(vLines)) return 'chart';

  // Icon: small number of short paths
  const pathsInBox = paths.filter(p => p.points.some(pt => pointInBBox(pt, bbox)));
  if (pathsInBox.length >= 5 && pathsInBox.length < 50) {
    const avgPts = pathsInBox.reduce((s, p) => s + p.points.length, 0) / pathsInBox.length;
    if (avgPts < 6) return 'icon';
  }

  return 'image';
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. Background Element Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect rectangles that span the full page (backgrounds).
 *
 * @param {Array} rectangles - From analyzeOperatorList
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @returns {Array<{ type: 'color', color: number[], rect: object }>}
 */
export function detectBackgroundElements(rectangles, pageWidth, pageHeight) {
  if (!rectangles || !rectangles.length) return [];

  return rectangles
    .filter(r => r.width > pageWidth * 0.9 && r.height > pageHeight * 0.9)
    .map(r => ({
      type: 'color',
      color: r.fillColor,
      rect: r
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. Underline Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect text items that have thin horizontal lines immediately below them
 * (underlines). Returns a Set of item indices.
 *
 * @param {Array} drawnLines - Horizontal drawn lines
 * @param {Array} textItems  - Text items with .transform
 * @returns {Set<number>} Indices of underlined text items
 */
export function detectUnderlines(drawnLines, textItems) {
  const underlinedIndices = new Set();
  if (!drawnLines || !textItems) return underlinedIndices;

  const hLines = drawnLines.filter(l => l.isHorizontal && l.lineWidth < 3);

  for (let i = 0; i < textItems.length; i++) {
    const item = textItems[i];
    const t = item.transform;
    if (!t) continue;
    const baseline = t[5];
    const xStart = t[4];
    const xEnd = t[4] + (item.width || 0);

    for (const line of hLines) {
      const lineY = line.start.y;
      // Underline should be within 3px below the baseline
      if (lineY > baseline && lineY - baseline < 4) {
        // And overlap horizontally with the text
        const lx0 = Math.min(line.start.x, line.end.x);
        const lx1 = Math.max(line.start.x, line.end.x);
        if (lx0 <= xEnd && lx1 >= xStart) {
          underlinedIndices.add(i);
          break;
        }
      }
    }
  }

  return underlinedIndices;
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. Column Detection (binned histogram fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect column boundaries using a binned x-histogram of text positions.
 *
 * @param {Array<{ items: Array }>} lines - Grouped lines
 * @param {number} pageWidth
 * @returns {Array<{ x0: number, x1: number }>}
 */
function detectColumnsFromLines(lines, pageWidth) {
  if (!lines || lines.length < 3) return [{ x0: 0, x1: pageWidth }];

  const binSize = 5;
  const numBins = Math.ceil(pageWidth / binSize);
  const bins = new Uint16Array(numBins);

  for (const line of lines) {
    for (const item of line.items) {
      const x0 = Math.max(0, Math.floor(item.transform[4] / binSize));
      const x1 = Math.min(numBins - 1, Math.ceil((item.transform[4] + (item.width || 0)) / binSize));
      for (let b = x0; b <= x1; b++) bins[b]++;
    }
  }

  const maxVal = Math.max(...bins);
  const threshold = maxVal * 0.1;

  const gaps = [];
  let gapStart = -1;
  for (let b = 0; b < numBins; b++) {
    if (bins[b] < threshold) {
      if (gapStart === -1) gapStart = b;
    } else {
      if (gapStart !== -1) {
        const gapWidth = (b - gapStart) * binSize;
        if (gapWidth > pageWidth * 0.05) {
          gaps.push({
            start: gapStart * binSize,
            end: b * binSize,
            center: ((gapStart + b) / 2) * binSize,
            width: gapWidth
          });
        }
        gapStart = -1;
      }
    }
  }

  if (gaps.length === 0) return [{ x0: 0, x1: pageWidth }];

  // Validate each gap: require that a significant number of lines have content
  // on BOTH sides of the gap. This filters out label-content layouts where
  // only a few lines have items spanning the gap.
  const validGaps = gaps.filter(gap => {
    let bothSides = 0;
    for (const line of lines) {
      let hasLeft = false, hasRight = false;
      for (const item of line.items) {
        const itemRight = item.transform[4] + (item.width || 0);
        if (itemRight < gap.start + gap.width * 0.3) hasLeft = true;
        if (item.transform[4] > gap.end - gap.width * 0.3) hasRight = true;
      }
      if (hasLeft && hasRight) bothSides++;
    }
    // At least 30% of lines must have content on both sides, and at least 3 lines
    return bothSides >= 3 && bothSides >= lines.length * 0.3;
  });

  if (validGaps.length === 0) return [{ x0: 0, x1: pageWidth }];

  const columns = [];
  let colStart = 0;
  for (const gap of validGaps) {
    columns.push({ x0: colStart, x1: gap.center });
    colStart = gap.center;
  }
  columns.push({ x0: colStart, x1: pageWidth });

  return columns;
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. Full Heuristic Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the complete heuristic analysis pipeline on a single PDF page.
 *
 * @param {{ items: Array }} textContent - From page.getTextContent()
 * @param {{ fnArray: Uint8Array, argsArray: any[][] }} ops - From page.getOperatorList()
 * @param {{ transform: number[], width: number, height: number }} viewport
 * @param {Array} [aiBoxes=[]] - AI layout boxes from layout-worker.js
 * @returns {{
 *   headers: Array, footers: Array, body: Array,
 *   paragraphs: Array, drawnLines: Array, rectangles: Array,
 *   images: Array, paths: Array, columns: Array,
 *   margins: object, mergedBoxes: Array, backgroundElements: Array
 * }}
 */
export function runFullHeuristicPipeline(textContent, ops, viewport, aiBoxes = [], canvas = null, renderScale = 1.0) {
  const styles = textContent?.styles || {};
  const ctx = canvas ? canvas.getContext('2d') : null;
  
  // 2. Analyze operator list first to get textColors
  const opAnalysis = analyzeOperatorList(ops, viewport);
  let tcIdx = 0;

  // 1. Filter empty text items and normalize to top-left viewport coordinates
  const items = (textContent?.items || []).map(it => {
    const opColor = opAnalysis.textColors && opAnalysis.textColors[tcIdx] ? opAnalysis.textColors[tcIdx] : [0,0,0];
    tcIdx++;
    return { ...it, opColor };
  }).filter(it => it.str && it.str.trim()).map(it => {
    const t = it.transform;
    const tx = viewport.transform[0] * t[4] + viewport.transform[2] * t[5] + viewport.transform[4];
    const ty = viewport.transform[1] * t[4] + viewport.transform[3] * t[5] + viewport.transform[5];
    return {
      ...it,
      transform: [t[0], t[1], t[2], t[3], tx, ty]
    };
  });

  // Page dims from viewport
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  // 3. Detect background elements
  const backgroundElements = detectBackgroundElements(opAnalysis.rectangles, pageWidth, pageHeight);

  // Extract link annotations
  const linkAnnotations = (textContent?.annotations || [])
    .filter(a => a.subtype === 'Link' && a.url)
    .map(a => {
      const p0 = applyTransform(a.rect[0], a.rect[1], viewport.transform);
      const p1 = applyTransform(a.rect[2], a.rect[3], viewport.transform);
      return {
        url: a.url,
        x0: Math.min(p0.x, p1.x),
        x1: Math.max(p0.x, p1.x),
        y0: Math.min(p0.y, p1.y),
        y1: Math.max(p0.y, p1.y)
      };
    });

  // 3.5. Extract styles for all items upfront
  const fcm = opAnalysis.fillColorMap;
  const embeddedFonts = textContent.embeddedFonts || [];
  const trueFontNames = textContent.trueFontNames || {};
  const styledItems = items.map(item => {
    const sItem = { 
      ...item, 
      style: extractStyles(item, fcm, styles, ctx, renderScale, embeddedFonts, trueFontNames) 
    };
    
    // Check intersection with links
    const t = sItem.transform;
    const cx = t[4] + (sItem.width || Math.abs(t[3])) / 2;
    const cy = t[5] - Math.abs(t[3]) / 2;
    for (const link of linkAnnotations) {
      if (cx >= link.x0 && cx <= link.x1 && cy >= link.y0 && cy <= link.y1) {
        sItem.style.url = link.url;
        break;
      }
    }
    return sItem;
  });

  // 4. Detect header / footer using AI boxes
  const { headers, footers, body: bodyItems, headerBottomY, footerTopY } = detectHeaderFooter(styledItems, aiBoxes, pageWidth);

  // 4.5. Detect margins using body items only
  const margins = detectMargins(bodyItems, pageWidth, pageHeight);

  // 5. Merge with AI results
  const mergedBoxes = aiBoxes.length > 0
    ? mergeResults(aiBoxes, opAnalysis, viewport)
    : [];

  // 6. Assemble paragraphs using AI boxes in reading order
  const underlinedSet = detectUnderlines(opAnalysis.drawnLines, bodyItems);
  
  // Apply underlines
  const styledBody = bodyItems.map((item, idx) => {
    if (underlinedSet.has(idx)) item.style.underline = true;
    return item;
  });

  const paragraphs = [];
  const assignedToPara = new Set();
  
  // Create an array to hold items for each box
  aiBoxes.forEach(b => b.items = []);

  for (const item of styledBody) {
    const t = item.transform;
    const x = t[4], y = t[5] - Math.abs(t[3]), w = item.width || Math.abs(t[3]), h = Math.abs(t[3]);
    const cx = x + w / 2;
    const cy = y + h / 2;

    let bestBox = null;
    let minDistance = Infinity;

    for (const box of aiBoxes) {
      if (['header', 'header_image', 'footer', 'footer_image', 'number'].includes(box.label)) continue;
      
      if (cx >= (box.x0 - 50) && cx <= (box.x1 + 50) && cy >= box.y0 && cy <= box.y1) {
        const boxCy = (box.y0 + box.y1) / 2;
        const dist = Math.abs(cy - boxCy);
        if (dist < minDistance) {
          minDistance = dist;
          bestBox = box;
        }
      }
    }

    if (bestBox) {
      bestBox.items.push(item);
      assignedToPara.add(item);
    }
  }

  // Sort boxes by Y so paragraphs are emitted in reading order
  aiBoxes.sort((a, b) => a.y0 - b.y0);

  for (const box of aiBoxes) {
    if (['header', 'header_image', 'footer', 'footer_image', 'number'].includes(box.label)) continue;
    
    let isSpecialized = ['image', 'chart', 'seal', 'table', 'formula'].includes(box.label);

    if (box.label === 'table' || box.label === 'chart') {
      const checkHasLines = (b, lines) => {
        if (!lines || !lines.length) return false;
        const pad = 2;
        for (const line of lines) {
          const minX = Math.min(line.start.x, line.end.x) - pad;
          const maxX = Math.max(line.start.x, line.end.x) + pad;
          const minY = Math.min(line.start.y, line.end.y) - pad;
          const maxY = Math.max(line.start.y, line.end.y) + pad;
          if (minX <= b.x1 && maxX >= b.x0 && minY <= b.y1 && maxY >= b.y0) return true;
        }
        return false;
      };
      
      const hasLines = checkHasLines(box, opAnalysis.drawnLines);
      if (!hasLines && box.confidence < 0.5) {
        isSpecialized = false;
      }
    }

    if (box.items && box.items.length > 0 && !isSpecialized) {
      const lines = groupIntoLines(box.items);
      const blocks = groupIntoBlocks(lines, 2.0, pageWidth, margins);
      for (const b of blocks) {
        if (b.type === 'column_block') {
          // Preserve the AI label on the column block itself
          b.label = box.label;
          paragraphs.push(b);
        } else {
          b.label = box.label;
          paragraphs.push(b);
        }
      }
    }
  }
  
  // Any text not captured by AI boxes gets appended at the end
  const unassigned = styledBody.filter(i => !assignedToPara.has(i));
  if (unassigned.length > 0) {
    const lines = groupIntoLines(unassigned);
    const blocks = groupIntoBlocks(lines, 2.0, pageWidth, margins);
    paragraphs.push(...blocks);
  }

  // Helper to get Y of a paragraph or column_block
  const getBlockY = (block) => {
    if (block.type === 'column_block') {
      for (const col of (block.columns || [])) {
        if (col.paragraphs && col.paragraphs.length > 0 && col.paragraphs[0].lines && col.paragraphs[0].lines.length > 0) {
          return col.paragraphs[0].lines[0].y;
        }
      }
      return 0;
    }
    return block.lines && block.lines.length > 0 ? block.lines[0].y : 0;
  };

  // Sort paragraphs by the baseline Y of their first line
  paragraphs.sort((a, b) => getBlockY(a) - getBlockY(b));

  const mergedParas = [];
  for (const para of paragraphs) {
    // Never merge column_blocks — pass them through directly
    if (para.type === 'column_block') {
      mergedParas.push(para);
      continue;
    }

    const y = para.lines && para.lines.length > 0 ? para.lines[0].y : null;
    if (y !== null && mergedParas.length > 0) {
      const prevPara = mergedParas[mergedParas.length - 1];
      // Don't merge into a column_block
      if (prevPara.type === 'column_block') {
        mergedParas.push(para);
        continue;
      }
      const prevY = prevPara.lines && prevPara.lines.length > 0 ? prevPara.lines[0].y : null;
      
      // If Y difference is very small (< 4 points), they start on the same line
      // BUT also check horizontal distance — don't merge paragraphs from different columns
      const prevX0 = prevPara.lines[0]?.items?.[0]?.transform?.[4] ?? 0;
      const paraX0 = para.lines[0]?.items?.[0]?.transform?.[4] ?? 0;
      const horizontallyClose = Math.abs(prevX0 - paraX0) < 100;
      if (prevY !== null && Math.abs(y - prevY) < 4 && horizontallyClose) {
        // Merge their first lines
        const prevFirstLine = prevPara.lines[0];
        const paraFirstLine = para.lines[0];
        prevFirstLine.items.push(...paraFirstLine.items);
        prevFirstLine.items.sort((a, b) => a.transform[4] - b.transform[4]);
        
        // Append any remaining lines
        for (let i = 1; i < para.lines.length; i++) {
          prevPara.lines.push(para.lines[i]);
        }
        
        // Sort lines top-to-bottom
        prevPara.lines.sort((a, b) => a.y - b.y);
        
        // Recalculate alignment
        prevPara.alignment = detectParagraphAlignment(prevPara.lines, pageWidth, margins);
        continue;
      }
    }
    mergedParas.push(para);
  }
  
  // Reassign merged paragraphs
  paragraphs.length = 0;
  paragraphs.push(...mergedParas);

  // 10. Columns (for reference)
  const bodyLines = groupIntoLines(styledBody);
  const columns = detectColumnsFromLines(bodyLines, pageWidth);

  // 11. Margins are already detected at step 4.5

  return {
    headers: headers,
    footers: footers,
    headerBottomY,
    footerTopY,
    body: styledBody,
    paragraphs,
    drawnLines: opAnalysis.drawnLines,
    rectangles: opAnalysis.rectangles,
    images: opAnalysis.images,
    paths: opAnalysis.paths,
    columns,
    margins,
    mergedBoxes,
    backgroundElements
  };
}
