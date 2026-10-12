// Bound the bytes while streaming, rather than after allocating an untrusted body.
export async function boundedJson(response: Response, maximumBytes = 1_000_000): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error("INVALID_BODY_LIMIT");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_RESPONSE_BODY");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("RESPONSE_BODY_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}
