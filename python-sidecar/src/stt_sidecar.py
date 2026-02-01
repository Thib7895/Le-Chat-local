#!/usr/bin/env python3
"""
STT Sidecar for Le Chat Local — Speech-to-Text with faster-whisper.

Communicates via JSON-RPC over stdin/stdout with the Tauri application.
Uses faster-whisper with distil-large-v3 model, CUDA acceleration, and VAD filtering.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import sysconfig

# --- Windows CUDA DLL resolution for CTranslate2 / faster-whisper ---
if sys.platform.startswith("win"):
    sp = sysconfig.get_path("purelib")  # ...\Lib\site-packages
    dll_dirs = [
        os.path.join(sp, "nvidia", "cublas", "bin"),
        os.path.join(sp, "nvidia", "cuda_runtime", "bin"),
    ]

    # Add DLL dirs (Python 3.8+)
    for d in dll_dirs:
        if os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except Exception:
                pass

    # Also prefix PATH (important for dynamic LoadLibrary calls)
    os.environ["PATH"] = ";".join([d for d in dll_dirs if os.path.isdir(d)]) + ";" + os.environ.get("PATH", "")

# Log to user's home directory for guaranteed write access
LOG_FILE = Path(os.path.expanduser("~")) / "stt_debug.log"


def log_debug(message: str):
    """Write debug message to stt_debug.log in user's home directory."""
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now()}] {message}\n")
    except Exception as e:
        print(f"LOG ERROR: {e}", file=sys.stderr)


class WhisperSTTEngine:
    """Wrapper for faster-whisper speech-to-text engine."""

    def __init__(self):
        self.model = None
        self._loaded = False
        log_debug("STT Engine initialized")

    def load(self) -> bool:
        """Load the faster-whisper model."""
        try:
            from faster_whisper import WhisperModel

            log_debug("Loading faster-whisper model (distil-large-v3, cuda, int8_float16)...")
            self.model = WhisperModel(
                "distil-large-v3",
                device="cuda",
                compute_type="int8_float16",
            )
            self._loaded = True
            log_debug("SUCCESS: faster-whisper model loaded")
            return True
        except Exception as e:
            log_debug(f"ERROR loading faster-whisper model: {e}")
            log_debug(traceback.format_exc())
            # Fallback to CPU if CUDA fails
            try:
                from faster_whisper import WhisperModel

                log_debug("Retrying with CPU...")
                self.model = WhisperModel(
                    "distil-large-v3",
                    device="cpu",
                    compute_type="int8",
                )
                self._loaded = True
                log_debug("SUCCESS: faster-whisper model loaded (CPU fallback)")
                return True
            except Exception as e2:
                log_debug(f"ERROR loading on CPU too: {e2}")
                log_debug(traceback.format_exc())
                return False

    def is_loaded(self) -> bool:
        """Check if the model is loaded."""
        return self._loaded and self.model is not None

    def transcribe(self, audio_base64: str, lang: Optional[str] = None) -> Dict[str, Any]:
        """
        Transcribe audio from base64-encoded WebM/Opus data.

        Args:
            audio_base64: Base64-encoded audio data (WebM/Opus format)
            lang: Optional language hint (e.g., "fr", "en")

        Returns:
            Dict with text, language, and segments
        """
        if not self.is_loaded():
            log_debug("Model not loaded, attempting to load...")
            if not self.load():
                raise RuntimeError("Failed to load STT model")

        # Decode base64 audio to temp file
        audio_bytes = base64.b64decode(audio_base64)
        log_debug(f"Received {len(audio_bytes)} bytes of audio")

        # Write to temp WebM file
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp_webm:
            tmp_webm.write(audio_bytes)
            tmp_webm_path = tmp_webm.name

        # Convert WebM to WAV 16kHz mono using ffmpeg
        tmp_wav_path = tmp_webm_path.replace(".webm", ".wav")
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", tmp_webm_path,
                    "-ar", "16000",
                    "-ac", "1",
                    "-f", "wav",
                    tmp_wav_path,
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                log_debug(f"ffmpeg error: {result.stderr}")
                raise RuntimeError(f"ffmpeg conversion failed: {result.stderr[:200]}")

            log_debug(f"Converted to WAV: {tmp_wav_path}")

            # Transcribe with faster-whisper
            transcribe_kwargs = {
                "beam_size": 5,
                "vad_filter": True,
                "vad_parameters": {
                    "min_silence_duration_ms": 500,
                },
            }
            if lang:
                transcribe_kwargs["language"] = lang

            log_debug(f"Transcribing... (lang={lang or 'auto'})")
            segments_iter, info = self.model.transcribe(tmp_wav_path, **transcribe_kwargs)

            # Collect segments
            segments = []
            full_text_parts = []
            for segment in segments_iter:
                segments.append({
                    "start": round(segment.start, 2),
                    "end": round(segment.end, 2),
                    "text": segment.text.strip(),
                })
                full_text_parts.append(segment.text.strip())

            full_text = " ".join(full_text_parts)
            detected_lang = info.language if info else (lang or "unknown")

            log_debug(f"SUCCESS: Transcribed {len(segments)} segments, lang={detected_lang}")
            log_debug(f"Text: {full_text[:100]}...")

            return {
                "text": full_text,
                "language": detected_lang,
                "segments": segments,
            }

        finally:
            # Clean up temp files
            try:
                os.unlink(tmp_webm_path)
            except OSError:
                pass
            try:
                os.unlink(tmp_wav_path)
            except OSError:
                pass


class JsonRpcHandler:
    """Handle JSON-RPC requests from Tauri."""

    def __init__(self):
        self.engine = WhisperSTTEngine()
        self.methods = {
            "transcribe": self._transcribe,
            "health": self._health_check,
            "load_model": self._load_model,
        }

    def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Handle a JSON-RPC request."""
        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")

        if method not in self.methods:
            return self._error(request_id, -32601, f"Method not found: {method}")

        try:
            result = self.methods[method](**params)
            return self._success(request_id, result)
        except TypeError as e:
            return self._error(request_id, -32602, f"Invalid params: {e}")
        except Exception as e:
            log_debug(f"ERROR in method {method}: {e}")
            log_debug(traceback.format_exc())
            return self._error(request_id, -32000, str(e))

    def _success(self, request_id, result):
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def _error(self, request_id, code, message):
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def _transcribe(self, audio_base64: str, lang: Optional[str] = None) -> Dict[str, Any]:
        """Transcribe audio from base64 data."""
        return self.engine.transcribe(audio_base64, lang)

    def _health_check(self) -> Dict[str, Any]:
        """Check engine health status."""
        return {"status": "ok", "model_loaded": self.engine.is_loaded()}

    def _load_model(self) -> Dict[str, Any]:
        """Load the model into memory."""
        success = self.engine.load()
        return {"success": success, "model_loaded": self.engine.is_loaded()}


def main():
    """Main entry point for the STT sidecar."""
    # Fix Windows encoding
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

    # Set HuggingFace cache to AppData for model persistence
    hf_cache = os.path.join(os.environ.get("APPDATA", ""), "Le Chat", "hf_cache")
    os.makedirs(hf_cache, exist_ok=True)
    os.environ["HF_HOME"] = hf_cache
    os.environ["HUGGINGFACE_HUB_CACHE"] = hf_cache

    log_debug(f"STT Sidecar starting, HF cache: {hf_cache}")

    handler = JsonRpcHandler()

    # Read JSON-RPC requests from stdin, write responses to stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            response = handler.handle_request(request)
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError as e:
            error_response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": f"Parse error: {e}"},
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()
