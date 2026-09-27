"""Thin wrapper around the Gemini Interactions API.

Nano Banana 2 (gemini-3.1-flash-image) renders the photos; Gemini Omni Flash (gemini-omni-1.1-flash)
turns them into video. Both go through `client.interactions.create`, which blocks until the media is ready.
"""
from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from google import genai

IMAGE_MODEL = "gemini-3.1-flash-image"  # Nano Banana 2
VIDEO_MODEL = "gemini-omni-1.1-flash"  # Gemini Omni Flash
TEXT_MODEL = "gemini-flash-latest"  # describes the anchor photo so the other views can match its look

RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
IMAGE_TIMEOUT_S = 300
VIDEO_TIMEOUT_S = 1200

log = logging.getLogger(__name__)


class GenerationError(RuntimeError):
    """The API answered, but without the media we asked for (safety block, text-only reply, ...)."""


@dataclass
class Media:
    data: bytes
    mime_type: str
    interaction_id: str | None
    text: str | None


def image_part(data: bytes, mime_type: str) -> dict:
    return {"type": "image", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime_type}


def text_part(text: str) -> dict:
    return {"type": "text", "text": text}


class Gemini:
    def __init__(self, api_key: str | None = None, max_retries: int = 4):
        # With api_key=None the SDK reads GEMINI_KEY / GOOGLE_API_KEY from the environment.
        self.client = genai.Client(api_key=api_key)
        self.max_retries = max_retries

    def generate_image(
        self,
        inputs: list[dict],
        aspect_ratio: str,
        image_size: str = "2K",
        model: str = IMAGE_MODEL,
        thinking_level: str | None = None,
    ) -> Media:
        body = {
            "model": model,
            "input": inputs,
            "response_format": {"type": "image", "aspect_ratio": aspect_ratio, "image_size": image_size},
        }
        if thinking_level:
            body["generation_config"] = {"thinking_level": thinking_level}
        interaction = self._create(IMAGE_TIMEOUT_S, body)

        out = interaction.output_image
        if out is None or not out.data:
            raise GenerationError(_no_media_message(model, "image", interaction))
        return Media(base64.b64decode(out.data), out.mime_type or "image/jpeg", interaction.id, interaction.output_text)

    def describe_image(self, data: bytes, mime_type: str, prompt: str, model: str = TEXT_MODEL) -> str:
        interaction = self._create(IMAGE_TIMEOUT_S, {"model": model, "input": [image_part(data, mime_type), text_part(prompt)]})
        text = (interaction.output_text or "").strip()
        if not text:
            raise GenerationError(_no_media_message(model, "text", interaction))
        return text

    def generate_video(
        self,
        inputs: list[dict],
        task: str | None = None,
        aspect_ratio: str = "16:9",
        resolution: str = "720p",
        model: str = VIDEO_MODEL,
    ) -> Media:
        """`task` is e.g. "image_to_video"; None lets Omni infer it from the inputs and prompt tags."""
        response_format = {"type": "video", "aspect_ratio": aspect_ratio, "resolution": resolution}
        if resolution in ("1080p", "4k"):
            # Inline responses top out around 4 MB; bigger videos must be fetched from a Files API URI.
            response_format["delivery"] = "uri"
        body = {"model": model, "input": inputs, "response_format": response_format}
        if task:
            body["generation_config"] = {"video_config": {"task": task}}
        interaction = self._create(VIDEO_TIMEOUT_S, body)

        out = interaction.output_video
        if out is None or not (out.data or out.uri):
            raise GenerationError(_no_media_message(model, "video", interaction))
        data = base64.b64decode(out.data) if out.data else self._download(out.uri)
        return Media(data, out.mime_type or "video/mp4", interaction.id, interaction.output_text)

    def _create(self, timeout: float, body: dict):
        for attempt in range(self.max_retries + 1):
            try:
                return self.client.interactions.create(timeout=timeout, **body)
            except Exception as e:  # SDK errors carry .status_code; network errors come from httpx
                status = getattr(e, "status_code", None)
                transient = status in RETRYABLE_STATUS or isinstance(e, (httpx.TimeoutException, httpx.TransportError))
                if not transient or attempt == self.max_retries:
                    raise
                delay = _retry_after(e) or min(60, 5 * 2**attempt)
                log.warning("%s failed (%s), retrying in %ss [%d/%d]",
                            body["model"], status or type(e).__name__, delay, attempt + 1, self.max_retries)
                time.sleep(delay)

    def _download(self, uri: str, poll_s: float = 5, timeout_s: float = 600) -> bytes:
        """Wait for a URI-delivered video to become ACTIVE, then download it."""
        name = "files/" + uri.rstrip("/").split("/")[-1].split("?")[0].split(":")[0]
        deadline = time.monotonic() + timeout_s
        while True:
            state = getattr(self.client.files.get(name=name).state, "name", None)
            if state == "ACTIVE":
                break
            if state == "FAILED":
                raise GenerationError(f"Video file {name} failed processing")
            if time.monotonic() > deadline:
                raise TimeoutError(f"Video file {name} still {state} after {timeout_s}s")
            time.sleep(poll_s)
        return self.client.files.download(file=uri)


def _retry_after(e: Exception) -> float | None:
    headers = getattr(e, "headers", None)
    try:
        return float(headers.get("retry-after")) if headers and headers.get("retry-after") else None
    except ValueError:
        return None


def _no_media_message(model: str, kind: str, interaction) -> str:
    reason = (interaction.output_text or "").strip() or "no explanation returned"
    return f"{model} returned no {kind} (status={interaction.status}): {reason}"
