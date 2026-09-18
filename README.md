# Le Chat Local

> Local-first AI desktop assistant inspired by Mistral AI's Le Chat, featuring chat, voice, image generation, vision and web search. AI inference runs locally on your machine.

<p align="center">
  <img src="assets/demo.gif" alt="Le Chat Local demo: sourced web search, image generation and vision" width="720">
</p>

<p align="center">
  <em>Sourced web search, context-aware image generation and vision, powered by locally running AI models.</em>
</p>

Le Chat Local is a desktop application that orchestrates several AI services running locally on your machine: an LLM through Ollama, text-to-speech and speech-to-text through Python sidecars, image generation through Stable Diffusion Forge, and web search through a self-hosted SearXNG instance. The application automatically starts and stops these services as needed.

## Current status

This project is under active development and has primarily been developed and tested on my own Windows environment. The public repository is intended as a technical prototype rather than a production-ready application, and installation on a fresh machine has not yet been fully validated.

The current public version focuses on local inference, web search, multimodal interaction and service orchestration through the Rust/Tauri backend. A LangGraph-based orchestration layer is currently under development and is not yet part of the public version.

---

## Features

- **Streaming LLM chat** - native Ollama API (`/api/chat`), with configurable parameters including `temperature`, `num_ctx`, `num_predict` and `keep_alive`.
- **Conversation persistence** - SQLite database, conversation sidebar and automatic title generation after the first exchange.
- **Vision** - images can be sent to the model, encoded as base64 in the `images` field of the Ollama request.
- **Text-to-Speech (TTS)** - Kokoro ONNX, with automatic French / English language detection using `whatlang`.
- **Speech-to-Text (STT)** - faster-whisper `large-v3-turbo`, with CUDA acceleration and VAD filtering.
- **Image generation** - Stable Diffusion Forge with orchestrated *VRAM swapping*: unload the LLM, generate the image, unload the Stable Diffusion checkpoint, then reload the LLM. The image prompt is first refined by the LLM using the conversation context, enabling requests such as "generate a similar image, but at night".
- **Web-search RAG** - custom *Retrieve-Read-Rank* pipeline (`src-tauri/src/web/`) connected to SearXNG: multi-query expansion, main-content extraction, lexical and semantic scoring, followed by generation of a sourced answer.
- **Automatic service lifecycle management** - Ollama, Docker Desktop and SD Forge are started automatically if they are not already running, and shut down cleanly when the application closes.

---

## Architecture

```text
Le Chat/
├── src/                          # Next.js frontend (static export)
│   ├── app/                      # App Router
│   ├── components/
│   │   ├── chat/                 # ChatContainer, InputBar, Message
│   │   ├── layout/               # Sidebar
│   │   └── icons/
│   ├── stores/                   # Zustand: chatStore, conversationStore, sdForgeStore
│   ├── hooks/
│   └── lib/                      # Types, constants
│
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── lib.rs                # Setup, startup orchestration, shutdown cleanup
│   │   ├── commands/
│   │   │   ├── llm.rs            # stream_chat, model preload/unload, ensure_ollama_running
│   │   │   ├── image_gen.rs      # VRAM swap pipeline + SD Forge call
│   │   │   ├── sd_forge.rs       # SD Forge process lifecycle
│   │   │   ├── tts.rs            # Python TTS sidecar (JSON-RPC over stdin/stdout)
│   │   │   ├── stt.rs            # Python STT sidecar (JSON-RPC over stdin/stdout)
│   │   │   ├── database.rs       # SQLite: conversations and messages
│   │   │   └── settings.rs       # settings.json
│   │   └── web/                  # RAG web-search pipeline
│   │       ├── docker.rs         # Docker + SearXNG container lifecycle
│   │       ├── providers.rs      # SearXNG client
│   │       ├── fetch.rs          # Web page fetching
│   │       ├── evidence.rs       # Content extraction
│   │       └── rank.rs           # Result scoring
│   ├── capabilities/default.json # Tauri permissions
│   └── tauri.conf.json
│
├── python-sidecar/src/
│   ├── sidecar_standalone.py     # TTS sidecar (Kokoro)
│   ├── stt_sidecar.py            # STT sidecar (faster-whisper)
│   └── tts_engine.py
│
├── services/searxng/             # docker-compose.yml + settings.yml
└── assets/models/                # TTS models (not version-controlled)
```

### Important architecture decision: no `fetch` from the WebView

All HTTP requests go through the Rust backend using Tauri's `invoke` and event system, never through `fetch` directly from the WebView. In production builds, the WebView blocks requests to `localhost`, which previously resulted in `Failed to fetch` errors.

LLM streaming illustrates this architecture: the Rust `stream_chat` command ([llm.rs](src-tauri/src/commands/llm.rs)) consumes the Ollama stream and emits `llm-token-{sessionId}` / `llm-done-{sessionId}` events, which are handled by `streamLlmResponse` in the frontend ([chatStore.ts](src/stores/chatStore.ts)).

Any new HTTP integration should follow the same pattern.

### Ports

| Service | Port | Defined in |
|---|---|---|
| Ollama | `11434` | `src-tauri/src/commands/llm.rs` |
| SD Forge | `7860` | `src-tauri/src/commands/sd_forge.rs`, `image_gen.rs` |
| SearXNG | `8080` | `src-tauri/src/web/docker.rs`, `web/providers.rs` |

---

## Prerequisites

### System

- **Windows 10 / 11** - process management is Windows-specific (`CREATE_NO_WINDOW`, `taskkill /F /T`). The application will not work as-is on macOS or Linux.
- **NVIDIA GPU with CUDA** - strongly recommended. faster-whisper and SD Forge are configured to use CUDA acceleration. Sufficient VRAM is required for the LLM. The *VRAM swap* mechanism allows the LLM and Stable Diffusion to share GPU memory, but does not eliminate VRAM requirements.

### Software

| Software | Purpose |
|---|---|
| [Node.js](https://nodejs.org) 20+ | Next.js frontend |
| [Rust](https://rustup.rs) (stable) | Tauri backend |
| [Ollama](https://ollama.com) | LLM inference |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | SearXNG container |
| Python 3.10+ | TTS and STT sidecars |
| [SD WebUI Forge Classic](https://github.com/Haoming02/sd-webui-forge-classic) | Image generation |

### Python environments

Two **separate environments** are required because faster-whisper CUDA dependencies conflict with `onnxruntime`:

1. **Main environment (TTS)** - dependencies listed in `python-sidecar/requirements.txt`: `kokoro-onnx`, `onnxruntime`, `numpy`, `soundfile`.
2. **`sst-env` environment (STT)** - `faster-whisper` and CTranslate2 with CUDA support.

### Models to download

| Model | Expected location |
|---|---|
| `kokoro-v1.0.onnx` | `assets/models/` |
| `voices-v1.0.bin` | `assets/models/` |
| Ollama LLM | managed by Ollama (`ollama pull`) |
| Stable Diffusion `.safetensors` checkpoint | SD Forge `models/Stable-diffusion/` directory |

> The `assets/models/*.onnx` and `*.bin` files are excluded from the repository through `.gitignore` and must be downloaded separately.

---

## Installation

**1. Clone the repository and install Node dependencies**

```bash
npm install
```

**2. Create the Python environment for TTS**

```bash
pip install -r python-sidecar/requirements.txt
```

**3. Create the `sst-env` environment for STT**

```bash
conda create -n sst-env python=3.11 -y
```

```bash
conda run -n sst-env pip install faster-whisper
```

**4. Place the TTS models in `assets/models/`**

**5. Download an LLM**

```bash
ollama pull ministral-3:3b-instruct-2512-q4_K_M
```

**6. Run in development mode**

```bash
npm run tauri dev
```

**7. Build a distributable version**

```bash
npm run tauri build
```

Installers are generated in `src-tauri/target/release/bundle/msi/` and `src-tauri/target/release/bundle/nsis/`.

---

## Generated Data

The application writes its data to the Tauri application data directory, which is created on first launch. On Windows, this is `%APPDATA%\com.lechat.local\` (the directory name is derived from the `identifier` defined in `src-tauri/tauri.conf.json`).

| File | Contents |
|---|---|
| `conversations.db` | SQLite database containing the `conversations` and `messages` tables |
| `settings.json` | Preferences: Ollama URL, model, voice, language and LLM parameters |

**Database schema:**

- `conversations` - `id`, `title`, `created_at`, `updated_at`
- `messages` - `id`, `conversation_id`, `role`, `content`, `timestamp`, `images` (JSON), `image_gen` (JSON)

Both images sent to the model and generated images are stored **directly as base64 in the database**, inside the `images` and `image_gen` JSON columns. The database can therefore grow quickly when image generation is used extensively.

No cache or log files are written to disk. Logs are sent to `stderr` through `env_logger` and are only visible in development mode.

To reset the application completely, simply delete the `%APPDATA%\com.lechat.local\` directory.

---

## Limitations

- **Windows only.** Process-management code, including console hiding and process-tree termination, is Windows-specific.
- **The Docker Desktop window appears during automatic startup.** Docker Desktop forces its window to open when launched, and there is no reliable workaround. To avoid this, enable "Start Docker Desktop when you sign in" in Docker settings so that it is already running when the application starts.
- **Image-generation parameters are currently hard-coded** - 512x512, 20 steps, `DPM++ 2M Karras` sampler and `cfg_scale` 5, defined in `src-tauri/src/commands/image_gen.rs` (lines 43-50). They are not exposed in the user interface.

---

## Development

| Command | Description |
|---|---|
| `npm run dev` | Next.js frontend only (port 3000) |
| `npm run build` | Static frontend export to `out/` |
| `npm run tauri dev` | Full application in development mode |
| `npm run tauri build` | Production build + MSI and NSIS installers |

**Stack:** Next.js 16 (static export), React 19, Tailwind CSS 4, Zustand, Framer Motion and react-markdown on the frontend. Tauri 2, rusqlite, reqwest, scraper, whatlang and tokio on the backend.

---
