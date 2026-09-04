/* ---------- Ringtones ---------- */

let ringtones = [];
let _previewAudio = null;

function persistRingtones() {
  chrome.storage.local.set({ sreRingtones: ringtones });
}

function ringtoneReferencedCount(ringtoneId) {
  return chatRules.filter((r) => r.ringtoneId === ringtoneId).length;
}

function formatSizeKB(bytes) {
  if (!bytes) return "— KB";
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

function stopPreview() {
  if (_previewAudio) {
    try { _previewAudio.pause(); } catch (_) {}
    _previewAudio = null;
  }
}

function playPreview(dataUrl) {
  stopPreview();
  if (!dataUrl) return;
  try {
    const a = new Audio(dataUrl);
    a.volume = 1.0;
    a.play().catch(() => {});
    a.addEventListener("ended", () => { if (_previewAudio === a) _previewAudio = null; });
    _previewAudio = a;
  } catch (_) {}
}

function readAudioFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result, mime: file.type });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function durationClass(sec) {
  if (sec == null) return "";
  if (sec <= 2) return "short";
  if (sec >= 5) return "long";
  return "";
}

function renderRingtones() {
  const wrap = document.getElementById("ringtonesList");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (ringtones.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ring-empty";
    empty.textContent = "No ringtones uploaded yet. Click + Upload ringtone to add mp3 / wav / ogg.";
    wrap.appendChild(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "ring-list";

  for (const r of ringtones) {
    const item = document.createElement("div");
    item.className = "ring-item";

    const main = document.createElement("div");
    main.className = "ring-item-main";
    const title = document.createElement("div");
    title.className = "ring-item-title";
    title.textContent = r.name || "(unnamed)";
    const meta = document.createElement("div");
    meta.className = "ring-item-meta";
    const durChip = document.createElement("span");
    durChip.className = `ring-chip ${durationClass(r.durationSec)}`;
    durChip.textContent = r.durationSec != null ? `${r.durationSec.toFixed(1)}s` : "—s";
    meta.appendChild(durChip);
    const fmt = document.createElement("span");
    fmt.className = "ring-chip";
    fmt.textContent = (r.mime || r.format || "audio").split("/").pop().toUpperCase();
    meta.appendChild(fmt);
    const size = document.createElement("span");
    size.className = "ring-chip";
    size.textContent = formatSizeKB(r.sizeBytes);
    meta.appendChild(size);
    const refs = ringtoneReferencedCount(r.id);
    if (refs > 0) {
      const used = document.createElement("span");
      used.className = "ref-badge";
      used.textContent = `used ${refs} rule${refs === 1 ? "" : "s"}`;
      meta.appendChild(used);
    }
    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "ring-actions";
    const chipPlay = document.createElement("span");
    chipPlay.className = "ring-chip-play";
    chipPlay.innerHTML = `<span>${r.name || "audio"}</span>`;
    const btnPlay = document.createElement("button");
    btnPlay.className = "btn-mini-play";
    btnPlay.title = "Preview";
    btnPlay.textContent = "▶";
    btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      playPreview(r.dataUrl);
    });
    chipPlay.appendChild(btnPlay);
    actions.appendChild(chipPlay);

    const btnDel = document.createElement("button");
    btnDel.className = "row-btn danger";
    btnDel.textContent = "Del";
    btnDel.title = "Delete ringtone";
    if (refs > 0) {
      btnDel.disabled = true;
      btnDel.style.opacity = "0.45";
      btnDel.style.cursor = "not-allowed";
      btnDel.title = `Still used by ${refs} rule(s). Unlink first.`;
    } else {
      btnDel.addEventListener("click", () => {
        stopPreview();
        ringtones = ringtones.filter((x) => x.id !== r.id);
        persistRingtones();
      });
    }
    actions.appendChild(btnDel);

    item.appendChild(main);
    item.appendChild(actions);
    list.appendChild(item);
  }
  wrap.appendChild(list);
}

async function addRingtonesFromFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  for (const f of files) {
    try {
      if (!f.type.startsWith("audio/") && !/\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name)) continue;
      const { dataUrl, mime } = await readAudioFileAsDataURL(f);
      // Best-effort duration probe: load in an offscreen Audio() element; if
      // metadata load is slow (> 1.5s) just record null.
      let durationSec = null;
      try {
        durationSec = await new Promise((resolve) => {
          const a = new Audio(dataUrl);
          let settled = false;
          const done = (v) => { if (!settled) { settled = true; resolve(v); } };
          a.addEventListener("loadedmetadata", () => done(a.duration && isFinite(a.duration) ? a.duration : null));
          a.addEventListener("error", () => done(null));
          setTimeout(() => done(null), 1500);
        });
      } catch (_) {}
      const base = f.name.replace(/\.[^.]+$/, "");
      ringtones.push({
        id: uid(),
        name: base,
        durationSec,
        mime: mime || f.type || "audio/*",
        dataUrl,
        sizeBytes: f.size || 0,
        createdAt: Date.now(),
      });
    } catch (e) {
      console.warn("ringtone upload failed:", f.name, e);
    }
  }
  persistRingtones();
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("addRingtoneBtn");
  const input = document.getElementById("ringtoneFileInput");
  if (btn && input) {
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => {
      addRingtonesFromFiles(e.target.files);
      // reset so same file picked again still fires change
      e.target.value = "";
    });
  }
});

