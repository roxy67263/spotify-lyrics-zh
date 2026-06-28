const els = {
  cover: document.querySelector("#cover"),
  coverFallback: document.querySelector("#coverFallback"),
  status: document.querySelector("#status"),
  title: document.querySelector("#title"),
  artist: document.querySelector("#artist"),
  login: document.querySelector("#login"),
  progressBar: document.querySelector("#progressBar"),
  phoneHint: document.querySelector("#phoneHint"),
  settingsToggle: document.querySelector("#settingsToggle"),
  settingsPanel: document.querySelector("#settingsPanel"),
  providerSelect: document.querySelector("#providerSelect"),
  apiKeyInput: document.querySelector("#apiKeyInput"),
  modelInput: document.querySelector("#modelInput"),
  saveSettings: document.querySelector("#saveSettings"),
  settingsStatus: document.querySelector("#settingsStatus"),
  syncedLyrics: document.querySelector("#syncedLyrics"),
  source: document.querySelector("#source"),
};

const settingsKey = "spotifyLyricsTranslatorSettings";
let lastTrackId = "";
let currentTrack = null;
let currentLyrics = null;
let activeLineIndex = -1;
let localProgressOffsetMs = 0;

init();

async function init() {
  loadTranslationSettings();
  bindSettings();

  const config = await getJson("/api/config");
  renderPhoneHint(config);

  if (!config.configured) {
    els.status.textContent = "尚未設定 Spotify API";
    els.title.textContent = "需要先填好環境變數";
    els.artist.textContent = `Redirect URI：${config.redirectUri}`;
    els.login.style.display = "none";
    renderMessage("請在 Render 設定 Spotify Client ID 與 Secret。");
    return;
  }

  await refresh();
  window.setInterval(refresh, 2500);
  window.setInterval(tickPlayback, 250);
}

function bindSettings() {
  els.settingsToggle.addEventListener("click", () => {
    els.settingsPanel.hidden = !els.settingsPanel.hidden;
  });

  els.saveSettings.addEventListener("click", () => {
    const settings = {
      provider: els.providerSelect.value,
      apiKey: els.apiKeyInput.value.trim(),
      model: els.modelInput.value.trim(),
    };
    window.localStorage.setItem(settingsKey, JSON.stringify(settings));
    els.settingsStatus.textContent = "已儲存在這個瀏覽器。請重新整理或換歌後套用。";
  });

  els.providerSelect.addEventListener("change", () => {
    if (els.providerSelect.value === "google" || els.providerSelect.value === "server") {
      els.apiKeyInput.placeholder = "不需要 API key";
    } else {
      els.apiKeyInput.placeholder = "只存在你的瀏覽器";
    }
  });
}

function loadTranslationSettings() {
  const settings = getTranslationSettings();
  els.providerSelect.value = settings.provider || "server";
  els.apiKeyInput.value = settings.apiKey || "";
  els.modelInput.value = settings.model || "";
}

function getTranslationSettings() {
  try {
    return JSON.parse(window.localStorage.getItem(settingsKey) || "{}");
  } catch {
    return {};
  }
}

async function refresh() {
  try {
    const data = await getJson("/api/now-playing");

    if (!data.authenticated) {
      showLoggedOut();
      return;
    }

    els.login.textContent = "登出";
    els.login.href = "/logout";

    if (!data.track) {
      currentTrack = null;
      currentLyrics = null;
      showIdle("Spotify 沒有正在播放的歌曲");
      return;
    }

    currentTrack = data.track;
    currentLyrics = data.lyrics;
    localProgressOffsetMs = Date.now() - data.track.serverTimeMs;

    renderTrack(data.track, data.playing);
    renderLyrics(data);
    tickPlayback();
  } catch (error) {
    els.status.textContent = "讀取失敗";
    renderMessage(error.message || "暫時無法讀取。");
  }
}

function renderPhoneHint(config) {
  const host = window.location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    host.startsWith("172.");

  if (!isLocal) {
    els.phoneHint.textContent = `手機或外網開：${window.location.origin}`;
    return;
  }

  const urls = config.lanUrls || [];
  els.phoneHint.textContent = urls.length
    ? `手機同 Wi-Fi 開：${urls[0]}`
    : "手機和電腦連同一個 Wi-Fi 後，用電腦 IP 開啟這個 App。";
}

function showLoggedOut() {
  els.status.textContent = "尚未登入";
  els.title.textContent = "Spotify 歌詞翻譯";
  els.artist.textContent = "登入後會自動偵測你正在播放的歌曲。";
  els.login.textContent = "登入 Spotify";
  els.login.href = "/login";
  els.progressBar.style.width = "0%";
}

function showIdle(message) {
  els.status.textContent = message;
  els.title.textContent = "等待播放";
  els.artist.textContent = "播放 Spotify 歌曲後，這裡會自動更新。";
  els.progressBar.style.width = "0%";
  els.source.textContent = "-";
  renderMessage("等待歌曲...");
}

function renderTrack(track, isPlaying) {
  els.status.textContent = isPlaying ? "正在播放" : "已暫停";
  els.title.textContent = track.name;
  els.artist.textContent = `${track.artists.join(", ")} · ${track.album}`;
  els.progressBar.style.width = `${Math.min(100, (track.progressMs / track.durationMs) * 100)}%`;

  if (track.image) {
    els.cover.src = track.image;
    els.cover.style.display = "block";
    els.coverFallback.style.display = "none";
  } else {
    els.cover.removeAttribute("src");
    els.cover.style.display = "none";
    els.coverFallback.style.display = "grid";
  }
}

function renderLyrics(data) {
  if (lastTrackId === data.track.id) return;

  lastTrackId = data.track.id;
  activeLineIndex = -1;

  if (!data.lyrics) {
    els.source.textContent = "-";
    renderMessage(data.lyricError ? `歌詞暫時讀取失敗：${data.lyricError}` : "找不到這首歌的歌詞。");
    return;
  }

  const sourceParts = [data.lyrics.source];
  if (data.lyrics.translationSource) sourceParts.push(data.lyrics.translationSource);
  if (data.translationError && !data.lyrics.translationSource) sourceParts.push("翻譯暫時失敗");
  if (data.lyrics.synced?.length) sourceParts.push("逐句同步");
  els.source.textContent = sourceParts.join(" · ");

  if (data.lyrics.synced?.length) {
    els.syncedLyrics.innerHTML = data.lyrics.synced
      .map(
        (line, index) => `
          <div class="lyric-line" data-index="${index}" data-time="${line.timeMs}">
            <p class="original">${escapeHtml(line.text)}</p>
            <p class="translation">${escapeHtml(line.translation || "")}</p>
          </div>
        `,
      )
      .join("");
    return;
  }

  if (data.translationError && !data.lyrics.translated) {
    els.source.textContent = `${data.lyrics.source} · 翻譯暫時失敗`;
  }

  const originalLines = (data.lyrics.original || "").split(/\r?\n/);
  const translatedLines = (data.lyrics.translated || "").split(/\r?\n/);
  els.syncedLyrics.innerHTML = originalLines
    .map(
      (line, index) => `
        <div class="lyric-line static-line">
          <p class="original">${escapeHtml(line)}</p>
          <p class="translation">${escapeHtml(translatedLines[index] || "")}</p>
        </div>
      `,
    )
    .join("");
}

function tickPlayback() {
  if (!currentTrack) return;

  const elapsed = currentTrack.isPlaying ? Date.now() - currentTrack.serverTimeMs - localProgressOffsetMs : 0;
  const progressMs = Math.min(currentTrack.durationMs, currentTrack.progressMs + Math.max(0, elapsed));
  els.progressBar.style.width = `${Math.min(100, (progressMs / currentTrack.durationMs) * 100)}%`;

  const lines = currentLyrics?.synced || [];
  if (!lines.length) return;

  let nextIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs <= progressMs + 350) nextIndex = index;
    else break;
  }

  if (nextIndex !== activeLineIndex) {
    setActiveLine(nextIndex);
  }
}

function setActiveLine(index) {
  const previous = els.syncedLyrics.querySelector(".lyric-line.active");
  if (previous) previous.classList.remove("active");

  const next = els.syncedLyrics.querySelector(`[data-index="${index}"]`);
  if (!next) return;

  activeLineIndex = index;
  next.classList.add("active");
  next.scrollIntoView({ block: "center", behavior: "smooth" });
}

function renderMessage(message) {
  els.syncedLyrics.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: buildTranslationHeaders(),
  });
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (text.trim().startsWith("<!doctype") || text.trim().startsWith("<html")) {
      throw new Error("伺服器回傳了網頁，不是資料。請重新整理，或回到首頁重新解鎖。");
    }
    throw new Error("伺服器回傳格式不正確，請稍後再試。");
  }

  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = "/unlock";
      throw new Error("需要重新解鎖。");
    }
    throw new Error(data.message || data.error || `Request failed: ${response.status}`);
  }

  return data;
}

function buildTranslationHeaders() {
  const settings = getTranslationSettings();
  const headers = {};

  if (settings.provider && settings.provider !== "server") {
    headers["X-Translation-Provider"] = settings.provider;
  }
  if (settings.apiKey) {
    headers["X-Translation-Key"] = settings.apiKey;
  }
  if (settings.model) {
    headers["X-Translation-Model"] = settings.model;
  }

  return headers;
}
