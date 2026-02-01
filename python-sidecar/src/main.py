#!/usr/bin/env python3
"""
TTS Sidecar for Le Chat Local.

Communicates via JSON-RPC over stdin/stdout with the Tauri application.
"""
import sys
import json
import base64
from typing import Any, Dict, Optional

from tts_engine import KokoroTTSEngine


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
