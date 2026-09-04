// SRE Helper — offscreen ringtone player.
//
// Receives "CHAT_PLAY_RING_OFFSCREEN" from the service worker and plays the
// ringtone's data URL with an HTMLAudioElement. Chrome grants offscreen
// documents created with the AUDIO_PLAYBACK reason unrestricted playback, so
// this is the reliable path for ringing when the user is NOT interacting with
// the chat tab (which is exactly when a ringtone matters).
//
// Keep a reference to every playing element until it finishes — if the element
// is garbage-collected mid-play Chrome cuts the audio off.

const _players = [];

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CHAT_PLAY_RING_OFFSCREEN") return false;
  if (!msg.dataUrl) {
    sendResponse({ ok: false, reason: "no-data-url" });
    return false;
  }

  let audio;
  try {
    audio = new Audio(msg.dataUrl);
  } catch (e) {
    sendResponse({ ok: false, reason: String(e) });
    return false;
  }

  audio.volume = 1.0;
  audio.play().then(
    () => {
      _players.push(audio); // keep GC from cutting playback short
      sendResponse({ ok: true });
    },
    (err) => {
      sendResponse({
        ok: false,
        reason: (err && err.message) || String(err),
      });
    }
  );

  audio.addEventListener("ended", () => {
    const idx = _players.indexOf(audio);
    if (idx >= 0) _players.splice(idx, 1);
  });

  return true; // keep the messaging channel open for the async response
});
