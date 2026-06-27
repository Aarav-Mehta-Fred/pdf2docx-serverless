/**
 * @fileoverview Main Application Controller for PDF-to-DOCX Converter
 *
 * Orchestrates the full conversion pipeline:
 *   1. PDF parsing via PDF.js
 *   2. Scan detection → OCR via Tesseract.js (if needed)
 *   3. AI layout analysis via layout-worker.js (YOLO ONNX)
 *   4. Heuristic refinement via heuristics.js
 *   5. Specialized AI routing via specialist-worker.js (tables, formulas)
 *   6. Reading order assembly + style extraction
 *   7. DOCX generation via docx-builder.js
 *
 * @module app
 */

// ─────────────────────────────────────────────────────────────────────────────
// CDN Imports
// ─────────────────────────────────────────────────────────────────────────────

import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.mjs';

import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

import { PDFDocument, PDFName, PDFDict, PDFRawStream, decodePDFRawStream } from 'https://esm.sh/pdf-lib@1.17.1';


// ─────────────────────────────────────────────────────────────────────────────
// Local Imports
// ─────────────────────────────────────────────────────────────────────────────

import {
  runFullHeuristicPipeline,
  extractPageDimensions,
  extractStyles,
  mergeResults,
  groupIntoLines,
  groupIntoParagraphs
} from './heuristics.js';

import { buildDocx, downloadDocx } from './docx-builder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Scale used when rendering PDF pages to canvas for AI analysis */
const RENDER_SCALE = 1.5;

// Global storage for AI debug mode
const debugPagesData = {};

const STAGES = [
  { id: 'parse',      label: 'Parsing PDF & Fonts' },
  { id: 'scan',       label: 'Scan Detection & OCR' },
  { id: 'layout',     label: 'AI Layout Analysis' },
  { id: 'heuristics', label: 'Heuristic Refinement' },
  { id: 'routing',    label: 'Specialized AI Routing' },
  { id: 'order',      label: 'Reading Order & Styles' },
  { id: 'docx',       label: 'Generating DOCX' }
];

// ─────────────────────────────────────────────────────────────────────────────
// DOM References
// ─────────────────────────────────────────────────────────────────────────────

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('pdf-upload');
const folderInput = document.getElementById('folder-upload');
const convertBtn = document.getElementById('convert-btn');
const dropIcon = document.getElementById('drop-icon');
const dropText = document.getElementById('drop-text');
const dropSubtext = document.getElementById('drop-subtext');

const queuePanel = document.getElementById('queue-panel');
const queueList = document.getElementById('queue-list');
const queueActions = document.getElementById('queue-actions');
const downloadAllBtn = document.getElementById('download-all-btn');
const downloadZipBtn = document.getElementById('download-zip-btn');
const messageBox = document.getElementById('message-box');

// Hardware and settings
const hwCores = document.getElementById('hw-cores');
const hwRam = document.getElementById('hw-ram');
const hwGpu = document.getElementById('hw-gpu');
const loadedModelsContainer = document.getElementById('loaded-models-container');
const modelsListContainer = document.getElementById('models-list-container');
const debugCanvas = document.getElementById('pdf-canvas');
const canvasPlaceholder = document.getElementById('canvas-placeholder');

// State
let stagedFiles = [];
let conversionQueueCount = 0;
let completedCount = 0;
const completedFiles = []; // To store downloaded blobs
let modelsLoading = false;
let currentDebugFileIndex = -1;
let currentDebugPage = -1;
let currentDebugNumPages = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Workers & Queue
// ─────────────────────────────────────────────────────────────────────────────

let docPriorityCounter = 0;

/** @type {Worker|null} */
let specialistWorker = null;

// ─────────────────────────────────────────────────────────────────────────────
// UI Helpers
// ─────────────────────────────────────────────────────────────────────────────

function showMessage(text, type) {
    messageBox.textContent = text;
    messageBox.className = `message-box ${type}`;
    messageBox.classList.remove('hidden');
    setTimeout(() => { messageBox.classList.add('hidden'); }, 5000);
}

function updateQueueItem(id, progress, text, isError = false) {
    const bar = document.getElementById(`bar-${id}`);
    const status = document.getElementById(`status-${id}`);
    const stage = document.getElementById(`stage-${id}`);
    
    // Cap at 10% during model loading
    let displayProgress = progress;
    if (modelsLoading && progress > 10) {
        displayProgress = 10;
        text = 'Waiting for AI models…';
    }
    
    if (bar) bar.style.width = `${displayProgress}%`;
    if (status) status.textContent = `${Math.round(displayProgress)}%`;
    if (stage) stage.textContent = text;
    
    if (isError && bar) {
        bar.style.backgroundColor = 'var(--error-txt)';
        if (stage) stage.textContent = 'error: ' + text;
    }
}

function completeQueueItem(id, blob, filename) {
    const bar = document.getElementById(`bar-${id}`);
    const status = document.getElementById(`status-${id}`);
    const dlIcon = document.getElementById(`dl-${id}`);
    const stage = document.getElementById(`stage-${id}`);
    
    if (stage) stage.textContent = 'done';
    if (status) status.style.display = 'none';
    if (dlIcon) dlIcon.classList.add('ready');
    if (bar) bar.style.backgroundColor = 'var(--success-txt)';
    if (dlIcon) dlIcon.style.pointerEvents = 'auto';
    
    completedCount++;
    completedFiles.push({ blob, filename });
    updateDownloadButtons();
    
    if (dlIcon) {
        dlIcon.addEventListener('click', () => {
            downloadDocx(blob, filename);
        });
    }
}

function updateDownloadButtons() {
    if (completedCount > 0) {
        queueActions.classList.remove('hidden');
        let shadows = [];
        const maxLayers = 3;
        const layers = Math.min(completedCount, maxLayers);
        for (let i = 0; i < layers; i++) {
            if (i === 0) shadows.push(`3px 3px 0px var(--border)`);
            else {
                const gap = 3 + (i * 4) - 2;
                const border = 3 + (i * 4);
                shadows.push(`${gap}px ${gap}px 0px var(--bg-base)`);
                shadows.push(`${border}px ${border}px 0px var(--border)`);
            }
        }
        const stackShadow = shadows.join(', ');
        downloadAllBtn.style.boxShadow = stackShadow;
        downloadZipBtn.style.boxShadow = stackShadow;
        const lift = (layers - 1) * 2;
        downloadAllBtn.style.transform = `translate(-${lift}px, -${lift}px)`;
        downloadZipBtn.style.transform = `translate(-${lift}px, -${lift}px)`;
        
        if (completedCount < conversionQueueCount) {
            downloadAllBtn.textContent = `Download ${completedCount}/${conversionQueueCount} files`;
        } else {
            downloadAllBtn.textContent = `Download All`;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker Management & Queuing
// ─────────────────────────────────────────────────────────────────────────────

class LayoutWorkerPool {
    constructor() {
        this.size = 0;
        this.workers = [];
        this.idleWorkers = [];
        this.queue = [];
        this.ready = false;
    }
    
    setPoolSize(newSize) {
        this.size = newSize;
    }

    async init(itemId) {
        if (this.ready && this.workers.length >= this.size) return true;
        
        const initPromises = [];
        const toCreate = this.size - this.workers.length;
        
        for (let i = 0; i < toCreate; i++) {
            const worker = new Worker('./js/layout-worker.js', { type: 'module' });
            this.workers.push(worker);
            
            initPromises.push(new Promise((resolve, reject) => {
                const handler = (e) => {
                    if (e.data.type === 'init_progress') {
                        if (i === 0 && itemId) updateQueueItem(itemId, 5 + e.data.progress * 0.1, e.data.stage);
                    } else if (e.data.type === 'ready') {
                        worker.removeEventListener('message', handler);
                        this.idleWorkers.push(worker);
                        resolve();
                        this.pump();
                    } else if (e.data.type === 'error') {
                        worker.removeEventListener('message', handler);
                        console.warn(`[layout-worker] Init error:`, e.data.message);
                        reject(new Error(e.data.message));
                    }
                };
                worker.addEventListener('message', handler);
                worker.onerror = (err) => { console.warn('[layout-worker] Worker error:', err); };
                worker.postMessage({ type: 'init' });
            }));
        }
        
        try {
            await Promise.all(initPromises);
            this.ready = true;
            return true;
        } catch (err) {
            console.warn('[layout-worker] Failed to init pool:', err);
            return false;
        }
    }

    analyze(imageData, width, height, pageId) {
        return new Promise((resolve) => {
            if (!this.ready || this.workers.length === 0) return resolve([]);
            this.queue.push({ imageData, width, height, pageId, resolve });
            this.pump();
        });
    }

    pump() {
        if (this.queue.length === 0 || this.idleWorkers.length === 0) return;
        const task = this.queue.shift();
        const worker = this.idleWorkers.shift();
        
        const handler = (e) => {
            if (e.data.pageId !== task.pageId) return; 
            worker.removeEventListener('message', handler);
            
            if (e.data.type === 'result') {
                task.resolve(e.data.boxes);
            } else if (e.data.type === 'error') {
                console.warn('[layout-worker]', e.data.message);
                task.resolve([]);
            }
            this.idleWorkers.push(worker);
            this.pump();
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ type: 'analyze', imageData: task.imageData, width: task.width, height: task.height, pageId: task.pageId });
    }
}

const layoutPool = new LayoutWorkerPool();

class PageTaskQueue {
    constructor() {
        this.concurrencyLimit = 1;
        this.activeTasks = 0;
        this.queue = [];
    }
    
    setConcurrency(limit) {
        this.concurrencyLimit = limit;
        layoutPool.setPoolSize(limit);
        this.pump();
    }

    enqueue(docIndex, pageNum, taskFn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ docIndex, pageNum, taskFn, resolve, reject });
            this.queue.sort((a, b) => {
                if (a.docIndex !== b.docIndex) return a.docIndex - b.docIndex;
                return a.pageNum - b.pageNum;
            });
            this.pump();
        });
    }

    pump() {
        while (this.activeTasks < this.concurrencyLimit && this.queue.length > 0) {
            const task = this.queue.shift();
            this.activeTasks++;
            task.taskFn()
                .then(task.resolve)
                .catch(task.reject)
                .finally(() => {
                    this.activeTasks--;
                    this.pump();
                });
        }
    }
}

const globalPageQueue = new PageTaskQueue();

/**
 * Initialise the specialist AI Web Worker (lazy — created once on first use).
 */
function ensureSpecialistWorker() {
  if (specialistWorker) return;
  try {
    specialistWorker = new Worker('./js/specialist-worker.js', { type: 'module' });
    specialistWorker.onerror = (err) => {
      console.warn('[specialist-worker] Error:', err);
    };
  } catch (err) {
    console.warn('[specialist-worker] Failed to create:', err);
  }
}

/**
 * Send a table image to the specialist worker for structure recognition.
 * @param {Uint8ClampedArray} imageData
 * @param {number} width
 * @param {number} height
 * @param {string} id - Correlation ID
 * @returns {Promise<Array>} Table detections
 */
function recognizeTable(imageData, width, height, id) {
  return new Promise((resolve) => {
    ensureSpecialistWorker();
    if (!specialistWorker) { resolve([]); return; }

    const handler = (e) => {
      if (e.data.id !== id) return;
      specialistWorker.removeEventListener('message', handler);

      if (e.data.type === 'table_result') resolve(e.data.detections || []);
      else {
        console.warn('[specialist-worker] Table error:', e.data.message);
        resolve([]);
      }
    };

    specialistWorker.addEventListener('message', handler);
    specialistWorker.postMessage({ type: 'recognize_table', imageData, width, height, id });
  });
}

/**
 * Send a formula image to the specialist worker for LaTeX extraction.
 * @param {Uint8ClampedArray} imageData
 * @param {number} width
 * @param {number} height
 * @param {string} id - Correlation ID
 * @returns {Promise<string>} LaTeX string
 */
function recognizeFormula(imageData, width, height, id) {
  return new Promise((resolve) => {
    ensureSpecialistWorker();
    if (!specialistWorker) { resolve(''); return; }

    const handler = (e) => {
      if (e.data.id !== id) return;
      specialistWorker.removeEventListener('message', handler);

      if (e.data.type === 'formula_result') resolve(e.data.latex || '');
      else {
        console.warn('[specialist-worker] Formula error:', e.data.message);
        resolve('');
      }
    };

    specialistWorker.addEventListener('message', handler);
    specialistWorker.postMessage({ type: 'recognize_formula', imageData, width, height, id });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Extraction Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Try to extract a raw image from the PDF page's resources.
 * If the image exists as an embedded object, return its bytes.
 * Otherwise return null (caller will render from canvas).
 *
 * @param {object} page - PDF.js page proxy
 * @param {string} imageName - The XObject name (e.g., 'Im0')
 * @returns {Promise<{ data: Uint8Array, width: number, height: number }|null>}
 */
async function extractEmbeddedImage(page, imageName) {
  try {
    const opList = await page.getOperatorList();
    // PDF.js doesn't directly expose image data from getOperatorList.
    // We'd need page.objs or commonObjs — but these are internal.
    // Fallback to canvas rendering approach.
    return null;
  } catch {
    return null;
  }
}

/**
 * Crop a region from a rendered canvas and return PNG bytes.
 *
 * @param {HTMLCanvasElement} canvas - The rendered page canvas
 * @param {{ x0: number, y0: number, x1: number, y1: number }} bbox - Region to crop
 * @returns {{ data: Uint8Array, width: number, height: number }|null}
 */
function cropCanvasRegion(canvas, bbox) {
  try {
    const x = Math.max(0, Math.floor(bbox.x0));
    const y = Math.max(0, Math.floor(bbox.y0));
    const w = Math.min(canvas.width - x, Math.ceil(bbox.x1 - bbox.x0));
    const h = Math.min(canvas.height - y, Math.ceil(bbox.y1 - bbox.y0));

    if (w < 2 || h < 2) return null;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = w;
    cropCanvas.height = h;
    const ctx = cropCanvas.getContext('2d');
    ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);

    // Convert to PNG blob synchronously via data URL
    const dataUrl = cropCanvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return { data: bytes, width: w, height: h };
  } catch {
    return null;
  }
}

/**
 * Get ImageData (raw RGBA pixels) from a canvas region, for sending to workers.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ x0: number, y0: number, x1: number, y1: number }} bbox
 * @returns {{ imageData: Uint8ClampedArray, width: number, height: number }|null}
 */
function getCanvasRegionImageData(canvas, bbox) {
  try {
    const x = Math.max(0, Math.floor(bbox.x0));
    const y = Math.max(0, Math.floor(bbox.y0));
    const w = Math.min(canvas.width - x, Math.ceil(bbox.x1 - bbox.x0));
    const h = Math.min(canvas.height - y, Math.ceil(bbox.y1 - bbox.y0));
    if (w < 2 || h < 2) return null;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(x, y, w, h);
    return { imageData: imgData.data, width: w, height: h };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Font Extraction (pdf-lib)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dynamically checks if a font is available on the user's device.
 * It uses the Canvas API to measure text width and compares it
 * against fallback system fonts.
 * @param {string} fontName 
 * @returns {boolean} True if the font is available locally
 */
function isFontAvailableLocally(fontName) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const testString = 'abcdefghijklmnopqrstuvwxyz0123456789';
  
  // Baseline metrics
  context.font = '72px monospace';
  const monoWidth = context.measureText(testString).width;
  
  context.font = '72px sans-serif';
  const sansWidth = context.measureText(testString).width;
  
  context.font = '72px serif';
  const serifWidth = context.measureText(testString).width;
  
  // Test metrics
  context.font = `72px "${fontName}", monospace`;
  const testMono = context.measureText(testString).width;
  
  context.font = `72px "${fontName}", sans-serif`;
  const testSans = context.measureText(testString).width;
  
  context.font = `72px "${fontName}", serif`;
  const testSerif = context.measureText(testString).width;
  
  // If ANY of the test widths differ from their baseline, the font successfully loaded
  return testMono !== monoWidth || testSans !== sansWidth || testSerif !== serifWidth;
}

/**
 * Extracts raw font streams from the PDF.
 * @param {ArrayBuffer} arrayBuffer - The PDF file buffer
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
async function extractEmbeddedFonts(arrayBuffer) {
  const fonts = [];
  try {
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const context = pdfDoc.context;
    const indirectObjects = context.enumerateIndirectObjects();
    
    for (const [ref, obj] of indirectObjects) {
      if (obj instanceof PDFDict) {
        const type = obj.get(PDFName.of('Type'));
        if (type === PDFName.of('Font')) {
          const baseFont = obj.get(PDFName.of('BaseFont'));
          const fontDescriptorRef = obj.get(PDFName.of('FontDescriptor'));
          if (fontDescriptorRef) {
            const fontDescriptor = context.lookup(fontDescriptorRef);
            if (fontDescriptor && fontDescriptor instanceof PDFDict) {
               const fontFile2Ref = fontDescriptor.get(PDFName.of('FontFile2')); // TrueType
               const fontFile3Ref = fontDescriptor.get(PDFName.of('FontFile3')); // OpenType/CFF
               const streamRef = fontFile2Ref || fontFile3Ref;
               
               if (streamRef) {
                 const stream = context.lookup(streamRef);
                 if (stream instanceof PDFRawStream) {
                   const decoded = decodePDFRawStream(stream).decode();
                   let rawName = baseFont ? baseFont.value() : 'Unknown';
                   if (rawName.startsWith('/')) rawName = rawName.substring(1);
                   let cleanName = rawName.includes('+') ? rawName.split('+')[1] : rawName;
                   
                   let hasOS2 = false;
                   if (decoded.length >= 12) {
                     const numTables = (decoded[4] << 8) | decoded[5];
                     for (let i = 0; i < numTables; i++) {
                       const offset = 12 + i * 16;
                       if (offset + 4 > decoded.length) break;
                       const tag = String.fromCharCode(decoded[offset], decoded[offset+1], decoded[offset+2], decoded[offset+3]);
                       if (tag === 'OS/2') {
                         hasOS2 = true;
                         break;
                       }
                     }
                   }

                    if (!hasOS2) {
                      console.log(`[Font Extractor] Warning: ${cleanName} lacks an OS/2 table. Passing down anyway for PANOSE extraction fallback.`);
                    }
                    fonts.push({ name: cleanName, data: new Uint8Array(decoded) });
                 }
               }
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Font Extractor] Failed to extract fonts:', err);
  }
  return fonts;
}

// ─────────────────────────────────────────────────────────────────────────────
// OCR (Tesseract.js) — Lazy loaded
// ─────────────────────────────────────────────────────────────────────────────

/** @type {any} Tesseract worker instance */
let tesseractWorker = null;

/**
 * Run OCR on a canvas to extract text with per-character bounding boxes.
 * Lazily loads Tesseract.js on first call.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Array>} Array of pseudo text items compatible with heuristics
 */
async function runOCR(canvas) {
  try {
    if (!tesseractWorker) {
      const { createWorker } = await import(
        'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js'
      );
      tesseractWorker = await createWorker('eng');
    }

    const { data } = await tesseractWorker.recognize(canvas);

    // Convert Tesseract output to PDF.js-like text items
    const items = [];
    if (data.words) {
      for (const word of data.words) {
        const { x0, y0, x1, y1 } = word.bbox;
        const fontSize = Math.max(8, y1 - y0);
        items.push({
          str: word.text,
          transform: [fontSize, 0, 0, fontSize, x0, y1], // [scaleX, 0, 0, scaleY, tx, ty]
          width: x1 - x0,
          height: fontSize,
          fontName: 'OCR-detected',
          dir: 'ltr'
        });
      }
    }

    return items;
  } catch (err) {
    console.warn('[OCR] Tesseract failed:', err);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a PDF file through the full conversion pipeline.
 * @param {File} file - The uploaded PDF file
 * @param {string} itemId - The queue item ID
 */
async function processPDF(file, itemId, docIndex) {
  let docxBlob = null;

  try {
    // ── Stage 1: Parse PDF ──────────────────────────────────────────────
    updateQueueItem(itemId, 2, 'Loading PDF…');

    const arrayBuffer = await file.arrayBuffer();
    const fontBuffer = arrayBuffer.slice(0);
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;

    updateQueueItem(itemId, 4, 'Extracting fonts…');
    const embeddedFonts = await extractEmbeddedFonts(fontBuffer);

    updateQueueItem(itemId, 8, `PDF loaded — ${numPages} page(s)`);

    // ── Init AI Worker ─────────
    updateQueueItem(itemId, 10, 'Loading AI layout model…');

    modelsLoading = true;
    const aiReady = await layoutPool.init(itemId);
    modelsLoading = false;
    if (!aiReady) {
      throw new Error('AI layout model unavailable.');
    }

    // ── Process each page ───────────────────────────────────────────────
    const allPages = [];
    const pageTimings = {};
    const pageProgress = {};
    
    const updatePageProgress = (pageNum, progress, text) => {
      pageProgress[pageNum] = progress;
      let totalProgress = 0;
      for (let i = 1; i <= numPages; i++) {
        totalProgress += pageProgress[i] || 0;
      }
      updateQueueItem(itemId, 10 + (totalProgress / (numPages * 100)) * 82, text);
    };

    const processPage = async (pageNum) => {
      pageTimings[pageNum] = {};
      let stageStart = Date.now();
      
      updatePageProgress(pageNum, 5, `Processing page ${pageNum} of ${numPages}…`);

      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const baseViewport = page.getViewport({ scale: 1.0 });
      const pageDims = extractPageDimensions([0, 0, baseViewport.width, baseViewport.height]);

      // Render page to canvas
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport }).promise;

      // ── Stage 2: Scan Detection & OCR ─────────────────────────────────
      stageStart = Date.now();
      const textContent = await page.getTextContent();
      let spatialItems = textContent.items.filter(it => it.str && it.str.trim());
      let isScanned = false;

      if (spatialItems.length < 5) {
        isScanned = true;
        updatePageProgress(pageNum, 8, `Page ${pageNum}: Running OCR…`);
        const ocrItems = await runOCR(canvas);
        if (ocrItems.length > 0) {
          spatialItems = ocrItems;
        }
      }

      pageTimings[pageNum]['Scan/OCR'] = Date.now() - stageStart;
      // ── Stage 3: AI Layout Analysis ───────────────────────────────────
      stageStart = Date.now();
      let aiBoxes = [];
      if (aiReady) {
        updatePageProgress(pageNum, 10, `Page ${pageNum}: AI layout analysis…`);

        const fullImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        aiBoxes = await layoutPool.analyze(
          fullImageData.data, canvas.width, canvas.height, pageNum
        );
      }

      // Scale AI boxes back to 1.0x coordinates
      const aiBoxes1x = aiBoxes.map(b => ({
        ...b,
        x0: b.x0 / RENDER_SCALE,
        y0: b.y0 / RENDER_SCALE,
        x1: b.x1 / RENDER_SCALE,
        y1: b.y1 / RENDER_SCALE
      }));

      pageTimings[pageNum]['Layout'] = Date.now() - stageStart;
      // ── Stage 4: Heuristic Refinement ─────────────────────────────────
      stageStart = Date.now();
      updatePageProgress(pageNum, 80, `Page ${pageNum}: Heuristic analysis…`);
      const ops = await page.getOperatorList();
      const annotations = await page.getAnnotations();

      const trueFontNames = {};
      await Promise.all(Object.keys(textContent.styles).map(fn => new Promise(resolve => {
        try {
          page.commonObjs.get(fn, (font) => {
            if (font && font.name) {
              let cleanName = font.name;
              if (cleanName.includes('+')) cleanName = cleanName.split('+')[1];
              trueFontNames[fn] = cleanName;
            }
            resolve();
          });
        } catch(e) { resolve(); }
      })));

      const heuristicResult = runFullHeuristicPipeline(
        { 
          items: spatialItems, 
          styles: textContent.styles,
          embeddedFonts: embeddedFonts.filter(f => f.data !== null).map(f => f.name),
          trueFontNames,
          annotations
        }, 
        ops, 
        baseViewport, 
        aiBoxes1x, 
        canvas, 
        RENDER_SCALE
      );

      pageTimings[pageNum]['Heuristics'] = Date.now() - stageStart;
      // ── Stage 5: Specialized AI Routing ───────────────────────────────
      stageStart = Date.now();
      updatePageProgress(pageNum, 90, `Page ${pageNum}: Specialized analysis…`);

      const tables = [];
      const formulas = [];
      const images = [];
      const mergedBoxes = heuristicResult.mergedBoxes || [];
      const drawnLines = heuristicResult.drawnLines || [];

      const checkHasLines = (box, lines) => {
        if (!lines || !lines.length) return false;
        const padding = 2;
        for (const line of lines) {
          const minX = Math.min(line.start.x, line.end.x) - padding;
          const maxX = Math.max(line.start.x, line.end.x) + padding;
          const minY = Math.min(line.start.y, line.end.y) - padding;
          const maxY = Math.max(line.start.y, line.end.y) + padding;
          if (minX <= box.x1 && maxX >= box.x0 && minY <= box.y1 && maxY >= box.y0) return true;
        }
        return false;
      };

      for (let bi = 0; bi < mergedBoxes.length; bi++) {
        const box = mergedBoxes[bi];
        const canvasBox = {
          x0: box.x0 * RENDER_SCALE, y0: box.y0 * RENDER_SCALE,
          x1: box.x1 * RENDER_SCALE, y1: box.y1 * RENDER_SCALE
        };

        if (box.label === 'formula') {
          const region = getCanvasRegionImageData(canvas, canvasBox);
          if (region) {
            const formulaId = `formula_p${pageNum}_${bi}`;
            const latex = await recognizeFormula(region.imageData, region.width, region.height, formulaId);
            formulas.push({ bbox: box, latex });
          }
        } else if (box.label === 'table') {
          if (box.confidence >= 0.5 || checkHasLines(box, drawnLines)) {
            const region = getCanvasRegionImageData(canvas, canvasBox);
            if (region) {
              const tableId = `table_p${pageNum}_${bi}`;
              const detections = await recognizeTable(region.imageData, region.width, region.height, tableId);
              const tableTextItems = heuristicResult.body.filter(item => {
                const tx = item.transform[4];
                const ty = item.transform[5];
                return tx >= box.x0 && tx <= box.x1 && ty >= box.y0 && ty <= box.y1;
              });
              
              if (detections && detections.length > 0) {
                for (const d of detections) {
                  if (d.box) {
                    d.box.xmin = (d.box.xmin / RENDER_SCALE) + box.x0;
                    d.box.xmax = (d.box.xmax / RENDER_SCALE) + box.x0;
                    d.box.ymin = (d.box.ymin / RENDER_SCALE) + box.y0;
                    d.box.ymax = (d.box.ymax / RENDER_SCALE) + box.y0;
                  }
                }
                const tableImage = cropCanvasRegion(canvas, canvasBox);
                tables.push({
                  bbox: box, detections, textItems: tableTextItems, imageData: tableImage ? tableImage.data : null
                });
              } else if (tableTextItems.length > 0) {
                const lines = groupIntoLines(tableTextItems);
                const paras = groupIntoParagraphs(lines, 2.0, baseViewport.width, heuristicResult.margins);
                paras.forEach(p => p.label = 'text');
                heuristicResult.paragraphs.push(...paras);
                heuristicResult.paragraphs.sort((a, b) => {
                  const yA = a.lines && a.lines.length > 0 ? Math.min(...a.lines.map(l => l.y)) : 0;
                  const yB = b.lines && b.lines.length > 0 ? Math.min(...b.lines.map(l => l.y)) : 0;
                  return yA - yB;
                });
              }
            }
          }
        } else if (box.label === 'chart') {
          if (box.confidence >= 0.5 || checkHasLines(box, drawnLines)) {
            let imageResult = null;
            const embImg = heuristicResult.images.find(img => Math.abs(img.x - box.x0) < 20 && Math.abs(img.y - box.y0) < 20);
            if (embImg) imageResult = await extractEmbeddedImage(page, embImg.name);
            if (!imageResult) imageResult = cropCanvasRegion(canvas, canvasBox);
            if (imageResult) images.push({ bbox: box, data: imageResult.data, width: imageResult.width, height: imageResult.height });
          }
        } else if (box.label === 'image' || box.label === 'header_image' || box.label === 'footer_image' || box.label === 'seal' || box.label === 'icon') {
          let imageResult = null;
          const embImg = heuristicResult.images.find(img => Math.abs(img.x - box.x0) < 20 && Math.abs(img.y - box.y0) < 20);
          if (embImg) imageResult = await extractEmbeddedImage(page, embImg.name);
          if (!imageResult) imageResult = cropCanvasRegion(canvas, canvasBox);
          if (imageResult) images.push({ bbox: box, data: imageResult.data, width: imageResult.width, height: imageResult.height });
        }
      }

      // Append any unassigned images from heuristics that were missed by AI
      for (const hImg of heuristicResult.images) {
        // Check if this image is already inside an AI box
        const hx = hImg.x;
        const hy = hImg.y;
        const alreadyExtracted = images.some(extImg => {
          if (!extImg.bbox) return false;
          return hx >= (extImg.bbox.x0 - 20) && hx <= (extImg.bbox.x1 + 20) &&
                 hy >= (extImg.bbox.y0 - 20) && hy <= (extImg.bbox.y1 + 20);
        });
        
        if (!alreadyExtracted) {
          const canvasBox = {
            x0: hImg.x * RENDER_SCALE,
            y0: hImg.y * RENDER_SCALE,
            x1: (hImg.x + hImg.width) * RENDER_SCALE,
            y1: (hImg.y + hImg.height) * RENDER_SCALE
          };
          const imageResult = cropCanvasRegion(canvas, canvasBox);
          if (imageResult) {
            images.push({
              bbox: { x0: hx, y0: hy, x1: hx + hImg.width, y1: hy + hImg.height },
              data: imageResult.data,
              width: imageResult.width,
              height: imageResult.height
            });
          }
        }
      }

      pageTimings[pageNum]['Routing'] = Date.now() - stageStart;
      // ── Stage 6: Reading Order & Styles ───────────────────────────────
      stageStart = Date.now();
      updatePageProgress(pageNum, 97, `Page ${pageNum}: Assembling output…`);

      // Save debug page data
      if (debugCanvas) {
        if (!debugPagesData[docIndex]) {
          debugPagesData[docIndex] = {
            numPages: numPages,
            pages: {}
          };
          
          // Add to dropdown
          const docSelect = document.getElementById('debug-doc-select');
          if (docSelect) {
            if (docSelect.options.length === 1 && docSelect.options[0].value === "") {
                docSelect.innerHTML = '';
            }
            const opt = document.createElement('option');
            opt.value = docIndex;
            opt.textContent = file.name;
            docSelect.appendChild(opt);
          }
        }
        
        // Save canvas image data and AI boxes
        debugPagesData[docIndex].pages[pageNum] = {
          canvas: canvas,
          boxes: aiBoxes1x,
          width: canvas.width,
          height: canvas.height
        };
        
        // Auto-render if this is the first page of the first document we see
        if (currentDebugFileIndex === -1 && pageNum === 1) {
          currentDebugFileIndex = docIndex;
          currentDebugPage = 1;
          currentDebugNumPages = numPages;
          renderDebugPage(docIndex, pageNum);
          
          const docSelect = document.getElementById('debug-doc-select');
          if (docSelect) {
              docSelect.value = docIndex;
          }
        }
      }

      pageTimings[pageNum]['Order/Styles'] = Date.now() - stageStart;
      console.log(`[Page ${pageNum} Timings]:`, pageTimings[pageNum]);
      
      updatePageProgress(pageNum, 100, `Finished page ${pageNum}`);
      
      // ── Assign small icons to inlineImages ────────────────────────
      const allParas = [
        ...(heuristicResult.headers || []),
        ...(heuristicResult.paragraphs || []),
        ...(heuristicResult.footers || [])
      ];
      
      const unassignedImages = [];
      for (const img of images) {
        if (!img.bbox) {
          unassignedImages.push(img);
          continue;
        }
        const w = img.bbox.x1 - img.bbox.x0;
        const h = img.bbox.y1 - img.bbox.y0;
        if (w > 0 && w < 60 && h > 0 && h < 60) {
          const imgCenterY = (img.bbox.y0 + img.bbox.y1) / 2;
          let bestPara = null;
          let minDist = 30;
          for (const para of allParas) {
            if (!para.lines) continue;
            for (const line of para.lines) {
              const lineY = line.y || (line.items && line.items.length > 0 ? line.items[0].transform[5] : 0);
              const dist = Math.abs(imgCenterY - lineY);
              if (dist < minDist) {
                minDist = dist;
                bestPara = para;
              }
            }
          }
          if (bestPara) {
            if (!bestPara.inlineImages) bestPara.inlineImages = [];
            bestPara.inlineImages.push(img);
            continue;
          }
        }
        unassignedImages.push(img);
      }
      images.length = 0;
      images.push(...unassignedImages);

      // ── Assemble page data ───────────────────────────────────────
      return {
        pageNum,
        dimensions: pageDims,
        margins: heuristicResult.margins,
        columns: heuristicResult.columns,
        headers: heuristicResult.headers,
        footers: heuristicResult.footers,
        headerBottomY: heuristicResult.headerBottomY,
        footerTopY: heuristicResult.footerTopY,
        body: heuristicResult.body,
        paragraphs: heuristicResult.paragraphs,
        tables,
        formulas,
        images,
        drawnLines: heuristicResult.drawnLines,
        backgroundElements: heuristicResult.backgroundElements
      };
    };

    const pagePromises = [];
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        pagePromises.push(globalPageQueue.enqueue(docIndex, pageNum, () => processPage(pageNum)));
    }

    const completedPages = await Promise.all(pagePromises);
    completedPages.sort((a, b) => a.pageNum - b.pageNum);
    allPages.push(...completedPages);

    // ── Stage 7: DOCX Generation ──────────────────────────────────────
    updateQueueItem(itemId, 92, 'Generating DOCX…');

    docxBlob = await buildDocx(allPages, '1', embeddedFonts);

    updateQueueItem(itemId, 100, 'done');
    const name = file.name.replace(/\.pdf$/i, '.docx');
    completeQueueItem(itemId, docxBlob, name);

  } catch (error) {
    console.error('Pipeline error:', error);
    updateQueueItem(itemId, 100, error.message, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Handlers & Initialization (from new UI)
// ─────────────────────────────────────────────────────────────────────────────

function profileHardware() {
    const cores = navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} Cores` : 'Unknown';
    const ram = navigator.deviceMemory ? `~${navigator.deviceMemory} GB` : 'Unknown';
    const gpu = navigator.gpu ? 'Available' : 'Not Supported';

    if(hwCores) hwCores.textContent = cores;
    if(hwRam) hwRam.textContent = ram;
    if(hwGpu) hwGpu.textContent = gpu;

    if (navigator.deviceMemory && navigator.deviceMemory < 4) {
        console.warn("Low memory detected. AI fallback inference may be slow.");
    }
}

function updateDropzoneUI(files) {
    stagedFiles = Array.from(files);
    if (stagedFiles.length > 1) {
        dropText.textContent = `${stagedFiles.length} valid files selected`;
        dropSubtext.innerHTML = 'Ready for batch conversion';
    } else if (stagedFiles.length === 1) {
        dropText.textContent = stagedFiles[0].name;
        dropSubtext.innerHTML = 'Ready to convert';
    } else {
        dropText.textContent = 'Drag & Drop PDFs, ZIPs or Folders';
        dropSubtext.innerHTML = 'Click to browse <span class="browse-link" id="browse-files-btn">files</span> or <span class="browse-link" id="browse-folders-btn">folders</span>';
        document.getElementById('browse-files-btn').addEventListener('click', () => fileInput.click());
        document.getElementById('browse-folders-btn').addEventListener('click', () => folderInput.click());
    }
}

async function traverseEntry(entry, fileList) {
    if (entry.isFile) {
        return new Promise(resolve => {
            entry.file(f => { fileList.push(f); resolve(); });
        });
    } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        return new Promise(resolve => {
            dirReader.readEntries(async entries => {
                const promises = entries.map(e => traverseEntry(e, fileList));
                await Promise.all(promises);
                resolve();
            });
        });
    }
}

function setupEventListeners() {
    // Hook up browse links
    const browseFilesBtn = document.getElementById('browse-files-btn');
    const browseFoldersBtn = document.getElementById('browse-folders-btn');
    if(browseFilesBtn) browseFilesBtn.addEventListener('click', () => fileInput.click());
    if(browseFoldersBtn) browseFoldersBtn.addEventListener('click', () => folderInput.click());
    
    if(dropzone) {
        dropzone.addEventListener('click', (e) => {
            if(e.target === dropzone || e.target === dropText || e.target === dropIcon) {
                fileInput.click();
            }
        });

        // Drag and drop events
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropzone.addEventListener(eventName, e => {
                e.preventDefault(); e.stopPropagation();
            }, false);
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropzone.addEventListener(eventName, (e) => {
                dropzone.classList.add('dragover');
                let hasFolder = false;
                if (e.dataTransfer.items) {
                    for (let i = 0; i < e.dataTransfer.items.length; i++) {
                        if (e.dataTransfer.items[i].kind === 'file' && !e.dataTransfer.items[i].type) {
                            hasFolder = true;
                        }
                    }
                }
                dropIcon.textContent = hasFolder ? '📁' : '📄';
            }, false);
        });

        ['dragleave'].forEach(eventName => {
            dropzone.addEventListener(eventName, () => {
                dropzone.classList.remove('dragover');
                dropIcon.textContent = '📄';
            }, false);
        });

        dropzone.addEventListener('drop', async e => {
            dropzone.classList.remove('dragover');
            dropIcon.textContent = '📄';
            
            let files = [];
            if (e.dataTransfer.items) {
                const promises = [];
                for (let i = 0; i < e.dataTransfer.items.length; i++) {
                    const item = e.dataTransfer.items[i];
                    if (item.kind === 'file') {
                        const entry = item.webkitGetAsEntry();
                        if (entry) promises.push(traverseEntry(entry, files));
                    }
                }
                await Promise.all(promises);
            } else {
                files = Array.from(e.dataTransfer.files);
            }
            
            if (files.length > 0) {
                const valid = files.filter(f => f.name.toLowerCase().endsWith('.pdf') || f.name.toLowerCase().endsWith('.zip'));
                updateDropzoneUI(valid);
            }
        });
    }

    if(fileInput) fileInput.addEventListener('change', function() { updateDropzoneUI(this.files); });
    if(folderInput) folderInput.addEventListener('change', function() { 
        const validFiles = Array.from(this.files).filter(f => f.name.toLowerCase().endsWith('.pdf') || f.name.toLowerCase().endsWith('.zip'));
        updateDropzoneUI(validFiles); 
    });

    if(convertBtn) {
        convertBtn.addEventListener('click', () => {
            if (!stagedFiles || stagedFiles.length === 0) {
                showMessage('Please select at least one document, ZIP, or folder.', 'error');
                return;
            }

            queuePanel.classList.remove('hidden');
            
            let docIndex = docPriorityCounter;
            
            stagedFiles.forEach(async (file, index) => {
                if (file.name.toLowerCase().endsWith('.pdf')) {
                    const currentDocIndex = docIndex++;
                    setTimeout(() => processFileToQueue(file, currentDocIndex), index * 250);
                } else if (file.name.toLowerCase().endsWith('.zip')) {
                    try {
                        const zip = new JSZip();
                        const loadedZip = await zip.loadAsync(file);
                        let pdfIndex = 0;
                        loadedZip.forEach((relativePath, zipEntry) => {
                            if (!zipEntry.dir && zipEntry.name.toLowerCase().endsWith('.pdf')) {
                                zipEntry.async('blob').then(blob => {
                                    const extractedFile = new File([blob], zipEntry.name, { type: 'application/pdf' });
                                    const currentDocIndex = docIndex++;
                                    setTimeout(() => processFileToQueue(extractedFile, currentDocIndex), (index + pdfIndex) * 250);
                                    pdfIndex++;
                                });
                            }
                        });
                    } catch(err) {
                        showMessage('Failed to extract ZIP: ' + err.message, 'error');
                    }
                }
            });
            
            docPriorityCounter = docIndex;
            
            stagedFiles = [];
            fileInput.value = '';
            folderInput.value = '';
            updateDropzoneUI([]);
        });
    }

    if(downloadAllBtn) {
        downloadAllBtn.addEventListener('click', () => {
            completedFiles.forEach(({blob, filename}) => {
                downloadDocx(blob, filename);
            });
        });
    }
    
    if(downloadZipBtn) {
        downloadZipBtn.addEventListener('click', async () => {
            if(completedFiles.length === 0) return;
            showMessage('Preparing ZIP...', 'success');
            const zip = new JSZip();
            completedFiles.forEach(({blob, filename}) => {
                zip.file(filename, blob);
            });
            const content = await zip.generateAsync({type:'blob'});
            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'converted_docs.zip';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }
}

function processFileToQueue(file, docIndex) {
    const ext = file.name.split('.').pop().toLowerCase();
    const icon = ext === 'zip' ? '📦' : '📄';
    const itemId = `item-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    
    const queueHTML = `
        <div class="queue-item" id="${itemId}">
            <div class="q-filename" title="${file.name}">> <span id="stage-${itemId}">waiting</span>: ${icon} <span id="name-${itemId}"></span><span id="cursor-${itemId}" class="typing-cursor">█</span></div>
            <div class="q-progress-wrap"><div class="q-progress-bar" id="bar-${itemId}"></div></div>
            <div class="q-status" id="status-${itemId}">0%</div>
            <div class="q-download-icon" id="dl-${itemId}" title="Download Result">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </div>
        </div>
    `;
    queueList.insertAdjacentHTML('beforeend', queueHTML);
    conversionQueueCount++;
    updateDownloadButtons();
    
    const nameEl = document.getElementById(`name-${itemId}`);
    const cursorEl = document.getElementById(`cursor-${itemId}`);
    let charIndex = 0;
    const typeWriter = setInterval(() => {
        if (charIndex < file.name.length) {
            nameEl.textContent += file.name.charAt(charIndex);
            charIndex++;
        } else {
            clearInterval(typeWriter);
            if (cursorEl) cursorEl.remove();
            document.getElementById(`stage-${itemId}`).textContent = 'initializing';
            // Start the actual conversion!
            processPDF(file, itemId, docIndex);
        }
    }, 30);
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug Rendering & Model Caching
// ─────────────────────────────────────────────────────────────────────────────

function renderDebugPage(fileIndex, pageNum) {
    if (!debugPagesData[fileIndex] || !debugPagesData[fileIndex].pages[pageNum]) return;
    
    const pageData = debugPagesData[fileIndex].pages[pageNum];
    const canvasInfo = document.getElementById('debug-page-info');
    const prevBtn = document.getElementById('debug-prev-btn');
    const nextBtn = document.getElementById('debug-next-btn');
    
    if (canvasInfo) canvasInfo.textContent = `Page ${pageNum} of ${currentDebugNumPages}`;
    if (prevBtn) prevBtn.disabled = (pageNum <= 1);
    if (nextBtn) nextBtn.disabled = (pageNum >= currentDebugNumPages);
    
    if (debugCanvas) {
        debugCanvas.width = pageData.width;
        debugCanvas.height = pageData.height;
        const ctx = debugCanvas.getContext('2d');
        
        // Draw the PDF page
        ctx.drawImage(pageData.canvas, 0, 0);
        
        // Colors for AI box labels
        const colors = {
            text: 'rgba(34,197,94,0.3)',
            table: 'rgba(59,130,246,0.3)',
            image: 'rgba(168,85,247,0.3)',
            formula: 'rgba(249,115,22,0.3)',
            header: 'rgba(236,72,153,0.3)',
            footer: 'rgba(107,114,128,0.3)',
            chart: 'rgba(239,68,68,0.3)'
        };
        
        // Draw AI boxes
        pageData.boxes.forEach(box => {
            const x = box.x0 * RENDER_SCALE;
            const y = box.y0 * RENDER_SCALE;
            const w = (box.x1 - box.x0) * RENDER_SCALE;
            const h = (box.y1 - box.y0) * RENDER_SCALE;
            const color = colors[box.label] || 'rgba(255,255,255,0.3)';
            
            ctx.strokeStyle = color.replace('0.3', '1.0');
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w, h);
            
            ctx.fillStyle = '#fff';
            ctx.font = '12px "Courier New"';
            ctx.textBaseline = 'top';
            // Background pill for text
            const textWidth = ctx.measureText(`${box.label} ${(box.confidence * 100).toFixed(0)}%`).width;
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillRect(x, y, textWidth + 4, 16);
            ctx.fillStyle = '#fff';
            ctx.fillText(`${box.label} ${(box.confidence * 100).toFixed(0)}%`, x + 2, y + 2);
        });
        
        if (canvasPlaceholder) canvasPlaceholder.style.display = 'none';
    }
}

async function checkModelCacheStatus(checkboxId, statusId, url, cacheName) {
    const statusEl = document.getElementById(statusId);
    const checkbox = document.getElementById(checkboxId);
    if (!statusEl || !checkbox) return;
    
    try {
        const cache = await caches.open(cacheName);
        const match = await cache.match(url);
        if (match) {
            statusEl.textContent = 'Cached';
            statusEl.className = 'model-cache-status cached';
            checkbox.checked = true;
        } else {
            statusEl.textContent = 'Not cached';
            statusEl.className = 'model-cache-status not-cached';
            checkbox.checked = false;
        }
    } catch (e) {
        statusEl.textContent = 'Error checking cache';
    }
}

async function handleModelCacheToggle(e, statusId, wrapId, progressId) {
    const checkbox = e.target;
    const url = checkbox.dataset.modelUrl;
    const cacheName = checkbox.dataset.cacheName;
    const statusEl = document.getElementById(statusId);
    const wrapEl = document.getElementById(wrapId);
    const progressEl = document.getElementById(progressId);
    
    if (checkbox.checked) {
        // Download and cache
        checkbox.disabled = true;
        wrapEl.classList.remove('hidden');
        statusEl.textContent = 'Downloading...';
        statusEl.className = 'model-cache-status not-cached';
        
        try {
            const cache = await caches.open(cacheName);
            const response = await fetch(url);
            
            if (!response.ok) throw new Error('Fetch failed');
            
            const contentLength = response.headers.get('content-length');
            if (contentLength && response.body) {
                const total = parseInt(contentLength, 10);
                let loaded = 0;
                
                const reader = response.body.getReader();
                const chunks = [];
                
                while(true) {
                    const {done, value} = await reader.read();
                    if (done) break;
                    
                    chunks.push(value);
                    loaded += value.length;
                    
                    const pct = Math.round((loaded / total) * 100);
                    progressEl.style.width = `${pct}%`;
                }
                
                // Reconstruct response
                const blob = new Blob(chunks);
                const newResponse = new Response(blob, {
                    headers: response.headers
                });
                await cache.put(url, newResponse);
                
            } else {
                // No length info
                progressEl.style.width = '100%';
                const cloned = response.clone();
                await cache.put(url, cloned);
            }
            
            statusEl.textContent = 'Cached';
            statusEl.className = 'model-cache-status cached';
        } catch (err) {
            statusEl.textContent = 'Download failed';
            checkbox.checked = false;
        } finally {
            checkbox.disabled = false;
            wrapEl.classList.add('hidden');
            progressEl.style.width = '0%';
        }
        
    } else {
        // Delete from cache
        try {
            const cache = await caches.open(cacheName);
            await cache.delete(url);
            statusEl.textContent = 'Not cached';
            statusEl.className = 'model-cache-status not-cached';
        } catch(err) {
            console.error(err);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    profileHardware();
    setupEventListeners();

    const docSelect = document.getElementById('debug-doc-select');
    if (docSelect) {
        docSelect.addEventListener('change', (e) => {
            const newIndex = parseInt(e.target.value, 10);
            if (!isNaN(newIndex) && debugPagesData[newIndex]) {
                currentDebugFileIndex = newIndex;
                currentDebugNumPages = debugPagesData[newIndex].numPages;
                currentDebugPage = 1;
                renderDebugPage(currentDebugFileIndex, currentDebugPage);
            }
        });
    }

    const prevBtn = document.getElementById('debug-prev-btn');
    const nextBtn = document.getElementById('debug-next-btn');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (currentDebugPage > 1) {
                currentDebugPage--;
                renderDebugPage(currentDebugFileIndex, currentDebugPage);
            }
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (currentDebugPage < currentDebugNumPages) {
                currentDebugPage++;
                renderDebugPage(currentDebugFileIndex, currentDebugPage);
            }
        });
    }

    const models = [
        { id: 'cache-layout-model', status: 'layout-model-status', wrap: 'layout-model-progress-wrap', bar: 'layout-model-progress' },
        { id: 'cache-table-model', status: 'table-model-status', wrap: 'table-model-progress-wrap', bar: 'table-model-progress' },
        { id: 'cache-formula-enc-model', status: 'formula-enc-model-status', wrap: 'formula-enc-model-progress-wrap', bar: 'formula-enc-model-progress' },
        { id: 'cache-formula-dec-model', status: 'formula-dec-model-status', wrap: 'formula-dec-model-progress-wrap', bar: 'formula-dec-model-progress' }
    ];

    models.forEach(m => {
        const checkbox = document.getElementById(m.id);
        if (checkbox) {
            checkModelCacheStatus(m.id, m.status, checkbox.dataset.modelUrl, checkbox.dataset.cacheName);
            checkbox.addEventListener('change', (e) => handleModelCacheToggle(e, m.status, m.wrap, m.bar));
        }
    });
    
    // Setup Worker Pool Size logic
    const poolSlider = document.getElementById('pool-size-slider');
    const poolDisplay = document.getElementById('pool-size-display');
    const recDisplay = document.getElementById('recommended-pool-size');
    const autoRec = Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) * 0.75));
    
    if (recDisplay) recDisplay.textContent = autoRec;
    
    function applyPoolSize() {
        let val = parseInt(poolSlider.value, 10);
        if (val === 0) {
            poolDisplay.textContent = 'Auto';
            globalPageQueue.setConcurrency(autoRec);
        } else {
            poolDisplay.textContent = val;
            globalPageQueue.setConcurrency(val);
        }
    }

    if (poolSlider) {
        const saved = localStorage.getItem('workerPoolSize');
        if (saved !== null) poolSlider.value = saved;
        applyPoolSize();
        
        poolSlider.addEventListener('input', () => {
            applyPoolSize();
            localStorage.setItem('workerPoolSize', poolSlider.value);
        });
    } else {
        globalPageQueue.setConcurrency(autoRec);
    }
    
    // Setup Theme and Dev Mode listeners
    const themeBtn = document.getElementById('theme-toggle-btn');
    if(themeBtn) {
        let isLightMode = false;
        themeBtn.addEventListener('click', () => {
            isLightMode = !isLightMode;
            if (isLightMode) {
                document.body.classList.add('light-mode');
                themeBtn.textContent = '🌙 Dark Mode';
            } else {
                document.body.classList.remove('light-mode');
                themeBtn.textContent = '💡 Light Mode';
            }
        });
    }

    const devModeToggle = document.getElementById('dev-mode-toggle');
    const systemPanel = document.getElementById('system-info-panel');
    const behindScenesPanel = document.getElementById('behind-scenes-panel');
    if(devModeToggle) {
        devModeToggle.addEventListener('change', (e) => {
            if (e.target.checked) {
                if(systemPanel) systemPanel.classList.remove('hidden');
                if(behindScenesPanel) behindScenesPanel.classList.remove('hidden');
            } else {
                if(systemPanel) systemPanel.classList.add('hidden');
                if(behindScenesPanel) behindScenesPanel.classList.add('hidden');
            }
        });
    }

    const openBtn = document.getElementById('open-settings-btn');
    const closeBtn = document.getElementById('close-settings-btn');
    const modal = document.getElementById('settings-modal');
    if(openBtn && closeBtn && modal) {
        openBtn.addEventListener('click', () => modal.classList.remove('hidden'));
        closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
        modal.addEventListener('click', (e) => {
            if(e.target === modal) modal.classList.add('hidden');
        });
    }
});
