/**
 * @fileoverview DOCX Generation Module for PDF-to-DOCX Converter
 *
 * Converts structured page data extracted from PDF documents into
 * fully formatted DOCX files using the `docx` npm package (v9.1.1)
 * loaded via ESM CDN. Handles text styling, tables, images, formulas,
 * headers/footers, horizontal rules, and page backgrounds.
 *
 * @module docx-builder
 */

import {
  Document, Packer, Paragraph, TextRun, ImageRun,
  Header, Footer, Table, TableRow, TableCell,
  WidthType, BorderStyle, AlignmentType, HeadingLevel,
  PageOrientation, SectionType, PageNumber, NumberFormat,
  TableLayoutType, VerticalAlign, ShadingType,
  TabStopType, TabStopPosition, Tab, ExternalHyperlink,
  convertInchesToTwip, TextWrappingType, TextWrappingSide,
  HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom
} from 'https://esm.sh/docx@9.1.1';
import { getLineAlignment } from './heuristics.js';
import JSZip from 'https://esm.sh/jszip@3.10.1';

// No external file-saver dependency — using native browser download API

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Conversion factor: 1 PDF point = 20 twips */
const TWIPS_PER_PT = 20;

/** Conversion factor: 1 PDF point = 12700 EMUs */
const EMUS_PER_PT = 12700;

/** Conversion factor: points to pixels at 96 DPI (96/72) */
const PT_TO_PX_96DPI = 96 / 72;

/** Minimum horizontal gap (as fraction of font size) to insert a space */
const GAP_SPACE_THRESHOLD = 0.3;

/** Minimum fraction of page width a line must span to be a horizontal rule */
const HRULE_WIDTH_FRACTION = 0.15;

/** Heading detection thresholds (average font size in PDF points) */
const HEADING_THRESHOLDS = [
  { minSize: 24, level: HeadingLevel.HEADING_1 },
  { minSize: 18, level: HeadingLevel.HEADING_2 },
  { minSize: 14, level: HeadingLevel.HEADING_3 },
  { minSize: 13, level: HeadingLevel.HEADING_4 }
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate vertical spacing between paragraphs based on actual font metrics.
 *
 * @param {object} para - Current paragraph
 * @param {object|null} prevPara - Previous paragraph
 * @param {object} margins - Page margins
 * @returns {object} DOCX paragraph spacing object
 */
function calculateSpacing(para, prevElemWrapper, margins) {
  let lineSpacingTwips = undefined;
  if (para.lines && para.lines.length > 1) {
    const gaps = [];
    let maxFontSize = 10;
    for (let i = 1; i < para.lines.length; i++) {
      const prevY = safe(() => para.lines[i-1].items[0].transform[5], para.lines[i-1].y || 0);
      const currY = safe(() => para.lines[i].items[0].transform[5], para.lines[i].y || 0);
      
      const prevFs = safe(() => para.lines[i-1].items[0].style.fontSize, 10);
      const currFs = safe(() => para.lines[i].items[0].style.fontSize, 10);
      maxFontSize = Math.max(maxFontSize, prevFs, currFs);

      const diff = Math.abs(currY - prevY);
      if (diff > 2) gaps.push(diff); // ignore spurious 0-height lines
    }
    
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const medianDiff = gaps[Math.floor(gaps.length / 2)];
      
      // Use exact spacing in twips to match PDF rendering perfectly and prevent overflow
      lineSpacingTwips = ptsToTwips(medianDiff);
    }
  }

  let fallbackFontSize = 12;
  if (para.lines && para.lines.length > 0) {
    fallbackFontSize = safe(() => para.lines[0].items[0].style.fontSize, 12);
  }

  const lineOptions = lineSpacingTwips 
    ? { line: lineSpacingTwips, lineRule: 'exact' }
    : { line: ptsToTwips(fallbackFontSize * 1.15), lineRule: 'exact' };

  if (!prevElemWrapper) {
    const currTy = getItemY(para.lines[0]);
    const currFs = safe(() => para.lines[0].items[0].style.fontSize, 12);
    const currTop = currTy - currFs;
    let spaceBefore = currTop - margins.top;
    if (spaceBefore < 0) spaceBefore = 0;
    
    return { before: ptsToTwips(spaceBefore), after: 0, ...lineOptions };
  }

  let prevBottom = 0;
  let prevFs = 12;

  if (prevElemWrapper.type === 'paragraph') {
    const prevPara = prevElemWrapper.data;
    const prevLastLine = prevPara.lines[prevPara.lines.length - 1];
    const prevTy = safe(() => prevLastLine.items[0].transform[5], prevLastLine.y || 0);
    prevFs = safe(() => prevLastLine.items[0].style.fontSize, 12);
    prevBottom = prevTy + prevFs * 0.2; // roughly descent
  } else if (prevElemWrapper.data && prevElemWrapper.data.bbox) {
    prevBottom = prevElemWrapper.data.bbox.y1;
  } else {
    prevBottom = prevElemWrapper.y;
  }

  const currFirstLine = para.lines[0];
  const currTy = safe(() => currFirstLine.items[0].transform[5], currFirstLine.y || 0);
  const currFs = safe(() => currFirstLine.items[0].style.fontSize, 12);
  const currTop = currTy - currFs; // roughly ascent

  let spaceBefore = currTop - prevBottom;
  
  if (spaceBefore < 0) spaceBefore = 0;
  
  // If the gap is small, treat it as normal line spacing
  if (spaceBefore < Math.max(prevFs, currFs) * 0.5) {
      spaceBefore = 0;
  }

  return { before: ptsToTwips(spaceBefore), after: 0, ...lineOptions };
}

/**
 * Convert an [r, g, b] colour array (0‑1 range) to a 6‑character hex string.
 *
 * @param {number[]} color - RGB array with values in [0, 1].
 * @returns {string} Hex colour string without '#', e.g. '1A2B3C'.
 */
export function rgbToHex(color) {
  if (!color || !Array.isArray(color) || color.length < 3) {
    return '000000';
  }
  return color
    .slice(0, 3)
    .map(c => {
      const clamped = Math.max(0, Math.min(1, c));
      const byte = Math.round(clamped * 255);
      return byte.toString(16).padStart(2, '0');
    })
    .join('')
    .toUpperCase();
}

/**
 * Convert PDF points to twips.
 *
 * @param {number} pts - Value in PDF points.
 * @returns {number} Value rounded to nearest twip.
 */
function ptsToTwips(pts) {
  return Math.round((pts || 0) * TWIPS_PER_PT);
}

/**
 * Convert PDF points to DOCX half‑points (used for font sizes).
 *
 * @param {number} pts - Font size in PDF points.
 * @returns {number} Font size in half‑points.
 */
function ptsToHalfPts(pts) {
  return (pts || 10) * 2;
}

/**
 * Safely retrieve a nested property, returning a fallback on failure.
 *
 * @param {Function} accessor - A function that accesses the desired value.
 * @param {*} fallback - Value to return if the accessor throws.
 * @returns {*} The accessed value or the fallback.
 */
function safe(accessor, fallback) {
  try {
    const v = accessor();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Get the Y‑coordinate of a styled text item from its transform matrix.
 * The transform is [a, b, c, d, tx, ty].
 *
 * @param {object} item - Styled text item.
 * @returns {number} The ty value (Y position in PDF coordinate space).
 */
function getItemY(item) {
  return safe(() => item.transform[5], 0);
}

/**
 * Get the X‑coordinate of a styled text item from its transform matrix.
 * The transform is [a, b, c, d, tx, ty].
 *
 * @param {object} item - Styled text item.
 * @returns {number} The tx value (X position in PDF coordinate space).
 */
function getItemX(item) {
  return safe(() => item.transform[4], 0);
}

/**
 * Map an alignment string to the docx AlignmentType enum.
 *
 * @param {string} align - One of 'left', 'center', 'right', 'justify'.
 * @returns {string} Corresponding AlignmentType value.
 */
function mapAlignment(align) {
  switch (align) {
    case 'center': return AlignmentType.CENTER;
    case 'right':  return AlignmentType.RIGHT;
    case 'justify': return AlignmentType.JUSTIFIED;
    default:       return AlignmentType.LEFT;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Run Builder
// ─────────────────────────────────────────────────────────────────────────────

function buildRunProperties(style = {}, overrides = {}) {
  return {
    bold: !!style.bold,
    italics: !!style.italic,
    font: style.fontFamily || 'Arial',
    size: ptsToHalfPts(style.fontSize),
    color: style.color || '000000',
    ...overrides
  };
}

/**
 * Create a {@link TextRun} from a styled text item.
 *
 * @param {object} item - Styled text item with `str` and `style`.
 * @param {object} [overrides] - Optional property overrides for the TextRun.
 * @returns {TextRun} A configured TextRun instance.
 */
function makeTextRun(item, overrides = {}) {
  const config = buildRunProperties(item.style, overrides);
  const text = item.str || '';

  if (item.style && item.style.underline) {
    config.underline = {};
  }

  let url = item.style && item.style.url;
  
  // Auto-detect emails and URLs if no explicit annotation was found
  if (!url) {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
    const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/;
    
    let match = text.match(emailRegex);
    let isEmail = true;
    if (!match) {
      match = text.match(urlRegex);
      isEmail = false;
    }

    if (match) {
      const parts = text.split(match[0]);
      const runs = [];
      
      if (parts[0]) {
        runs.push(new TextRun({ ...config, text: parts[0] }));
      }
      
      const linkUrl = isEmail ? 'mailto:' + match[0] : (match[0].startsWith('www.') ? 'https://' + match[0] : match[0]);
      runs.push(new ExternalHyperlink({
        children: [
          new TextRun({ ...config, text: match[0], color: '0563C1', underline: {} })
        ],
        link: linkUrl
      }));
      
      if (parts[1]) {
        runs.push(new TextRun({ ...config, text: parts[1] }));
      }
      
      return runs;
    }
  }

  config.text = text;
  const run = new TextRun(config);
  
  if (url) {
    return new ExternalHyperlink({
      children: [
        new TextRun({ ...config, color: '0563C1', underline: {} })
      ],
      link: url
    });
  }
  
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paragraph Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect a heading level based on average font size and bold status
 * of all items within a paragraph.
 *
 * @param {object[]} allItems - Flat array of styled text items in the paragraph.
 * @returns {string|undefined} A HeadingLevel value, or undefined for body text.
 */
function detectHeadingLevel(allItems, label) {
  if (label === 'doc_title') return HeadingLevel.TITLE;
  if (label === 'paragraph_title') {
    if (!allItems || allItems.length === 0) return undefined;
    const avgFontSize = allItems.reduce((sum, item) => sum + safe(() => item.style.fontSize, 10), 0) / allItems.length;
    for (const threshold of HEADING_THRESHOLDS) {
      if (avgFontSize >= threshold.minSize) return threshold.level;
    }
    // Only return Heading 1 if it is actually bold, otherwise do not force a heading
    const allBold = allItems.every(item => safe(() => item.style.bold, false));
    if (allBold) return HeadingLevel.HEADING_1;
    return undefined;
  }

  // Fallback to heuristics
  if (!allItems || allItems.length === 0) return undefined;

  const avgFontSize =
    allItems.reduce((sum, item) => sum + safe(() => item.style.fontSize, 10), 0) /
    allItems.length;

  for (const threshold of HEADING_THRESHOLDS) {
    if (avgFontSize >= threshold.minSize) {
      return threshold.level;
    }
  }

  return undefined;
}

/**
 * Build a DOCX {@link Paragraph} from a structured paragraph object.
 *
 * The paragraph object contains `lines` (each with `items` and a `y` value)
 * and an `alignment` property.
 *
 * @param {object} para - Paragraph descriptor from page data.
 * @param {object} [spacingOpts] - Optional `before`/`after` spacing in twips.
 * @returns {Paragraph} A fully configured Paragraph instance.
 */
function buildParagraph(para, spacingOpts = {}, pageWidth = 595.28, pageMargins = {left: 72, right: 72}) {
  const lines = para.lines || [];
  const allItems = lines.flatMap(line => line.items || []);

  if (allItems.length === 0) {
    return new Paragraph({ children: [] });
  }

  const heading = detectHeadingLevel(allItems, para.label);
  const children = [];

  const inlineImages = para.inlineImages || [];
  for (const img of inlineImages) {
    let bestLine = lines[0];
    let minDist = Infinity;
    const imgCenterY = (img.bbox.y0 + img.bbox.y1) / 2;
    for (const line of lines) {
      const dist = Math.abs(line.y - imgCenterY);
      if (dist < minDist) { minDist = dist; bestLine = line; }
    }
    if (bestLine) {
      bestLine.items.push({
        isImage: true,
        data: img,
        transform: [1, 0, 0, img.bbox.y1 - img.bbox.y0, img.bbox.x0, img.bbox.y1],
        width: img.bbox.x1 - img.bbox.x0
      });
      bestLine.items.sort((a, b) => getItemX(a) - getItemX(b));
    }
  }

  const tabStops = [];

  let bulletHandledInfo = null;
  if (lines.length > 0 && lines[0].items.length > 0) {
    const bIdx = lines[0].items.findIndex(it => it.str && it.str.trim().length > 0);
    if (bIdx >= 0) {
      const bulletItem = lines[0].items[bIdx];
      if (/^(•|-|–|—|\*|\d+\.)/.test(bulletItem.str.trim())) {
        let tIdx = lines[0].items.slice(bIdx + 1).findIndex(it => it.str && it.str.trim().length > 0);
        if (tIdx >= 0) {
          tIdx += bIdx + 1;
          bulletHandledInfo = { bulletIdx: bIdx, textIdx: tIdx };
        }
      }
    }
  }

  let baseLeft = 0;
  if (lines.length > 0 && lines[0].items.length > 0) {
    baseLeft = getItemX(lines[0].items[0]) - pageMargins.left;
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const items = line.items || [];

    let lineStartsFarRight = false;
    let lineStartTabPos = 0;
    if (lineIdx > 0 && items.length > 0) {
      lineStartTabPos = getItemX(items[0]) - pageMargins.left;
      if (lineStartTabPos - baseLeft > 50) {
        lineStartsFarRight = true;
      }
    }

    if (lineIdx > 0) {
      if (lineStartsFarRight) {
        tabStops.push({ type: TabStopType.LEFT, position: ptsToTwips(Math.max(0, lineStartTabPos)) });
        children.push(new TextRun({ children: [new Tab()] }));
      } else {
        children.push(new TextRun({ text: ' ' }));
      }
    }

    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx];

      if (item.isImage) {
        children.push(buildImageRun(item.data));
        continue;
      }

      // Insert a tab between items on the same line if there's a
      // horizontal gap larger than GAP_SPACE_THRESHOLD × font size,
      // or if we detect this is the gap between a bullet and its text.
      if (lineIdx === 0 && bulletHandledInfo && itemIdx === bulletHandledInfo.textIdx) {
        const curLeft = getItemX(item);
        const tabPos = curLeft - pageMargins.left;
        tabStops.push({
          type: TabStopType.LEFT,
          position: ptsToTwips(Math.max(0, tabPos))
        });
        children.push(new TextRun({ children: [new Tab()] }));
      } else if (itemIdx > 0) {
        const prev = items[itemIdx - 1];
        const prevRight = getItemX(prev) + safe(() => prev.width, 0);
        const curLeft = getItemX(item);
        const gap = curLeft - prevRight;
        const fontSize = safe(() => prev.style.fontSize, 10);

        if (gap > fontSize * 1.2) {
          let tabPos = curLeft - pageMargins.left;
          const textAreaWidth = pageWidth - pageMargins.left - pageMargins.right;
          
          let tabType = TabStopType.LEFT;
          // If the text is pushed to the far right, use a Right Tab to prevent Word from wrapping the line
          if (tabPos > textAreaWidth * 0.8) {
            tabType = TabStopType.RIGHT;
            tabPos = textAreaWidth;
          }
          
          tabStops.push({
            type: tabType,
            position: ptsToTwips(Math.max(0, tabPos))
          });
          children.push(new TextRun({ children: [new Tab()] }));
        } else if (gap > 0.5) {
          children.push(new TextRun({ text: ' ', font: safe(() => item.style.fontFamily, 'Arial'), size: ptsToHalfPts(fontSize) }));
        }
      }

      const overrides = {};
      if (para.label === 'algorithm') overrides.font = 'Courier New';
      if (para.label === 'footnote') { overrides.size = ptsToHalfPts(8); overrides.color = '666666'; }
      if (para.label === 'aside_text') overrides.italics = true;
      if (para.label === 'table_title' || para.label === 'figure_title' || para.label === 'chart_title') overrides.italics = true;

      const run = makeTextRun(item, overrides);
      if (Array.isArray(run)) {
        children.push(...run);
      } else {
        children.push(run);
      }
    }
  }

  const paragraphConfig = {
    children,
    alignment: mapAlignment(para.alignment),
    widowControl: false
  };

  if (tabStops.length > 0) {
    paragraphConfig.tabStops = tabStops;
  }

  const getLineStartX = (line) => {
    for (const item of line.items) {
      if (!item.isImage && item.str && item.str.trim().length > 0) return getItemX(item);
    }
    return getItemX(line.items[0]);
  };

  if (paragraphConfig.alignment === AlignmentType.LEFT || paragraphConfig.alignment === AlignmentType.JUSTIFIED) {
    let leftIndent = 0;
    let firstLineIndent = 0;
    let isBulletHandled = false;

    if (lines.length > 0 && lines[0].items.length > 0) {
      const firstTextItemIdx = lines[0].items.findIndex(it => it.str && it.str.trim().length > 0);
      
      if (firstTextItemIdx >= 0) {
        const bulletItem = lines[0].items[firstTextItemIdx];
        const isBullet = /^(•|-|–|—|\*|\d+\.)/.test(bulletItem.str.trim());
        
        if (isBullet) {
          const textItem = lines[0].items.slice(firstTextItemIdx + 1).find(it => it.str && it.str.trim().length > 0);
          if (textItem) {
            const bulletX = getItemX(bulletItem);
            let textX = getItemX(textItem);
            if (textX - bulletX > 5 && textX - bulletX < 50) {
              leftIndent = textX - pageMargins.left;
              firstLineIndent = bulletX - textX;
              isBulletHandled = true;
            }
          }
        }
      }
    }

    if (!isBulletHandled && lines.length > 0 && lines[0].items.length > 0) {
      const firstLineX = getLineStartX(lines[0]);
      leftIndent = firstLineX - pageMargins.left;
      
      if (lines.length > 1 && lines[1].items.length > 0) {
        const secondLineX = getLineStartX(lines[1]);
        const secondLineIndent = secondLineX - pageMargins.left;
        
        if (Math.abs(firstLineX - secondLineX) > 5) {
          // It has a first line or hanging indent!
          leftIndent = secondLineIndent;
          firstLineIndent = firstLineX - secondLineX;
        }
      }
    }
    
    if (leftIndent > 5 || Math.abs(firstLineIndent) > 5) {
      paragraphConfig.indent = {};
      if (leftIndent > 5) paragraphConfig.indent.left = ptsToTwips(leftIndent);
      if (firstLineIndent > 5) paragraphConfig.indent.firstLine = ptsToTwips(firstLineIndent);
      else if (firstLineIndent < -5) paragraphConfig.indent.hanging = ptsToTwips(Math.abs(firstLineIndent));
    }
  }

  if (heading) {
    paragraphConfig.heading = heading;
  }

  if (spacingOpts.before !== undefined || spacingOpts.after !== undefined) {
    paragraphConfig.spacing = spacingOpts;
  }

  return new Paragraph(paragraphConfig);
}

// ─────────────────────────────────────────────────────────────────────────────
// Table Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a fallback image paragraph for a table whose structure could not
 * be recognized.
 *
 * @param {Uint8Array} imageData - PNG bytes of the table screenshot.
 * @param {object} bbox - Bounding box { x0, y0, x1, y1 } in PDF points.
 * @returns {Paragraph} A Paragraph containing the table image.
 */
function fallbackTableAsImage(imageData, bbox) {
  if (!imageData || imageData.length === 0) {
    return new Paragraph({ children: [new TextRun({ text: '[Table could not be rendered]', italics: true, color: '999999' })] });
  }

  const widthPts = (bbox.x1 || 0) - (bbox.x0 || 0);
  const heightPts = (bbox.y1 || 0) - (bbox.y0 || 0);

  return new Paragraph({
    spacing: { before: 0, after: 0 },
    children: [
      new ImageRun({
        data: imageData,
        transformation: {
          width: Math.round(Math.max(widthPts, 1) * PT_TO_PX_96DPI),
          height: Math.round(Math.max(heightPts, 1) * PT_TO_PX_96DPI)
        },
        type: 'png'
      })
    ]
  });
}

/**
 * Attempt to build a proper {@link Table} from detection data, or fall back
 * to an image embed.
 *
 * Row and column detections are used to form a grid. Text items are assigned
 * to cells based on their (tx, ty) position falling inside the intersection
 * of a row's and column's bounding boxes.
 *
 * @param {object} tableData - Table descriptor from page data.
 * @returns {Table|Paragraph} A Table if structure is detected, otherwise a
 *   Paragraph with an image fallback.
 */
function buildTable(tableData) {
  const { detections, textItems, bbox, imageData } = tableData || {};
  const safeDetections = detections || [];
  const safeTextItems = textItems || [];

  const rows = safeDetections
    .filter(d => d.label === 'table row')
    .sort((a, b) => a.box.ymin - b.box.ymin);
  const cols = safeDetections
    .filter(d => d.label === 'table column')
    .sort((a, b) => a.box.xmin - b.box.xmin);

  // Fall back to image if we can't determine row/column structure
  if (rows.length === 0 || cols.length === 0) {
    console.info(`[docx-builder] Table fallback: Missing structural detections (rows: ${rows.length}, cols: ${cols.length}). Building table as image.`);
    return fallbackTableAsImage(imageData, bbox || { x0: 0, y0: 0, x1: 200, y1: 100 });
  }

  const tableRows = rows.map(row => {
    const cells = cols.map(col => {
      // Find text items whose origin falls inside this cell
      const cellTexts = safeTextItems.filter(t => {
        const tx = safe(() => t.transform[4], -1);
        const ty = safe(() => t.transform[5], -1);
        return (
          tx >= col.box.xmin && tx <= col.box.xmax &&
          ty >= row.box.ymin && ty <= row.box.ymax
        );
      });

      const cellChildren = cellTexts.length > 0
        ? cellTexts.map(t => new TextRun({
            text: t.str || '',
            font: safe(() => t.style.fontFamily, 'Arial'),
            size: ptsToHalfPts(safe(() => t.style.fontSize, 10)),
            bold: safe(() => t.style.bold, false),
            italics: safe(() => t.style.italic, false),
            color: safe(() => t.style.color, '000000')
          }))
        : [new TextRun({ text: '' })];

      return new TableCell({
        children: [new Paragraph({ children: cellChildren })],
        width: {
          size: ptsToTwips(col.box.xmax - col.box.xmin),
          type: WidthType.DXA
        },
        verticalAlign: VerticalAlign.CENTER
      });
    });

    return new TableRow({ children: cells });
  });

  return new Table({
    rows: tableRows,
    width: {
      size: ptsToTwips((bbox?.x1 || 0) - (bbox?.x0 || 0)),
      type: WidthType.DXA
    },
    layout: TableLayoutType.FIXED
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a {@link Paragraph} containing an embedded image.
 *
 * @param {object} img - Image descriptor with `data`, `bbox`, `width`, `height`.
 * @returns {Paragraph} A Paragraph wrapping an ImageRun.
 */
function buildImageRun(img) {
  const bboxWidth = safe(() => img.bbox.x1 - img.bbox.x0, img.width || 100);
  const bboxHeight = safe(() => img.bbox.y1 - img.bbox.y0, img.height || 100);

  let targetW = bboxWidth;
  let targetH = bboxHeight;

  if (img.width && img.height) {
    const aspect = img.width / img.height;
    if (bboxWidth / bboxHeight > aspect) {
      targetW = bboxHeight * aspect;
    } else {
      targetH = bboxWidth / aspect;
    }
  }

  const imageRunOptions = {
    data: img.data,
    transformation: {
      width: Math.round(Math.max(targetW, 1) * PT_TO_PX_96DPI),
      height: Math.round(Math.max(targetH, 1) * PT_TO_PX_96DPI)
    },
    type: 'png'
  };

  if (img.isFloating && img.bbox) {
    imageRunOptions.floating = {
      zIndex: img.zIndex || 1,
      horizontalPosition: {
        relative: HorizontalPositionRelativeFrom.PAGE,
        offset: Math.round(img.bbox.x0 * EMUS_PER_PT)
      },
      verticalPosition: {
        relative: VerticalPositionRelativeFrom.PAGE,
        offset: Math.round(img.bbox.y0 * EMUS_PER_PT)
      },
      wrap: {
        type: TextWrappingType.NONE
      }
    };
  }
  
  return new ImageRun(imageRunOptions);
}

function buildImageParagraph(img) {
  if (!img || !img.data || img.data.length === 0) {
    return new Paragraph({
      children: [new TextRun({ text: '[Image could not be rendered]', italics: true, color: '999999' })]
    });
  }

  const paraOptions = {
    alignment: AlignmentType.CENTER,
    children: [buildImageRun(img)],
    spacing: { before: 0, after: 0 }
  };

  if (img.isFloating) {
    paraOptions.spacing.line = 1;
    paraOptions.spacing.lineRule = 'exact';
  }

  return new Paragraph(paraOptions);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formula Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a centred italic paragraph for a LaTeX formula.
 *
 * Since DOCX has limited native equation support outside of OMML, we embed
 * the LaTeX source as styled Cambria Math text.
 *
 * @param {object} formula - Formula descriptor with `latex` and `bbox`.
 * @returns {Paragraph} A Paragraph with the formula text.
 */
function buildFormulaParagraph(formula) {
  const latex = safe(() => formula.latex, '');
  return new Paragraph({
    children: [
      new TextRun({
        text: latex,
        font: 'Cambria Math',
        italics: true,
        size: 24 // 12pt in half-points
      })
    ],
    alignment: AlignmentType.CENTER
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Horizontal Rule Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a {@link Paragraph} that visually represents a horizontal rule
 * using a bottom border.
 *
 * @param {object} line - Drawn line descriptor with `color`, `lineWidth`, etc.
 * @returns {Paragraph} An empty paragraph with a styled bottom border.
 */
function buildHorizontalRule(line) {
  const color = rgbToHex(safe(() => line.color, [0, 0, 0]));
  const rawLineWidth = (line && typeof line.lineWidth === 'number') ? line.lineWidth : 1;
  const weight = Math.max(1, Math.round(rawLineWidth * 8));

  return new Paragraph({
    children: [],
    spacing: {
      line: 20,
      lineRule: 'exact',
      before: 0,
      after: 0
    },
    border: {
      top: {
        color,
        size: weight,
        style: BorderStyle.SINGLE,
        space: 1
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Column Block Builder (multi-column layouts as borderless tables)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render a column_block as a borderless DOCX table with one row and N cells.
 * This is the standard technique for multi-column document layouts in DOCX.
 *
 * @param {object} columnBlock - Column block descriptor with `columns` array.
 * @param {object} dims - Page dimensions { width, height }.
 * @param {object} margins - Page margins { left, right, top, bottom }.
 * @returns {Table} A borderless Table representing the column layout.
 */
function buildColumnBlockTable(columnBlock, dims, margins) {
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = {
    top: noBorder, bottom: noBorder,
    left: noBorder, right: noBorder,
    insideHorizontal: noBorder, insideVertical: noBorder
  };

  const textAreaWidth = dims.width - margins.left - margins.right;
  const columns = columnBlock.columns || [];

  const cells = columns.map((col, colIdx) => {
    const cellParas = [];
    const colParas = col.paragraphs || [];

    for (let i = 0; i < colParas.length; i++) {
      const para = colParas[i];
      const spacingOpts = (i === 0)
        ? { before: 0, after: 0 }
        : calculateSpacing(para, { type: 'paragraph', data: colParas[i - 1] }, margins);
      cellParas.push(buildParagraph(para, spacingOpts, col.width || textAreaWidth / columns.length, { left: 0, right: 0 }));
    }

    if (cellParas.length === 0) {
      cellParas.push(new Paragraph({ children: [] }));
    }

    return new TableCell({
      children: cellParas,
      width: { size: ptsToTwips(col.width || textAreaWidth / columns.length), type: WidthType.DXA },
      borders: noBorders,
      verticalAlign: VerticalAlign.TOP
    });
  });

  if (cells.length === 0) {
    return new Paragraph({ children: [] });
  }

  return new Table({
    rows: [new TableRow({ children: cells })],
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: noBorders
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Vertical Rule Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a {@link Paragraph} representing a vertical rule using a floating
 * image-like approach with a left border on a paragraph.
 *
 * @param {object} line - Drawn line descriptor.
 * @param {object} dims - Page dimensions.
 * @returns {Paragraph} A styled paragraph representing a vertical line.
 */
function buildVerticalRule(line, dims) {
  const color = rgbToHex(safe(() => line.color, [0, 0, 0]));
  const rawLineWidth = (line && typeof line.lineWidth === 'number') ? line.lineWidth : 1;
  const weight = Math.max(1, Math.round(rawLineWidth * 8));

  const lineHeight = Math.abs(
    safe(() => line.end.y, 0) - safe(() => line.start.y, 0)
  );

  return new Paragraph({
    children: [],
    spacing: {
      line: ptsToTwips(lineHeight),
      lineRule: 'exact',
      before: 0,
      after: 0
    },
    border: {
      left: {
        color,
        size: weight,
        style: BorderStyle.SINGLE,
        space: 1
      }
    },
    indent: {
      left: ptsToTwips(safe(() => line.start.x, 0) - (dims ? dims.margins?.left || 72 : 72))
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Element Interleaving
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} PositionedElement
 * @property {number} y - Y‑coordinate for sort ordering.
 * @property {'paragraph'|'table'|'image'|'formula'|'hrule'} type - Element category.
 * @property {*} data - Source data for building the DOCX element.
 */

/**
 * Compute the representative Y position for a paragraph.
 * Uses the Y of the first line's first item.
 *
 * @param {object} para - Paragraph descriptor.
 * @returns {number} Y position.
 */
function paragraphY(para) {
  return safe(() => para.lines[0].y, safe(() => para.lines[0].items[0].transform[5], 0));
}

/**
 * Collect all renderable elements from a page and sort them by Y position
 * so they appear in reading order in the output document.
 *
 * @param {object} page - Page data object.
 * @returns {PositionedElement[]} Sorted array of positioned elements.
 */
function collectAndSortElements(page) {
  /** @type {PositionedElement[]} */
  const elements = [];

  // Paragraphs (including column_block objects)
  const paragraphs = page.paragraphs || [];
  for (const para of paragraphs) {
    if (para.type === 'column_block') {
      // Use the Y of the first paragraph in the first non-empty column
      let cbY = 0;
      for (const col of (para.columns || [])) {
        if (col.paragraphs && col.paragraphs.length > 0) {
          cbY = paragraphY(col.paragraphs[0]);
          break;
        }
      }
      elements.push({ y: cbY, type: 'column_block', data: para });
    } else {
      elements.push({ y: paragraphY(para), type: 'paragraph', data: para });
    }
  }

  // Tables
  const tables = page.tables || [];
  for (const tbl of tables) {
    const y = safe(() => tbl.bbox.y0, 0);
    elements.push({ y, type: 'table', data: tbl });
  }

  // Helper for partial overlap
  const checkPartialOverlap = (b1, b2) => {
    if (!b1 || !b2) return false;
    const overlapX = Math.max(0, Math.min(b1.x1, b2.x1) - Math.max(b1.x0, b2.x0));
    const overlapY = Math.max(0, Math.min(b1.y1, b2.y1) - Math.max(b1.y0, b2.y0));
    if (overlapX > 0 && overlapY > 0) {
      const area1 = (b1.x1 - b1.x0) * (b1.y1 - b1.y0);
      const area2 = (b2.x1 - b2.x0) * (b2.y1 - b2.y0);
      const overlapArea = overlapX * overlapY;
      if (overlapArea > area1 * 0.95 || overlapArea > area2 * 0.95) return false;
      return true;
    }
    return false;
  };

  const getParaBBox = (para) => {
    if (!para.lines || para.lines.length === 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const line of para.lines) {
      for (const item of line.items) {
        const t = item.transform;
        const h = Math.abs(t[3]);
        const w = item.width || h;
        const ix = t[4], iy = t[5] - h;
        x0 = Math.min(x0, ix); y0 = Math.min(y0, iy);
        x1 = Math.max(x1, ix + w); y1 = Math.max(y1, iy + h);
      }
    }
    return x0 === Infinity ? null : { x0, y0, x1, y1 };
  };

  const allBBoxes = [];
  for (const para of paragraphs) {
    const b = getParaBBox(para);
    if (b) allBBoxes.push(b);
  }
  for (const tbl of page.tables || []) if (tbl.bbox) allBBoxes.push(tbl.bbox);
  for (const fm of page.formulas || []) if (fm.bbox) allBBoxes.push(fm.bbox);

  page.headerImages = [];
  page.footerImages = [];
  const headerBottomY = page.headerBottomY || 0;
  const footerTopY = page.footerTopY || Infinity;

  // Images
  const images = page.images || [];
  
  for (let idx = 0; idx < images.length; idx++) {
    const img = images[idx];
    const y = safe(() => img.bbox.y0, 0);
    const imgBottom = safe(() => img.bbox.y1, 0);
    
    img.isFloating = true;
    img.zIndex = idx + 1; // Base z-index on original drawing order
    
    if (imgBottom < headerBottomY) {
      page.headerImages.push(img);
      continue;
    }
    if (y > footerTopY) {
      page.footerImages.push(img);
      continue;
    }
    
    elements.push({ y, type: 'image', data: img });
  }

  // Formulas
  const formulas = page.formulas || [];
  for (const fm of formulas) {
    const y = safe(() => fm.bbox.y0, 0);
    elements.push({ y, type: 'formula', data: fm });
  }

  // Horizontal and vertical rules from drawn lines
  const drawnLines = page.drawnLines || [];
  const pageWidth = safe(() => page.dimensions.width, 595); // default A4 width
  for (const line of drawnLines) {
    if (line.isVertical) {
      const lineSpan = Math.abs(
        safe(() => line.end.y, 0) - safe(() => line.start.y, 0)
      );
      // Only include vertical lines that are reasonably tall (> 5% page height)
      const pageHeight = safe(() => page.dimensions.height, 842);
      if (lineSpan > pageHeight * 0.05) {
        const y = safe(() => Math.min(line.start.y, line.end.y), 0);
        elements.push({ y, type: 'vrule', data: line });
      }
      continue;
    }
    if (!line.isHorizontal) continue;
    const lineSpan = Math.abs(
      safe(() => line.end.x, 0) - safe(() => line.start.x, 0)
    );
    if (lineSpan < pageWidth * HRULE_WIDTH_FRACTION) continue;
    const y = safe(() => line.start.y, 0);
    elements.push({ y, type: 'hrule', data: line });
  }

  // Sort by Y position (ascending — top-to-bottom)
  elements.sort((a, b) => a.y - b.y);

  // ── Page-level column grouping ─────────────────────────────────────────
  // If the page has multiple detected columns, group consecutive paragraph
  // elements that span different columns into column_block structures.
  // This prevents left-sidebar and right-content paragraphs from interleaving.
  const columns = page.columns || [];
  if (columns.length > 1) {
    const getElementXCenter = (elem) => {
      if (elem.type !== 'paragraph' || !elem.data.lines || !elem.data.lines[0]) return null;
      const items = elem.data.lines[0].items;
      if (!items || items.length === 0) return null;
      const x0 = items[0].transform[4];
      const lastItem = items[items.length - 1];
      const x1 = lastItem.transform[4] + (lastItem.width || 0);
      return (x0 + x1) / 2;
    };

    const getColumnIdx = (xCenter) => {
      if (xCenter === null) return -1;
      for (let c = 0; c < columns.length; c++) {
        if (xCenter >= columns[c].x0 && xCenter <= columns[c].x1) return c;
      }
      // Closest column
      let best = 0, minDist = Infinity;
      for (let c = 0; c < columns.length; c++) {
        const dist = Math.min(Math.abs(xCenter - columns[c].x0), Math.abs(xCenter - columns[c].x1));
        if (dist < minDist) { minDist = dist; best = c; }
      }
      return best;
    };

    // Identify runs of consecutive paragraph elements that span multiple columns
    const grouped = [];
    let runStart = -1;
    let runCols = new Set();

    const flushRun = (endExclusive) => {
      if (runStart < 0) return;
      const runElements = elements.slice(runStart, endExclusive);
      const paraElems = runElements.filter(e => e.type === 'paragraph');
      
      // Check if this run actually spans multiple columns
      const colSet = new Set();
      for (const pe of paraElems) {
        colSet.add(getColumnIdx(getElementXCenter(pe)));
      }
      
      if (colSet.size > 1) {
        // Build a column_block from these paragraphs
        const colData = columns.map((col, idx) => ({
          width: col.x1 - col.x0,
          paragraphs: paraElems
            .filter(pe => getColumnIdx(getElementXCenter(pe)) === idx)
            .map(pe => pe.data)
        }));

        // Only form a column block if each column has enough paragraphs
        // to justify a multi-column layout (prevents false positives)
        const minParasPerCol = 4;
        const allColsHaveContent = colData.every(c => c.paragraphs.length >= minParasPerCol);
        
        if (allColsHaveContent) {
          // Also collect non-paragraph elements in this run (hrules, images, etc.)
          const nonParaElems = runElements.filter(e => e.type !== 'paragraph');
          
          // Insert the column block at the run's Y position
          const blockY = runElements[0].y;
          grouped.push({ y: blockY, type: 'column_block', data: {
            type: 'column_block',
            columns: colData,
            count: columns.length
          }});
          
          // Add non-paragraph elements after the column block
          grouped.push(...nonParaElems);
        } else {
          // Not enough content per column — keep elements as-is
          grouped.push(...runElements);
        }
      } else {
        // Single column — keep elements as-is
        grouped.push(...runElements);
      }
    };

    for (let i = 0; i < elements.length; i++) {
      const elem = elements[i];
      
      if (elem.type === 'paragraph' || elem.type === 'column_block') {
        if (elem.type === 'column_block') {
          // Already a column block — flush any current run and pass through
          flushRun(i);
          runStart = -1;
          runCols.clear();
          grouped.push(elem);
          continue;
        }
        
        const colIdx = getColumnIdx(getElementXCenter(elem));
        
        if (runStart < 0) {
          runStart = i;
          runCols = new Set([colIdx]);
        } else {
          runCols.add(colIdx);
        }
      } else {
        // Non-paragraph element — include in current run if one is active,
        // otherwise pass through directly
        if (runStart < 0) {
          grouped.push(elem);
        }
        // If run is active, the element will be included when run is flushed
      }
    }
    // Flush final run
    flushRun(elements.length);

    return grouped;
  }

  return elements;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a single DOCX section from one page of data.
 *
 * @param {object} page - Page data object.
 * @param {number} pageIndex - Zero‑based page index.
 * @param {number} totalPages - Total number of pages (for section type logic).
 * @returns {object} A section descriptor for the Document constructor.
 */
function buildSection(page, pageIndex, totalPages) {
  const dims = page.dimensions || { width: 595.28, height: 841.89, orientation: 'portrait' };
  const margins = page.margins || { top: 72, right: 72, bottom: 72, left: 72 };

  let headerMargin = Math.min(36, margins.top ? margins.top / 2 : 36);
  const headerParas = page.headers || [];
  let topY = Infinity;
  if (headerParas.length > 0) {
    const fs = safe(() => headerParas[0].lines[0].items[0].style.fontSize, 12);
    const headerY = getItemY(headerParas[0].lines[0]);
    if (headerY > 0) topY = headerY - fs;
  }
  if (page.headerImages && page.headerImages.length > 0) {
    const imgY = Math.min(...page.headerImages.map(img => safe(() => img.bbox.y0, Infinity)));
    if (imgY > 0 && imgY < topY) topY = imgY;
  }
  if (topY !== Infinity) {
    headerMargin = topY;
  }

  let footerMargin = Math.min(36, margins.bottom ? margins.bottom / 2 : 36);
  const footerParas = page.footers || [];
  let bottomY = -Infinity;
  if (footerParas.length > 0) {
    const lastLine = footerParas[footerParas.length - 1].lines[footerParas[footerParas.length - 1].lines.length - 1];
    const fs = safe(() => lastLine.items[0].style.fontSize, 12);
    const footerY = getItemY(lastLine);
    if (footerY > 0) bottomY = footerY + (fs * 0.3);
  }
  if (page.footerImages && page.footerImages.length > 0) {
    const imgY1 = Math.max(...page.footerImages.map(img => safe(() => img.bbox.y1, -Infinity)));
    if (imgY1 !== -Infinity && imgY1 > bottomY) bottomY = imgY1;
  }
  if (bottomY !== -Infinity && bottomY > 0) {
    const distFromBottom = dims.height - bottomY;
    if (distFromBottom > 0) footerMargin = distFromBottom;
  }

  // ── Section properties ──────────────────────────────────────────────────
  const sectionProperties = {
    page: {
      size: {
        width: ptsToTwips(dims.width),
        height: ptsToTwips(dims.height)
      },
      margin: {
        top: ptsToTwips(margins.top),
        right: ptsToTwips(margins.right),
        bottom: ptsToTwips(Math.max(0, margins.bottom - 24)),
        left: ptsToTwips(margins.left),
        header: ptsToTwips(headerMargin),
        footer: ptsToTwips(footerMargin)
      }
    }
  };

  if (pageIndex > 0) {
    sectionProperties.type = SectionType.NEXT_PAGE;
  }

  const section = {
    properties: sectionProperties,
    children: []
  };

  // ── Headers ─────────────────────────────────────────────────────────────
  const headerChildren = [];
  if (headerParas.length > 0) {
    for (let i = 0; i < headerParas.length; i++) {
      const para = headerParas[i];
      const spacing = calculateSpacing(para, i === 0 ? null : { type: 'paragraph', data: headerParas[i - 1] }, margins);
      if (i === 0) spacing.before = 0;
      headerChildren.push(buildParagraph(para, spacing, dims.width, margins));
    }
  }
  if (page.headerImages && page.headerImages.length > 0) {
    headerChildren.push(...page.headerImages.map(img => buildImageParagraph(img)));
  }
  if (headerChildren.length > 0) {
    section.headers = { default: new Header({ children: headerChildren }) };
  }

  // ── Footers ─────────────────────────────────────────────────────────────
  const footerChildren = [];
  if (footerParas.length > 0) {
    for (let i = 0; i < footerParas.length; i++) {
      const para = footerParas[i];
      const spacing = calculateSpacing(para, i === 0 ? null : { type: 'paragraph', data: footerParas[i - 1] }, margins);
      if (i === 0) spacing.before = 0;
      footerChildren.push(buildParagraph(para, spacing, dims.width, margins));
    }
  }
  if (page.footerImages && page.footerImages.length > 0) {
    footerChildren.push(...page.footerImages.map(img => buildImageParagraph(img)));
  }
  if (footerChildren.length > 0) {
    section.footers = { default: new Footer({ children: footerChildren }) };
  }

  // ── Body children (interleaved by Y position) ──────────────────────────
  const elements = collectAndSortElements(page);
  const children = [];

  for (let i = 0; i < elements.length; i++) {
    const elem = elements[i];
    
    let prevElemWrapper = null;
    for (let j = i - 1; j >= 0; j--) {
      if (elements[j].type === 'hrule' || elements[j].type === 'vrule' || (elements[j].type === 'image' && elements[j].data.isFloating)) {
        continue;
      }
      prevElemWrapper = elements[j];
      break;
    }

    switch (elem.type) {
      case 'paragraph':
        children.push(buildParagraph(elem.data, calculateSpacing(elem.data, prevElemWrapper, margins), dims.width, margins));
        break;

      case 'column_block':
        children.push(buildColumnBlockTable(elem.data, dims, margins));
        break;

      case 'table': {
        const tableOrParagraph = buildTable(elem.data);
        children.push(tableOrParagraph);
        break;
      }

      case 'image':
        children.push(buildImageParagraph(elem.data));
        break;

      case 'formula':
        children.push(buildFormulaParagraph(elem.data));
        break;

      case 'hrule':
        children.push(buildHorizontalRule(elem.data));
        break;

      case 'vrule':
        children.push(buildVerticalRule(elem.data, { ...dims, margins }));
        break;

      default:
        break;
    }
  }

  if (children.length === 0) {
    children.push(new Paragraph({ children: [] }));
  }

  section.children = children;
  return section;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a DOCX Blob from an array of structured page data objects.
 *
 * Each page is rendered as its own DOCX section with correct page size,
 * orientation, margins, headers, footers, and body content. Content elements
 * (paragraphs, tables, images, formulas, horizontal rules) are interleaved
 * in reading order based on their Y‑coordinates.
 *
 * @param {object[]} pages - Array of page data objects (see module docs for schema).
 * @param {string} docId - Unique identifier for the document title.
 * @param {Array<{name: string, data: Uint8Array}>} [embeddedFonts=[]] - Optional array of extracted fonts.
 * @returns {Promise<Blob>} A Promise resolving to a Blob of the generated .docx file.
 *
 * @example
 * const blob = await buildDocx(pages);
 * downloadDocx(blob, 'output.docx');
 */
export async function buildDocx(pages, docId = '1', embeddedFonts = []) {
  const safePages = Array.isArray(pages) ? pages : [];

  if (safePages.length === 0) {
    // Produce a minimal valid DOCX with a single empty page
    const doc = new Document({
      sections: [{
        properties: {},
        children: [new Paragraph({ children: [new TextRun({ text: '' })] })]
      }]
    });
    return Packer.toBlob(doc);
  }

  const sections = pages.map((page, idx) => buildSection(page, idx, pages.length));
  
  const bgElements = pages[0]?.backgroundElements || [];
  const bgColor = bgElements.find(e => e.type === 'color');
  let background = undefined;
  if (bgColor) {
    background = { color: rgbToHex(bgColor.color) };
  }

  const doc = new Document({
    creator: 'PDF-DOCX Converter',
    title: `Document ${docId}`,
    background,
    sections
  });

  const baseBlob = await Packer.toBlob(doc);
  return await injectFontsIntoDocx(baseBlob, embeddedFonts);
}

/**
 * Generates a valid UUID v4.
 * @returns {string} UUID string
 */
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Obfuscates a font buffer according to ECMA-376 (DOCX Font Obfuscation).
 * @param {Uint8Array} fontData - The raw font data
 * @param {string} uuid - The UUID string used as the fontKey
 * @returns {Uint8Array} The obfuscated font data
 */
function obfuscateFont(fontData, uuid) {
  // Parse UUID into 16 bytes
  const cleanUuid = uuid.replace(/[{}-]/g, '').toLowerCase();
  const uuidBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    uuidBytes[i] = parseInt(cleanUuid.substring(i * 2, i * 2 + 2), 16);
  }
  
  // Create 32-byte obfuscation key by reversing 16 bytes and repeating
  const key = new Uint8Array(32);
  for (let i = 0; i < 16; i++) {
    key[i] = uuidBytes[15 - i];
    key[i + 16] = uuidBytes[15 - i];
  }
  
  // XOR the first 32 bytes of the font data
  const obfuscated = new Uint8Array(fontData);
  const limit = Math.min(32, obfuscated.length);
  for (let i = 0; i < limit; i++) {
    obfuscated[i] ^= key[i];
  }
  
  return obfuscated;
}

/**
 * Manually injects font streams into the DOCX ZIP structure.
 * 
 * @param {Blob} docxBlob 
 * @param {Array<{name: string, data: Uint8Array}>} fonts 
 * @returns {Promise<Blob>}
 */
async function injectFontsIntoDocx(docxBlob, fonts) {
  if (!fonts || fonts.length === 0) return docxBlob;
  
  try {
    const zip = await JSZip.loadAsync(docxBlob);
    let rIdCounter = 1000;
    
    // Ensure odttf is in [Content_Types].xml
    let contentTypes = await zip.file('[Content_Types].xml').async('string');
    if (!contentTypes.includes('Extension="odttf"')) {
      contentTypes = contentTypes.replace('</Types>', '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>');
      zip.file('[Content_Types].xml', contentTypes);
    }
    
    const fontIdMap = {};
    for (const font of fonts) {
      if (!font.data || !font.name) continue;
      const rId = `rIdFont${rIdCounter++}`;
      const fontKey = `{${generateUUID().toUpperCase()}}`;
      
      fontIdMap[font.name] = { rId, fontKey, data: font.data };
      const fontFileName = `font${rIdCounter}.odttf`;
      
      // Obfuscate font data
      const obfuscatedData = obfuscateFont(font.data, fontKey);
      
      zip.file(`word/fonts/${fontFileName}`, obfuscatedData);
      
      let relsXml = '';
      const relsFile = zip.file('word/_rels/fontTable.xml.rels');
      if (relsFile) {
        relsXml = await relsFile.async('string');
      } else {
        relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      }
      
      const relEntry = `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${fontFileName}"/>`;
      if (relsXml.includes('</Relationships>')) {
        relsXml = relsXml.replace('</Relationships>', `${relEntry}</Relationships>`);
      } else if (relsXml.includes('/>')) {
        relsXml = relsXml.replace('/>', `>${relEntry}</Relationships>`);
      }
      zip.file('word/_rels/fontTable.xml.rels', relsXml);
    }
    
    let fontTableXml = '';
    const fontTableFile = zip.file('word/fontTable.xml');
    if (fontTableFile) {
      fontTableXml = await fontTableFile.async('string');
    } else {
      fontTableXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:fonts xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:fonts>';
    }
    
    for (const [name, info] of Object.entries(fontIdMap)) {
      // Derive altName by stripping suffixes and standardizing names
      let altName = name.replace(/-(Bold|Italic|Regular|Light|Medium|SemiBold|BoldItalic|Black|Heavy|Thin|ExtraLight|ExtraBold|Condensed|Expanded).*/i, '').replace(/,.*/, '').trim();
      if (altName === 'CenturySchoolbook') altName = 'Century Schoolbook';
      else if (altName === 'TimesNewRoman' || altName === 'TimesNewRomanPSMT') altName = 'Times New Roman';
      else if (altName === 'CourierNew' || altName === 'CourierNewPSMT') altName = 'Courier New';
      else if (altName === 'ComicSansMS') altName = 'Comic Sans MS';
      else if (altName === 'ArialMT') altName = 'Arial';

      const altNameElement = (altName !== name) ? `<w:altName w:val="${altName}"/>` : '';
      const panoseHex = extractPanoseFromTTF(info.data);
      const panoseElement = panoseHex ? `<w:panose1 w:val="${panoseHex}"/>` : '';
      const fontEntry = `<w:font w:name="${name}">${altNameElement}${panoseElement}<w:embedRegular r:id="${info.rId}" w:fontKey="${info.fontKey}"/></w:font>`;
      
      if (fontTableXml.includes('</w:fonts>')) {
         fontTableXml = fontTableXml.replace('</w:fonts>', `${fontEntry}</w:fonts>`);
      } else if (fontTableXml.includes('/>')) {
         fontTableXml = fontTableXml.replace('/>', `>${fontEntry}</w:fonts>`);
      }
    }
    zip.file('word/fontTable.xml', fontTableXml);
    
    return await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  } catch (e) {
    console.error('[Font Injector] Failed to inject fonts:', e);
    return docxBlob;
  }
}

/**
 * Extracts the 10-byte PANOSE-1 metrics from a TTF/OTF font buffer.
 * 
 * @param {Uint8Array} fontData - The raw TrueType/OpenType font stream.
 * @returns {string|null} The 10-byte PANOSE string formatted as uppercase hex, or null if invalid.
 */
function extractPanoseFromTTF(fontData) {
    if (!fontData || !(fontData instanceof Uint8Array) || fontData.length < 12) {
        return null;
    }

    try {
        const dataView = new DataView(fontData.buffer, fontData.byteOffset, fontData.byteLength);
        const numTables = dataView.getUint16(4, false);

        if (fontData.length < 12 + numTables * 16) {
            return null;
        }

        let os2Offset = null;
        let os2Length = 0;

        for (let i = 0; i < numTables; i++) {
            const recordOffset = 12 + i * 16;
            if (dataView.getUint32(recordOffset, false) === 0x4F532F32) {
                os2Offset = dataView.getUint32(recordOffset + 8, false);
                os2Length = dataView.getUint32(recordOffset + 12, false);
                break;
            }
        }

        if (os2Offset === null || os2Length < 42 || os2Offset + 42 > fontData.length) {
            return null;
        }

        let panoseHex = '';
        const panoseOffset = os2Offset + 32;
        
        for (let i = 0; i < 10; i++) {
            const byte = dataView.getUint8(panoseOffset + i);
            panoseHex += byte.toString(16).padStart(2, '0').toUpperCase();
        }

        return panoseHex;

    } catch (error) {
        return null;
    }
}

/**
 * Trigger a browser file download for a DOCX Blob.
 *
 * @param {Blob} blob - The DOCX Blob produced by {@link buildDocx}.
 * @param {string} [filename='document.docx'] - Desired filename for the download.
 */
export function downloadDocx(blob, filename = 'document.docx') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
