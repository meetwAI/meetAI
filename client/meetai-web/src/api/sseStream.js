/**
 * sseStream.js
 * ------------
 * Minimal Server-Sent Events parser for `fetch()` ReadableStream bodies.
 *
 * EventSource has two limitations we want to avoid:
 *   1. It can only do GET, but our QA endpoint is POST (the body carries the
 *      question + meeting/user ids).
 *   2. It can't forward auth cookies in cross-origin mode without quirks.
 *
 * fetch() solves both, but fetch doesn't parse SSE for us. This helper does.
 *
 * It yields one parsed event at a time as `{ event, data }`, where `data` is
 * the raw string from the wire (callers JSON.parse if they expect JSON).
 *
 * Usage
 * -----
 *   const res = await fetch(url, { ..., headers: { Accept: 'text/event-stream' } });
 *   for await (const evt of parseSseStream(res.body)) {
 *     if (evt.event === 'delta') { ... }
 *   }
 */
export async function* parseSseStream(body) {
  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';
  let currentData = '';

  const flushFrame = () => {
    if (currentData === '' && currentEvent === 'message') {
      currentData = '';
      currentEvent = 'message';
      return null;
    }
    const out = { event: currentEvent, data: currentData };
    currentEvent = 'message';
    currentData = '';
    return out;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Drain a possible final frame that wasn't terminated by a blank line.
        const tail = flushFrame();
        if (tail) {
          yield tail;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE frames are blank-line delimited. Process completed lines from the
      // buffer; partial lines stay in `buffer` for the next read.
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line === '') {
          const frame = flushFrame();
          if (frame) {
            yield frame;
          }
          continue;
        }
        if (line.startsWith(':')) {
          // SSE comment / keepalive — ignore.
          continue;
        }
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim() || 'message';
          continue;
        }
        if (line.startsWith('data:')) {
          const piece = line.slice(5).replace(/^ /, '');
          currentData = currentData ? `${currentData}\n${piece}` : piece;
          continue;
        }
        // Unknown field (id:, retry:, …) — ignore.
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
