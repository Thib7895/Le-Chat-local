#!/usr/bin/env python3
"""
TTS Sidecar for Le Chat Local - Standalone Version.

This is a merged single-file version for PyInstaller compilation.
Communicates via JSON-RPC over stdin/stdout with the Tauri application.
"""
import base64
import io
import json
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

import soundfile as sf

# Try to import kokoro_onnx
try:
    from kokoro_onnx import Kokoro
    KOKORO_AVAILABLE = True
except ImportError:
    KOKORO_AVAILABLE = False
    Kokoro = None

# Log to user's home directory for guaranteed write access
LOG_FILE = Path(os.path.expanduser("~")) / "tts_debug.log"


def log_debug(message: str):
    """Write debug message to tts_debug.log in user's home directory"""
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now()}] {message}\n")
    except Exception as e:
        # Print to stderr instead of silently ignoring
        print(f"LOG ERROR: {e}", file=sys.stderr)


class KokoroTTSEngine:
    """Wrapper for Kokoro-ONNX text-to-speech engine."""

    def __init__(self, models_path: str):
        """
        Initialize the TTS engine.

        Args:
            models_path: Path to directory containing kokoro-v1.0.onnx and voices-v1.0.bin
        """
        self.models_path = Path(models_path)
        self.kokoro: Optional[Kokoro] = None
        self._loaded = False
        log_debug(f"TTS Engine initialized with models_path: {models_path}")

    def load(self) -> bool:
        """
        Load the ONNX model and voices.

        Returns:
            True if loaded successfully, False otherwise
        """
        if not KOKORO_AVAILABLE:
            log_debug("ERROR: kokoro_onnx not available (import failed)")
            return False

        onnx_path = self.models_path / "kokoro-v1.0.onnx"
        voices_path = self.models_path / "voices-v1.0.bin"

        log_debug(f"Looking for ONNX at: {onnx_path}")
        log_debug(f"Looking for voices at: {voices_path}")

        if not onnx_path.exists():
            log_debug(f"ERROR: ONNX file not found at {onnx_path}")
            return False

        if not voices_path.exists():
            log_debug(f"ERROR: Voices file not found at {voices_path}")
            return False

        try:
            log_debug("Loading Kokoro model...")
            self.kokoro = Kokoro(str(onnx_path), str(voices_path))
            self._loaded = True
            log_debug("SUCCESS: Kokoro model loaded")
            return True
        except Exception as e:
            log_debug(f"ERROR loading Kokoro model: {e}")
            log_debug(traceback.format_exc())
            return False

    def is_loaded(self) -> bool:
        """Check if the model is loaded."""
        return self._loaded and self.kokoro is not None

    def synthesize(self, text: str, lang: str = "en-us") -> Optional[bytes]:
        """
        Synthesize speech from text.

        Args:
            text: Text to synthesize
            lang: Language code - "en-us" or "fr-fr"

        Returns:
            WAV audio bytes or None on error
        """
        try:
            # Always use af_heart voice
            voice = "af_heart"

            # Log the attempt
            text_preview = text[:50].replace('\n', ' ')
            log_debug(f"Attempting synthesis: '{text_preview}...' lang={lang} voice={voice}")

            if not self.is_loaded():
                log_debug("Model not loaded, attempting to load...")
                if not self.load():
                    log_debug("ERROR: Failed to load model")
                    return None

            # Generate audio samples
            log_debug("Calling kokoro.create()...")
            samples, sample_rate = self.kokoro.create(
                text,
                voice=voice,
                speed=1.0,
                lang=lang
            )

            log_debug(f"Generated {len(samples)} samples at {sample_rate}Hz")

            # Convert to WAV bytes
            buffer = io.BytesIO()
            sf.write(buffer, samples, sample_rate, format='WAV')
            buffer.seek(0)
            audio_bytes = buffer.read()

            log_debug(f"SUCCESS: Generated {len(audio_bytes)} bytes of WAV audio")
            return audio_bytes

        except Exception as e:
            log_debug(f"ERROR in synthesize: {e}")
            log_debug(traceback.format_exc())
            return None


class JsonRpcHandler:
    """Handle JSON-RPC requests from Tauri."""

    def __init__(self, models_path: str):
        """Initialize the handler with TTS engine."""
        self.engine = KokoroTTSEngine(models_path)
        self.methods = {
            "synthesize": self._synthesize,
            "health": self._health_check,
            "load_model": self._load_model,
        }

    def handle_request(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """
        Handle a JSON-RPC request.

        Args:
            request: JSON-RPC request object

        Returns:
            JSON-RPC response object
        """
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
            return self._error(request_id, -32000, str(e))

    def _success(self, request_id: Optional[int], result: Any) -> Dict[str, Any]:
        """Create a success response."""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        }

    def _error(
        self, request_id: Optional[int], code: int, message: str
    ) -> Dict[str, Any]:
        """Create an error response."""
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": code,
                "message": message,
            },
        }

    def _synthesize(
        self, text: str, lang: str = "en-us", speed: float = 1.0
    ) -> Dict[str, Any]:
        """
        Synthesize speech from text.

        Args:
            text: Text to synthesize
            lang: Language code - "en-us" or "fr-fr"
            speed: Speech speed

        Returns:
            Dict with base64 encoded audio
        """
        audio_bytes = self.engine.synthesize(text, lang)

        if audio_bytes is None:
            raise RuntimeError("TTS synthesis failed - check tts_debug.log")

        return {
            "audio": base64.b64encode(audio_bytes).decode("ascii"),
            "format": "wav",
            "sample_rate": 24000,
        }

    def _health_check(self) -> Dict[str, Any]:
        """Check engine health status."""
        return {
            "status": "ok",
            "model_loaded": self.engine.is_loaded(),
        }

    def _load_model(self) -> Dict[str, Any]:
        """Attempt to load the model."""
        success = self.engine.load()
        return {
            "success": success,
            "model_loaded": self.engine.is_loaded(),
        }


def main():
    """Main entry point for the sidecar."""
    # Fix Windows encoding: force UTF-8 for stdin/stdout
    # On Windows, sys.stdin defaults to cp1252 which corrupts accented characters
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')

    # Get models path from command line args
    if len(sys.argv) < 2:
        print(
            json.dumps(
                {"error": "Models path required as first argument"}
            ),
            flush=True,
        )
        sys.exit(1)

    models_path = sys.argv[1]
    handler = JsonRpcHandler(models_path)

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
                "error": {
                    "code": -32700,
                    "message": f"Parse error: {e}",
                },
            }
            print(json.dumps(error_response), flush=True)


if __name__ == "__main__":
    main()
