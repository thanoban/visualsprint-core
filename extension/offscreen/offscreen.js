/**
 * Offscreen document: runs MediaRecorder on the tab's audio stream.
 * Receives START_CAPTURE / STOP_CAPTURE from the background service worker.
 * Sends AUDIO_CHUNK messages back to the SW with each 5-second webm segment.
 */

let recorder = null;
let chunkSeq = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "START_CAPTURE") {
    startCapture(msg.streamId, msg.sessionId).catch((e) => {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_ERROR", error: e.message });
    });
  } else if (msg.type === "STOP_CAPTURE") {
    stopCapture();
  }
});

async function startCapture(streamId, sessionId) {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  chunkSeq = 0;

  // Obtain the tab's audio stream from the tabCapture streamId
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Pick the best supported audio codec
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  recorder = new MediaRecorder(stream, { mimeType });

  recorder.ondataavailable = async (e) => {
    if (!e.data || e.data.size === 0) return;
    const arrayBuffer = await e.data.arrayBuffer();
    // ArrayBuffer is not JSON-serializable — convert to plain Array so it
    // survives the chrome.runtime.sendMessage JSON round-trip intact.
    const chunkArray = Array.from(new Uint8Array(arrayBuffer));
    chrome.runtime.sendMessage({
      type: "AUDIO_CHUNK",
      sessionId,
      seq: chunkSeq++,
      chunk: chunkArray,
    });
  };

  // Emit a chunk every 5 seconds
  recorder.start(5000);
  chrome.runtime.sendMessage({ type: "CAPTURE_STARTED", sessionId });
}

function stopCapture() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
    recorder.stream.getTracks().forEach((t) => t.stop());
  }
  recorder = null;
  chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" });
}
