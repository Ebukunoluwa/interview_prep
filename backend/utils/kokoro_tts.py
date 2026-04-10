"""Custom Kokoro TTS plugin for LiveKit Agents via Hugging Face Inference API.

The HuggingFace inference endpoint for hexgrad/Kokoro-82M returns raw WAV bytes.
We convert those to PCM AudioFrames for the LiveKit pipeline.
"""
from __future__ import annotations

import asyncio
import io
import logging
import wave
from dataclasses import dataclass

import aiohttp
import numpy as np

logger = logging.getLogger(__name__)

KOKORO_HF_URL = "https://api-inference.huggingface.co/models/hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000
NUM_CHANNELS = 1


async def synthesize_kokoro(text: str, api_key: str, voice: str = "af_bella") -> bytes:
    """Call HuggingFace Inference API and return raw WAV bytes."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "inputs": text,
        "parameters": {"voice": voice},
    }
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(KOKORO_HF_URL, json=payload, headers=headers) as resp:
            if resp.status == 503:
                # Model loading — wait and retry once
                await asyncio.sleep(10)
                async with session.post(
                    KOKORO_HF_URL, json=payload, headers=headers
                ) as retry:
                    retry.raise_for_status()
                    return await retry.read()
            resp.raise_for_status()
            return await resp.read()


def wav_bytes_to_pcm(wav_bytes: bytes) -> tuple[bytes, int, int]:
    """Convert WAV bytes to raw int16 PCM. Returns (pcm_data, sample_rate, channels)."""
    with io.BytesIO(wav_bytes) as buf:
        with wave.open(buf, "rb") as wf:
            sr = wf.getframerate()
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
            pcm = wf.readframes(wf.getnframes())

    # Normalise to int16 if sample width differs
    if sw == 4:  # int32 → int16
        arr = np.frombuffer(pcm, dtype=np.int32)
        pcm = (arr >> 16).astype(np.int16).tobytes()
    elif sw == 1:  # uint8 → int16
        arr = np.frombuffer(pcm, dtype=np.uint8).astype(np.int16)
        pcm = ((arr - 128) * 256).astype(np.int16).tobytes()

    return pcm, sr, ch


# ---------------------------------------------------------------------------
# LiveKit Agents TTS wrapper
# This follows the livekit-agents 0.11/0.12 plugin interface.
# ---------------------------------------------------------------------------

try:
    from livekit import rtc
    from livekit.agents import tts, utils as lk_utils

    class KokoroTTS(tts.TTS):
        """Kokoro TTS via Hugging Face Inference API."""

        def __init__(self, api_key: str, voice: str = "af_bella"):
            super().__init__(
                capabilities=tts.TTSCapabilities(streaming=False),
                sample_rate=SAMPLE_RATE,
                num_channels=NUM_CHANNELS,
            )
            self._api_key = api_key
            self._voice = voice

        def synthesize(self, text: str) -> "KokoroStream":
            return KokoroStream(tts_instance=self, input_text=text)

        def stream(self) -> "KokoroStream":
            return KokoroStream(tts_instance=self, input_text="")

    class KokoroStream(tts.ChunkedStream):
        def __init__(self, tts_instance: KokoroTTS, input_text: str):
            super().__init__(tts_instance, input_text)
            self._tts_inst = tts_instance

        async def _main_task(self) -> None:
            try:
                wav_bytes = await synthesize_kokoro(
                    self.input_text, self._tts_inst._api_key, self._tts_inst._voice
                )
                pcm, sr, ch = wav_bytes_to_pcm(wav_bytes)

                frame = rtc.AudioFrame(
                    data=pcm,
                    sample_rate=sr,
                    num_channels=ch,
                    samples_per_channel=len(pcm) // 2 // ch,
                )
                self._event_ch.send_nowait(
                    tts.SynthesizedAudio(
                        request_id=lk_utils.shortuuid(),
                        segment_id=lk_utils.shortuuid(),
                        audio=frame,
                        is_final=True,
                    )
                )
            except Exception as exc:
                logger.error("KokoroTTS synthesis failed: %s", exc)
                raise

except ImportError:
    # Running outside of a LiveKit agent context (e.g. tests)
    class KokoroTTS:  # type: ignore[no-redef]
        def __init__(self, api_key: str, voice: str = "af_bella"):
            self._api_key = api_key
            self._voice = voice
