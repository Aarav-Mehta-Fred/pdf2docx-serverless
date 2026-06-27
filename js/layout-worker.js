/**
 * @fileoverview Web Worker for YOLOv10m document layout analysis using ONNX Runtime Web.
 *
 * This worker performs AI-based document layout detection on rendered PDF pages.
 * It uses a YOLOv10m model fine-tuned on the DocLayNet dataset to identify
 * structural elements such as text blocks, tables, figures, headers, and more.
 *
 * @module layout-worker
 *
 * @message-protocol
 *   Inbound:
 *     - { type: 'init' }                                                    — Download/cache model, create ONNX session
 *     - { type: 'analyze', imageData, width, height, pageId }               — Run inference on a page image
 *   Outbound:
 *     - { type: 'init_progress', stage, progress }                          — Model loading progress
 *     - { type: 'ready' }                                                   — Model loaded and session created
 *     - { type: 'result', boxes, pageId }                                   — Detection results
 *     - { type: 'error', message, pageId? }                                 — Error report
 */

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.all.mjs';

// ---------------------------------------------------------------------------
// ONNX Runtime configuration
// ---------------------------------------------------------------------------

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {string[]} ppu-doclayout class labels in alphabetical order */
const LABELS = [
  "abstract",
  "algorithm",
  "aside_text",
  "chart",
  "content",
  "display_formula",
  "doc_title",
  "figure_title",
  "footer",
  "footer_image",
  "footnote",
  "formula_number",
  "header",
  "header_image",
  "image",
  "inline_formula",
  "number",
  "paragraph_title",
  "reference",
  "reference_content",
  "seal",
  "table",
  "text",
  "vertical_text",
  "vision_footnote",
];

/** @type {number} Model input resolution (square) */
const INPUT_SIZE = 800;

/** @type {number} Minimum confidence score to accept a detection */
const CONF_THRESHOLD = 0.20;

/** @type {number} IoU threshold for Non-Maximum Suppression */
const IOU_THRESHOLD = 0.45;

/** @type {string} Local or CDN URL for the ONNX model */
const MODEL_URL =
  '../models/ppu-doclayout.onnx'; // Place the .onnx file in a 'models' directory

/** @type {string} Cache API store name for persisting the model binary */
const MODEL_CACHE_NAME = 'pdf-docx-models-v2';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {ort.InferenceSession|null} */
let session = null;

// ---------------------------------------------------------------------------
// Model loading & session creation
// ---------------------------------------------------------------------------

/**
 * Download (or retrieve from Cache API) the ONNX model binary.
 *
 * On the first call the model is fetched from HuggingFace with progress
 * tracking and then stored in the Cache API so subsequent loads are instant.
 *
 * @returns {Promise<ArrayBuffer>} Raw model bytes
 */
async function loadModel() {
  const cache = await caches.open(MODEL_CACHE_NAME);
  let response = await cache.match(MODEL_URL);

  if (!response) {
    // ------ First-time download with progress ------
    self.postMessage({
      type: 'init_progress',
      stage: 'Downloading AI model (~50 MB)…',
      progress: 0
    });

    const fetchResponse = await fetch(MODEL_URL);

    if (!fetchResponse.ok) {
      throw new Error(
        `Model download failed: ${fetchResponse.status} ${fetchResponse.statusText}`
      );
    }

    // Try to stream progress if Content-Length is available
    const contentLength = Number(fetchResponse.headers.get('Content-Length'));
    let modelBuffer;

    if (contentLength && fetchResponse.body) {
      const reader = fetchResponse.body.getReader();
      const chunks = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const pct = Math.round((received / contentLength) * 100);
        self.postMessage({
          type: 'init_progress',
          stage: 'Downloading AI model (~50 MB)…',
          progress: pct
        });
      }

      // Reassemble into a single ArrayBuffer
      modelBuffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        modelBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // Store in cache (Response must be re-created from the buffer)
      await cache.put(
        MODEL_URL,
        new Response(modelBuffer.buffer, {
          headers: fetchResponse.headers
        })
      );

      return modelBuffer.buffer;
    }

    // Fallback: no streaming progress available
    const cloned = fetchResponse.clone();
    await cache.put(MODEL_URL, cloned);
    modelBuffer = await fetchResponse.arrayBuffer();

    self.postMessage({
      type: 'init_progress',
      stage: 'Downloading AI model (~50 MB)…',
      progress: 100
    });

    return modelBuffer;
  }

  // ------ Cached load ------
  self.postMessage({
    type: 'init_progress',
    stage: 'Loading cached model…',
    progress: 50
  });

  return await response.arrayBuffer();
}

/**
 * Initialise the ONNX inference session.
 *
 * Loads the model binary (from cache or network), then creates an
 * `ort.InferenceSession` with the WASM execution provider.
 *
 * @returns {Promise<void>}
 */
async function init() {
  self.postMessage({
    type: 'init_progress',
    stage: 'Starting model load…',
    progress: 0
  });

  const modelBuffer = await loadModel();

  self.postMessage({
    type: 'init_progress',
    stage: 'Creating inference session…',
    progress: 90
  });

  session = await ort.InferenceSession.create(modelBuffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });

  self.postMessage({
    type: 'init_progress',
    stage: 'Ready',
    progress: 100
  });

  self.postMessage({ type: 'ready' });
}

// ---------------------------------------------------------------------------
// Preprocessing
// ---------------------------------------------------------------------------

/**
 * Resize the source image to INPUT_SIZE×INPUT_SIZE and convert
 * to an NCHW Float32 tensor normalised to [0, 1].
 *
 * PP-DocLayout resizes blindly without letterbox padding.
 *
 * @param {Uint8ClampedArray} imageData - Raw RGBA pixel data of the source image
 * @param {number}            width     - Source image width in pixels
 * @param {number}            height    - Source image height in pixels
 * @returns {{ tensor: Float32Array, scaleX: number, scaleY: number }}
 */
function preprocessImage(imageData, width, height) {
  const canvas = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const ctx = canvas.getContext('2d');

  // Reconstruct an ImageData on an intermediate canvas so we can drawImage
  const sourceCanvas = new OffscreenCanvas(width, height);
  const sourceCtx = sourceCanvas.getContext('2d');
  const imgData = new ImageData(new Uint8ClampedArray(imageData), width, height);
  sourceCtx.putImageData(imgData, 0, 0);

  // Blind resize to INPUT_SIZE x INPUT_SIZE
  ctx.drawImage(sourceCanvas, 0, 0, INPUT_SIZE, INPUT_SIZE);

  // Read back the resized image and convert to NCHW float tensor
  const resized = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  const float32 = new Float32Array(3 * pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const base = i * 4;
    float32[i]                    = resized.data[base]     / 255.0; // R
    float32[pixelCount + i]       = resized.data[base + 1] / 255.0; // G
    float32[2 * pixelCount + i]   = resized.data[base + 2] / 255.0; // B
  }

  const scaleY = INPUT_SIZE / height;
  const scaleX = INPUT_SIZE / width;

  return { tensor: float32, scaleX, scaleY };
}

// ---------------------------------------------------------------------------
// Postprocessing
// ---------------------------------------------------------------------------

/**
 * Compute the Intersection-over-Union of two axis-aligned bounding boxes.
 *
 * @param {{ x0: number, y0: number, x1: number, y1: number }} a - First box
 * @param {{ x0: number, y0: number, x1: number, y1: number }} b - Second box
 * @returns {number} IoU value in [0, 1]
 */
function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);

  if (x0 >= x1 || y0 >= y1) return 0;

  const inter = (x1 - x0) * (y1 - y0);
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);

  return inter / (areaA + areaB - inter);
}

/**
 * Greedy Non-Maximum Suppression.
 *
 * Although YOLOv10 includes built-in NMS, this provides a safety net to
 * remove any residual overlapping detections.
 *
 * @param {{ x0: number, y0: number, x1: number, y1: number, confidence: number, classId: number, label: string }[]} boxes
 * @param {number} threshold - IoU threshold above which boxes are suppressed
 * @returns {typeof boxes} Filtered array of boxes
 */
function nms(boxes, threshold) {
  boxes.sort((a, b) => b.confidence - a.confidence);

  /** @type {typeof boxes} */
  const selected = [];
  const suppressed = new Set();

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;
    selected.push(boxes[i]);

    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j)) continue;
      if (iou(boxes[i], boxes[j]) > threshold) {
        suppressed.add(j);
      }
    }
  }

  return selected;
}

/**
 * Convert raw YOLOv10 output tensor to an array of detection objects in
 * the original image coordinate space.
 *
 * YOLOv10 output shape: [1, num_detections, 6]
 * Each detection: [x1, y1, x2, y2, confidence, class_id]
 *
 * @param {ort.Tensor} output - The model's first output tensor
 * @param {number}     scale  - Letterbox scale factor
 * @param {number}     padX   - Horizontal letterbox padding in pixels
 * @param {number}     padY   - Vertical letterbox padding in pixels
 * @returns {{ x0: number, y0: number, x1: number, y1: number, confidence: number, classId: number, label: string }[]}
 */
function postprocess(output) {
  const data = output.data;
  
  // Handle both [1, N, C] and [N, C] output shapes
  const isBatched = output.dims.length === 3;
  const numDetections = isBatched ? output.dims[1] : output.dims[0];
  const numCols = output.dims[output.dims.length - 1];

  /** @type {{ x0: number, y0: number, x1: number, y1: number, confidence: number, classId: number, label: string }[]} */
  const boxes = [];

  for (let i = 0; i < numDetections; i++) {
    const offset = i * numCols;
    
    // Paddle PP-DocLayout/PicoDet format: [class_id, score, xmin, ymin, xmax, ymax, reading_order, ?]
    const classId = Math.round(data[offset]);
    const confidence = data[offset + 1];

    if (confidence < CONF_THRESHOLD) continue;

    // Paddle detection models internally scale the coordinates back to the original image dimensions.
    // There is no need to reverse any padding or scaling manually!
    const x0 = data[offset + 2];
    const y0 = data[offset + 3];
    const x1 = data[offset + 4];
    const y1 = data[offset + 5];
    
    // Extract the model's baked-in reading order
    const readingOrder = data[offset + 6] || 0;

    boxes.push({
      x0,
      y0,
      x1,
      y1,
      confidence,
      classId,
      readingOrder,
      label: LABELS[classId] || 'Unknown'
    });
  }

  // Filter overlapping boxes using NMS
  const filtered = nms(boxes, IOU_THRESHOLD);
  
  // Sort the final boxes by the model's native reading order
  filtered.sort((a, b) => a.readingOrder - b.readingOrder);

  return filtered;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * Main message handler.
 *
 * Responds to `init` and `analyze` commands from the main thread.
 *
 * @param {MessageEvent} e - Incoming message event
 */
self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'init') {
    try {
      await init();
    } catch (err) {
      self.postMessage({
        type: 'error',
        message: `Init failed: ${err.message}`
      });
    }
    return;
  }

  if (type === 'analyze') {
    const { imageData, width, height, pageId } = e.data;

    if (!session) {
      self.postMessage({
        type: 'error',
        message: 'Session not initialised. Send { type: "init" } first.',
        pageId
      });
      return;
    }

    try {
      // 1. Blind resize preprocess
      const { tensor, scaleX, scaleY } = preprocessImage(imageData, width, height);

      // 2. Build ONNX input tensors
      const inputTensor = new ort.Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      const imShapeTensor = new ort.Tensor('float32', new Float32Array([INPUT_SIZE, INPUT_SIZE]), [1, 2]);
      const scaleFactorTensor = new ort.Tensor('float32', new Float32Array([scaleY, scaleX]), [1, 2]);

      // 3. Run inference
      const feeds = { 
        image: inputTensor, 
        im_shape: imShapeTensor, 
        scale_factor: scaleFactorTensor 
      };
      
      // Some models use 'images' instead of 'image', but PP-DocLayout likely uses 'image'
      // Try both by checking session.inputNames
      if (session.inputNames.includes('images')) {
        feeds.images = inputTensor;
        delete feeds.image;
      }

      const results = await session.run(feeds);

      // 4. Postprocess first output
      const outputName = session.outputNames[0];
      const boxes = postprocess(results[outputName]);

      self.postMessage({ type: 'result', boxes, pageId });
    } catch (err) {
      self.postMessage({
        type: 'error',
        message: `Inference failed: ${err.message}`,
        pageId
      });
    }
    return;
  }

  // Unknown message type
  self.postMessage({
    type: 'error',
    message: `Unknown message type: "${type}"`
  });
};
