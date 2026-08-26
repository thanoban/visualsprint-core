/**
 * Offscreen document: runs MediaRecorder on the tab's audio stream.
 * Receives START_CAPTURE / STOP_CAPTURE from the background service worker.
 * Sends AUDIO_CHUNK messages back to the SW with each 5-second webm segment.
 */

let recorder = null;
let chunkSeq = 0;
let _audioCtx = null;
let _tabStream = null;
let _micStream = null;

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

  // Obtain the tab's audio stream from the tabCapture streamId. This is the
  // *other* participants' audio as rendered by the tab -- it does NOT include
  // the local user's own voice.
  _tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // Separately capture the local microphone so the session owner's own
  // speech isn't a silent gap in the transcript. If the user denies the mic
  // prompt, fall back to tab-only capture rather than failing the recording
  // entirely -- partial audio beats none.
  try {
    _micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    console.warn("[VS] microphone capture unavailable, recording tab audio only:", e.message);
    _micStream = null;
  }

  // Mix tab + mic into one stream for the recorder. Capturing tabCapture
  // audio silently redirects it away from the speakers, so the tab source is
  // also reconnected to the AudioContext's own destination to keep the
  // meeting audible to the user. The mic source is NOT connected to that
  // destination -- doing so would echo the user's own voice back to them.
  _audioCtx = new AudioContext();
  const dest = _audioCtx.createMediaStreamDestination();

  const tabSource = _audioCtx.createMediaStreamSource(_tabStream);
  tabSource.connect(dest);
  tabSource.connect(_audioCtx.destination);

  if (_micStream) {
    const micSource = _audioCtx.createMediaStreamSource(_micStream);
    micSource.connect(dest);
  }

  // Pick the best supported audio codec
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  recorder = new MediaRecorder(dest.stream, { mimeType });

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
  }
  recorder = null;

  _tabStream?.getTracks().forEach((t) => t.stop());
  _micStream?.getTracks().forEach((t) => t.stop());
  _tabStream = null;
  _micStream = null;

  _audioCtx?.close().catch(() => {});
  _audioCtx = null;

  chrome.runtime.sendMessage({ type: "CAPTURE_STOPPED" });
}
