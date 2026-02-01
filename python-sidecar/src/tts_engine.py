"""
Kokoro-ONNX TTS Engine wrapper for Le Chat Local.
Simplified version with debug logging.
"""
import io
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional

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
