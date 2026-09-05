// SRE Helper — offscreen ringtone player.
//
// Receives "CHAT_PLAY_RING_OFFSCREEN" from the service worker and plays the
// ringtone's data URL with an HTMLAudioElement. Chrome grants offscreen
// documents created with the AUDIO_PLAYBACK reason unrestricted playback, so
// this is the reliable path for ringing when the user is NOT interacting with
// the chat tab (which is exactly when a ringtone matters).
//
// Serialized FIFO playback: when several spaces ring at nearly the same time
// the audio elements would otherwise play ON TOP of each other (two ringtones
// layered into noise). Here only one ringtone sounds at a time; any messages
// that arrive mid-play are queued and start one after the previous one ends.
//
// Keep a reference to the currently sounding element until it finishes — if
// the element is garbage-collected mid-play Chrome cuts the audio off.

// FIFO of pending ring requests: [{ dataUrl, respond }]. respond is called
// (ok:true) once that request's audio has actually started, ok:false if it
// failed to even start.
const _ringQueue = [];
let _current = null; // the AudioElement currently sounding (also guards GC)

function pumpRingQueue() {
  if (_current) return; // one ringtone at a time
  const job = _ringQueue.shift();
  if (!job) return;

  let audio;
  try {
    audio = new Audio(job.dataUrl);
  } catch (e) {
    job.respond({ ok: false, reason: String(e) });
    return pumpRingQueue(); // try the next queued ring
  }

  // The element that was actually handed to play() is the one that keeps
  // playing; a play() rejection or an ended/error event frees the slot.
  _current = audio;
  let settled = false;
  const freeSlot = () => {
    if (settled) return; // ended && error can both fire for one element
    settled = true;
    _current = null;
    pumpRingQueue();
  };
  audio.addEventListener("ended", freeSlot);
  audio.addEventListener("error", freeSlot);

  audio.volume = 1.0;
  audio.play().then(
    () => {
      job.respond({ ok: true });
    },
    (err) => {
      job.respond({
        ok: false,
        reason: (err && err.message) || String(err),
      });
      freeSlot();
    }
  );
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "CHAT_PLAY_RING_OFFSCREEN") return false;
  if (!msg.dataUrl) {
    sendResponse({ ok: false, reason: "no-data-url" });
    return false;
  }
  _ringQueue.push({ dataUrl: msg.dataUrl, respond: sendResponse });
  pumpRingQueue();
  return true; // keep the messaging channel open for the async response
});
