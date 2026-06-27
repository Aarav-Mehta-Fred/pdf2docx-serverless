# pdf2docx-serverless

## Overview
**pdf2docx-serverless** is a privacy-first, 100% client-side web application that uses in-browser AI and an advanced heuristic engine to convert complex PDFs into formatted Word documents. Traditional PDF converters either ruin complex layouts or require you to upload highly sensitive documents to a random third-party server. **pdf2docx-serverless** solves both problems. By combining the parsing power of `pdf.js` with WASM-accelerated ONNX AI models running directly in your browser, it reconstructs reading order, tables, formulas, and styling locally. Your files never leave your machine.

## Features
* **Zero-Server Privacy:** 100% of the processing happens in your browser. No backend, no uploads, no data harvesting.
* **AI Layout Analysis:** Utilizes a YOLOv10m model (PP-DocLayout) via WebAssembly to intelligently identify headers, footers, tables, charts, and reading order.
* **Advanced Heuristics Engine:** A custom-built pipeline that analyzes PDF operator lists to extract exact font styles, colors, text alignment, and drawn vector shapes.
* **Specialized AI Routing:** Automatically detects tables and math formulas, routing them to dedicated specialist AI models (PP-StructureV2 and RapidLaTeXOCR) for precise reconstruction.
* **Offline Capable:** AI models (~87MB total) can be cached locally via the browser's Cache API for full offline functionality.
* **Multi-threaded Performance:** Uses a dynamic Web Worker pool to process multiple pages concurrently without freezing the UI.

## Documentation
Curious about how we run multiple machine learning models and parse PDF byte-streams in vanilla JavaScript? Check out our deep dives:

* [Architecture & Data Flow](./docs/architecture.md) - Learn how the pipeline works from upload to `.docx` generation.
* [Contributing Guide](./CONTRIBUTING.md) - How to run the project locally and contribute.

## Try it Out
[Live Demo: pdf2docx-serverless.netlify.app](pdf2docx-serverless.netlify.app)
