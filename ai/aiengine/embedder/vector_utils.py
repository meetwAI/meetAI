"""
Vector encoding helpers for the embedder package.

pgvector accepts vectors as the text literal "[v1,v2,...]". asyncpg can also
return that text form back to us, so we need a parser for the inverse.

These two helpers used to live duplicated in qa/retriever.py and
store/topics.py (formerly infra/topic_store.py); they're consolidated here so
the formatting precision (`%.8f`) and the parsing behaviour stay in lock-step.
"""

from __future__ import annotations

from typing import List, Sequence


def encode_vector(values: Sequence[float]) -> str:
    """Render an embedding vector for pgvector's text input format.

    The dimension is whatever the caller has — typically `settings.EMBED_DIM`
    (384 for `BAAI/bge-small-en-v1.5`). This helper does not enforce a length;
    that check belongs at the call site.
    """
    return "[" + ",".join(f"{v:.8f}" for v in values) + "]"


def decode_vector(raw) -> List[float]:
    """Parse pgvector's text output (e.g. '[0.1,0.2,...]') into a list.

    Tolerates:
      - None  -> []
      - list/tuple of floats -> coerced floats (passthrough)
      - string like "[0.1,0.2,...]" -> parsed floats
    """
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [float(v) for v in raw]
    text = str(raw).strip()
    if not text:
        return []
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    if not text:
        return []
    return [float(v) for v in text.split(",")]
