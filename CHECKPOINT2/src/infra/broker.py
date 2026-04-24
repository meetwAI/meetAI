import hashlib
import json
from typing import Any, AsyncGenerator, Dict, Optional

from redis.asyncio import Redis


def stable_worker_id(session_id: str, num_workers: int) -> int:
    digest = hashlib.blake2b(session_id.encode("utf-8"), digest_size=8).digest()
    value = int.from_bytes(digest, byteorder="big", signed=False)
    return value % max(1, num_workers)


class AudioBroker:
    def __init__(self, redis_url: str, stream_maxlen: int = 5000):
        self.redis_url = redis_url
        self.stream_maxlen = stream_maxlen
        self.redis: Redis = Redis.from_url(redis_url, decode_responses=False)

    async def close(self):
        await self.redis.close()

    @staticmethod
    def worker_for_session(session_id: str, num_workers: int) -> int:
        return stable_worker_id(session_id, num_workers)

    async def publish_audio(
        self, session_id: str, pcm_bytes: bytes, num_workers: int
    ) -> str:
        worker_id = self.worker_for_session(session_id, num_workers)
        stream_key = f"audio:worker:{worker_id}"
        fields = {
            "type": "audio",
            "session_id": session_id,
            "pcm": pcm_bytes,
        }
        return await self.redis.xadd(
            stream_key, fields=fields, maxlen=self.stream_maxlen, approximate=True
        )

    async def register_session(self, session_id: str, num_workers: int) -> str:
        worker_id = self.worker_for_session(session_id, num_workers)
        stream_key = f"audio:worker:{worker_id}"
        fields = {
            "type": "register",
            "session_id": session_id,
        }
        return await self.redis.xadd(
            stream_key, fields=fields, maxlen=self.stream_maxlen, approximate=True
        )

    async def unregister_session(self, session_id: str, num_workers: int) -> str:
        worker_id = self.worker_for_session(session_id, num_workers)
        stream_key = f"audio:worker:{worker_id}"
        fields = {
            "type": "close",
            "session_id": session_id,
        }
        return await self.redis.xadd(
            stream_key, fields=fields, maxlen=self.stream_maxlen, approximate=True
        )

    async def publish_result(self, session_id: str, result_dict: Dict[str, Any]) -> str:
        stream_key = f"results:{session_id}"
        fields = {
            "result": json.dumps(result_dict, ensure_ascii=True),
        }
        return await self.redis.xadd(
            stream_key, fields=fields, maxlen=self.stream_maxlen, approximate=True
        )

    async def consume_audio(
        self,
        worker_id: int,
        *,
        start_id: str = "$",
        block_ms: int = 1000,
        count: int = 100,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        stream_key = f"audio:worker:{worker_id}"
        last_id = start_id

        while True:
            entries = await self.redis.xread(
                {stream_key: last_id}, count=count, block=block_ms
            )
            if not entries:
                continue

            for _, messages in entries:
                for message_id, fields in messages:
                    last_id = (
                        message_id.decode()
                        if isinstance(message_id, bytes)
                        else message_id
                    )
                    event_type = self._as_str(fields.get(b"type") or fields.get("type"))
                    session_id = self._as_str(
                        fields.get(b"session_id") or fields.get("session_id")
                    )
                    pcm = self._as_bytes(fields.get(b"pcm") or fields.get("pcm"))
                    yield {
                        "id": last_id,
                        "type": event_type,
                        "session_id": session_id,
                        "pcm": pcm,
                    }

    async def consume_results(
        self,
        session_id: str,
        *,
        start_id: str = "$",
        block_ms: int = 1000,
        count: int = 50,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        stream_key = f"results:{session_id}"
        last_id = start_id

        while True:
            entries = await self.redis.xread(
                {stream_key: last_id}, count=count, block=block_ms
            )
            if not entries:
                continue

            for _, messages in entries:
                for message_id, fields in messages:
                    last_id = (
                        message_id.decode()
                        if isinstance(message_id, bytes)
                        else message_id
                    )
                    payload = self._as_str(
                        fields.get(b"result") or fields.get("result")
                    )
                    if not payload:
                        continue
                    yield json.loads(payload)

    @staticmethod
    def _as_str(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="ignore")
        return str(value)

    @staticmethod
    def _as_bytes(value: Any) -> bytes:
        if value is None:
            return b""
        if isinstance(value, bytes):
            return value
        if isinstance(value, str):
            return value.encode("utf-8")
        return bytes(value)
