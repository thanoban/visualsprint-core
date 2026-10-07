/** MV3 offscreen recorder: target-tab audio/video, microphone, and flush ACK. */
let recorder, tabStream, micStream, audioContext, micGain, video, frameTimer;
let sessionId, chunkSeq = 0, frameSeq = 0, startedAt, microphoneCaptured = false;
let writes = Promise.resolve(), stopping = null, previousFrame = null;
let initialMicMuted = false;
const MAX_CAPTURE_MS = 5 * 3600 * 1000;
let safetyTimer;

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "START_CAPTURE") {
    startCapture(msg).then(() => respond({ ok: true, microphoneCaptured }))
      .catch(async (error) => {
        if (sessionId === msg.sessionId) cleanup();
        respond({ ok: false, error: error.message });
      });
    return true;
  }
  if (msg.type === "STOP_CAPTURE") {
    stopCapture(false).then(respond).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === "MIC_STATE" && micGain) {
    micGain.gain.value = msg.muted ? 0 : 1;
    respond({ ok: true });
  }
});

async function persist(message) {
  const response = await chrome.runtime.sendMessage({ target: "background", ...message });
  if (!response?.ok) throw new Error(response?.error ?? "Capture media was not persisted");
}

function queueWrite(message) {
  writes = writes.then(() => persist(message));
  writes.catch((error) => {
    chrome.runtime.sendMessage({ target: "background", type: "OFFSCREEN_ERROR", sessionId, error: error.message });
  });
}

async function startCapture(msg) {
  if (recorder && recorder.state !== "inactive") throw new Error("Another tab is already recording");
  sessionId = msg.sessionId;
  chunkSeq = frameSeq = 0;
  writes = Promise.resolve();
  stopping = null;
  previousFrame = null;
  initialMicMuted = !!msg.micMuted;
  startedAt = Date.now();
  microphoneCaptured = false;
  const constraints = { chromeMediaSource: "tab", chromeMediaSourceId: msg.streamId };
  // Consumes the user-invoked ID immediately; no remote API calls intervene.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: constraints },
    video: { mandatory: constraints },
  });
  audioContext = new AudioContext();
  await audioContext.resume();
  if (audioContext.state !== "running") throw new Error("Meeting audio playback could not start");
  const destination = audioContext.createMediaStreamDestination();
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(destination);
  tabSource.connect(audioContext.destination);
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    micGain = audioContext.createGain();
    micGain.gain.value = initialMicMuted ? 0 : 1;
    audioContext.createMediaStreamSource(micStream).connect(micGain);
    micGain.connect(destination);
    microphoneCaptured = true;
  } catch {
    micStream = null; // Explicit metadata discloses the local-voice gap.
  }
  video = document.createElement("video");
  video.srcObject = tabStream;
  video.muted = true;
  await video.play();
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus" : "audio/webm";
  recorder = new MediaRecorder(destination.stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (!event.data?.size) return;
    const seq = chunkSeq++;
    writes = writes.then(async () => persist({
      type: "AUDIO_CHUNK", sessionId, seq,
      chunk: Array.from(new Uint8Array(await event.data.arrayBuffer())),
    }));
    writes.catch((error) => {
      chrome.runtime.sendMessage({ target: "background", type: "OFFSCREEN_ERROR", sessionId, error: error.message });
    });
  };
  recorder.start(5000);
  frameTimer = setInterval(captureFrame, 15000);
  safetyTimer = setTimeout(() => stopCapture(), MAX_CAPTURE_MS);
  await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_STARTED", sessionId, microphoneCaptured });
  captureFrame();
  // A tab close/track end must flush even if its content script cannot send end.
  tabStream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => stopCapture()));
}

function captureFrame() {
  if (!video?.videoWidth || frameSeq >= 600 || stopping) return;
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(1280, video.videoWidth);
  canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const signatureCanvas = document.createElement("canvas");
  signatureCanvas.width = 32; signatureCanvas.height = 18;
  const context = signatureCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, 0, 0, 32, 18);
  const pixels = context.getImageData(0, 0, 32, 18).data;
  let delta = 0;
  if (previousFrame) {
    for (let i = 0; i < pixels.length; i += 4) delta += Math.abs(pixels[i] - previousFrame[i]);
    if (delta / (32 * 18) < 10) return;
  }
  previousFrame = new Uint8ClampedArray(pixels);
  const bytes = Uint8Array.from(atob(canvas.toDataURL("image/jpeg", 0.65).split(",")[1]), (c) => c.charCodeAt(0));
  queueWrite({ type: "KEYFRAME", sessionId, seq: frameSeq++,
    timestampS: (Date.now() - startedAt) / 1000, chunk: Array.from(bytes) });
}

function cleanup() {
  clearInterval(frameTimer);
  clearTimeout(safetyTimer);
  tabStream?.getTracks().forEach((track) => track.stop());
  micStream?.getTracks().forEach((track) => track.stop());
  tabStream = micStream = micGain = video = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
  recorder = null;
}

function stopCapture(notifyBackground = true) {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(frameTimer);
    clearTimeout(safetyTimer);
    if (recorder && recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.stop(); // Final dataavailable is emitted before onstop.
      });
    }
    let error;
    try { await writes; } catch (e) { error = e.message; }
    const result = { ok: !error, error, sessionId, totalChunks: chunkSeq,
      microphoneCaptured, durationS: (Date.now() - startedAt) / 1000 };
    cleanup();
    if (notifyBackground) chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_STOPPED", ...result });
    return result;
  })();
  return stopping;
}
