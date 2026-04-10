"""Document parsing utilities — PDF, DOCX, images, and plain text."""
from __future__ import annotations

import base64
import io
import re


def parse_pdf(content: bytes) -> str:
    import pdfplumber

    with pdfplumber.open(io.BytesIO(content)) as pdf:
        pages = [page.extract_text() or "" for page in pdf.pages]
    return "\n".join(pages).strip()


def parse_docx(content: bytes) -> str:
    from docx import Document

    doc = Document(io.BytesIO(content))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip()).strip()


def parse_text(content: bytes) -> str:
    return content.decode("utf-8", errors="ignore").strip()


_VISION_MODELS = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "llama-3.2-90b-vision-preview",
    "llama-3.2-11b-vision-preview",
]


def _resize_image(content: bytes, max_px: int = 1280) -> tuple[bytes, str]:
    """Resize image to fit within max_px on the longest side. Returns (bytes, mime_type)."""
    from PIL import Image

    img = Image.open(io.BytesIO(content))
    img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > max_px:
        scale = max_px / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue(), "image/jpeg"


def parse_image(content: bytes, mime_type: str, groq_client) -> str:
    """Use Groq vision to extract text from an image."""
    content, mime_type = _resize_image(content)
    b64 = base64.b64encode(content).decode()

    last_exc: Exception | None = None
    for model in _VISION_MODELS:
        try:
            response = groq_client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:{mime_type};base64,{b64}"},
                            },
                            {
                                "type": "text",
                                "text": (
                                    "Carefully extract EVERY piece of text visible in this image, "
                                    "including headings, bullet points, skills lists, technologies, "
                                    "tools, requirements, and any small print. "
                                    "Do not summarise or skip anything — transcribe word for word. "
                                    "Return only the raw extracted text, no commentary."
                                ),
                            },
                        ],
                    }
                ],
                max_tokens=4096,
            )
            return response.choices[0].message.content.strip()
        except Exception as exc:
            last_exc = exc
            continue

    raise RuntimeError(f"All vision models failed. Last error: {last_exc}")


_IMAGE_MIME: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

_TEXT_EXTENSIONS = {".txt", ".md", ".csv"}
_PDF_EXTENSIONS = {".pdf"}
_DOCX_EXTENSIONS = {".docx"}


def parse_file(content: bytes, filename: str, groq_client=None) -> str:
    """Dispatch to the right parser based on file extension."""
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext in _PDF_EXTENSIONS:
        return parse_pdf(content)
    if ext in _DOCX_EXTENSIONS:
        return parse_docx(content)
    if ext in _IMAGE_MIME:
        if groq_client is None:
            raise ValueError("groq_client required for image parsing")
        return parse_image(content, _IMAGE_MIME[ext], groq_client)
    # default: plain text
    return parse_text(content)


def parse_qa_pairs(text: str) -> list[dict]:
    """Parse Q&A pairs from text.

    Supports:
      Q: <question>
      A: <answer>
    and numbered lists.
    """
    pairs: list[dict] = []

    q_pattern = re.compile(r"Q:\s*(.+?)(?=A:|Q:|$)", re.DOTALL | re.IGNORECASE)
    a_pattern = re.compile(r"A:\s*(.+?)(?=Q:|A:|$)", re.DOTALL | re.IGNORECASE)

    questions = q_pattern.findall(text)
    answers = a_pattern.findall(text)

    if questions and answers:
        for q, a in zip(questions, answers):
            pairs.append({"question": q.strip(), "answer": a.strip()})
        return pairs

    for line in text.splitlines():
        line = re.sub(r"^\d+[.)]\s*", "", line.strip())
        if line:
            pairs.append({"question": line, "answer": ""})

    return pairs
