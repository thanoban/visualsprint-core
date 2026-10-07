document.getElementById("allow").addEventListener("click", async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    document.getElementById("result").textContent = "Microphone enabled. Close this tab, join your meeting and click the VisualSprint icon.";
  } catch (error) {
    document.getElementById("result").textContent = `Microphone unavailable: ${error.message}. Tab audio can still be captured, with your voice marked missing.`;
  }
});
