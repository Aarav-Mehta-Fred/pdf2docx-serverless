# Contributing to pdf2docx-serverless

First off, thank you for considering contributing to **pdf2docx-serverless**! This project was built to push the boundaries of what is possible within the browser as part of the Youth Code x AI hacathon, and I am thrilled to welcome developers to help me build a truly open-source, privacy-focused document conversion tool.

By contributing, you agree to release your code under the MIT License.

## Table of Contents
* [Architecture Documentation](#architecture-documentation)
* [Getting Started](#getting-started)
* [Future Plans & Roadmap](#future-plans--roadmap)
* [How to Contribute](#how-to-contribute)

## Architecture Documentation
Before diving into the codebase, please review our architectural documentation to understand how the application separates its workloads across the main thread and background workers:

* [Architecture & Data Flow](./docs/ARCHITECTURE.md): Details the 7-stage pipeline, Web Worker pooling, ONNX model integration, and the heuristic engine.

## Getting Started
Because this project relies heavily on Web Workers, ES Modules, and the Cache API, you cannot simply open `index.html` as a local file in your browser due to CORS restrictions.

1. **Clone the repository:** `git clone https://github.com/yourusername/pdf2docx-serverless.git`
2. **Navigate to the directory:** `cd pdf2docx-serverless`
3. **Serve the folder locally:** Use a local web server to serve the files. For example, using Python 3:
   `python -m http.server 8000`
4. **Open the app:** Navigate to `http://localhost:8000` in your browser.

## Future Plans & Roadmap
We are constantly looking to improve the conversion accuracy. If you're looking for a feature to champion, our immediate roadmap includes:

* **Improve Heuristic Capabilities:** Currently large or complex documents confuse the heuristic engine, improving this would greatly imrove conversion capabilites.
* **Enhanced Table Parsing:** Improving the clustering logic in the specialist worker to better handle complex, borderless tables.
* **Memory Optimization:** Fine-tuning the layout worker pool size and canvas memory management to support 100+ page documents on low-RAM devices.
* **Support for other doc formats:** Adding direct support of Google Docs, .odt and .wps would be helpfull.

## How to Contribute

### 1. Reporting Bugs
Open an issue! Please include:
* Your browser, operating system, and hardware specs (RAM/CPU).
* Steps to reproduce the bug.
* Any errors showing in the developer console.
* (If possible and not sensitive) The PDF file that caused the crash.

### 2. Submitting Pull Requests
1. Fork the repository and create your branch from `main`.
2. Ensure your code matches the existing vanilla JS / minimal-dependency philosophy. Do not introduce heavy frameworks (like React/Vue) to the UI.
3. Test your changes to ensure they don't block the main thread or break Web Worker communication.
4. Submit your pull request!