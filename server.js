const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || CLIENT_SECRET || "local-dev-secret";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TRANSLATION_PROVIDER = process.env.TRANSLATION_PROVIDER || "google";
const APP_COOKIE = "spotify_lyrics_app";
const SESSION_COOKIE = "spotify_lyrics_sid";
const SCOPE = "user-read-currently-playing user-read-playback-state";

const publicDir = path.join(__dirname, "public");
const spotifyAccounts = "https://accounts.spotify.com";
const spotifyApi = "https://api.spotify.com/v1";

const sessions = new Map();
const lyricCache = new Map();
const translationCache = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/unlock" && req.method === "GET") {
      return sendUnlockPage(res);
    }

    if (url.pathname === "/unlock" && req.method === "POST") {
      return handleUnlock(req, res);
    }

    if (isPublicAsset(url.pathname)) {
      return serveStatic(url.pathname, res);
    }

    if (!isAppUnlocked(req)) {
      if (url.pathname.startsWith("/api/")) {
        return sendJson(res, { error: "locked" }, 401);
      }

      res.writeHead(302, { Location: "/unlock" });
      return res.end();
    }

    if (url.pathname === "/api/config") {
      return sendJson(res, {
        configured: Boolean(CLIENT_ID && CLIENT_SECRET),
        redirectUri: REDIRECT_URI,
        lanUrls: getLanUrls(),
        protected: Boolean(APP_PASSWORD),
      });
    }

    if (url.pathname === "/login") {
      if (!CLIENT_ID || !CLIENT_SECRET) {
        return sendJson(res, { error: "missing_spotify_credentials" }, 500);
      }

      const { session, cookie } = getOrCreateSession(req);
      session.authState = crypto.randomBytes(16).toString("hex");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        scope: SCOPE,
        redirect_uri: REDIRECT_URI,
        state: session.authState,
      });

      res.writeHead(302, {
        Location: `${spotifyAccounts}/authorize?${params}`,
        ...(cookie ? { "Set-Cookie": cookie } : {}),
      });
      return res.end();
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const { session, cookie } = getOrCreateSession(req);

      if (!code || state !== session.authState) {
        return sendText(res, "Spotify login failed. Please try again.", 400);
      }

      session.tokenSet = await exchangeCodeForToken(code);
      session.authState = "";
      res.writeHead(302, {
        Location: "/",
        ...(cookie ? { "Set-Cookie": cookie } : {}),
      });
      return res.end();
    }

    if (url.pathname === "/logout") {
      const { session } = getOrCreateSession(req);
      session.tokenSet = null;
      session.authState = "";
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (url.pathname === "/api/now-playing") {
      const { session, cookie } = getOrCreateSession(req);
      const track = await getCurrentTrack(session);

      if (!track) {
        return sendJson(
          res,
          {
          authenticated: Boolean(session.tokenSet),
          playing: false,
          track: null,
          lyrics: null,
          },
          200,
          cookie,
        );
      }

      let lyrics = null;
      let translation = { text: "", source: "" };
      let lyricError = "";
      let translationError = "";

      try {
        lyrics = await getLyrics(track);
      } catch (error) {
        lyricError = error.message;
        console.warn(`Lyrics lookup failed: ${error.message}`);
      }

      if (lyrics) {
        try {
          translation = await getBestTranslation(track, lyrics, getRequestTranslationOptions(req));
        } catch (error) {
          translationError = error.message;
          console.warn(`Translation failed: ${error.message}`);
        }
      }

      return sendJson(
        res,
        {
          authenticated: true,
          playing: track.isPlaying,
          track,
          lyrics: lyrics ? buildLyricsResponse(lyrics, translation) : null,
          lyricError,
          translationError,
        },
        200,
        cookie,
      );
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: "server_error", message: error.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Spotify lyrics translator is running at http://127.0.0.1:${PORT}`);
  for (const url of getLanUrls()) console.log(`Phone URL: ${url}`);
});

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function getLanUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}`);
}

function isPublicAsset(pathname) {
  return ["/app.js", "/styles.css", "/favicon.ico"].includes(pathname);
}

function isAppUnlocked(req) {
  if (!APP_PASSWORD) return true;
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[APP_COOKIE] && verifySignedValue(cookies[APP_COOKIE], "unlocked");
}

function getOrCreateSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const signedSessionId = cookies[SESSION_COOKIE] || "";
  const sessionId = verifySignedPrefix(signedSessionId, "sid:");

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastSeen = Date.now();
    return { session, cookie: null };
  }

  const nextSessionId = crypto.randomBytes(24).toString("hex");
  const session = {
    id: nextSessionId,
    authState: "",
    tokenSet: null,
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  sessions.set(nextSessionId, session);

  return {
    session,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(signValue(`sid:${nextSessionId}`))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  };
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const eq = part.indexOf("=");
        if (eq === -1) return [part, ""];
        return [part.slice(0, eq), decodeURIComponent(part.slice(eq + 1))];
      }),
  );
}

function signValue(value) {
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
  return `${value}.${signature}`;
}

function verifySignedValue(signed, expectedValue) {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return false;

  const value = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  const expectedSigned = signValue(value);
  const expectedSignature = expectedSigned.slice(expectedSigned.lastIndexOf(".") + 1);

  return (
    value === expectedValue &&
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  );
}

function verifySignedPrefix(signed, prefix) {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return "";

  const value = signed.slice(0, dot);
  const signature = signed.slice(dot + 1);
  const expectedSigned = signValue(value);
  const expectedSignature = expectedSigned.slice(expectedSigned.lastIndexOf(".") + 1);

  if (
    !value.startsWith(prefix) ||
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    return "";
  }

  return value.slice(prefix.length);
}

async function handleUnlock(req, res) {
  const body = await readRequestBody(req);
  const params = new URLSearchParams(body);
  const password = params.get("password") || "";

  if (password !== APP_PASSWORD) {
    return sendUnlockPage(res, true);
  }

  res.writeHead(302, {
    Location: "/",
    "Set-Cookie": `${APP_COOKIE}=${encodeURIComponent(signValue("unlocked"))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
  });
  res.end();
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendUnlockPage(res, failed = false) {
  const error = failed ? '<p class="error">密碼不對，請再試一次。</p>' : "";
  const html = `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>解鎖 Spotify 歌詞翻譯</title>
    <style>
      * { box-sizing: border-box; }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: #101112;
        color: #f5f0e8;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
      }
      form {
        width: min(420px, calc(100vw - 32px));
        padding: 24px;
        border: 1px solid #34383c;
        border-radius: 8px;
        background: #191b1d;
      }
      h1 { margin: 0 0 10px; font-size: 28px; letter-spacing: 0; }
      p { margin: 0 0 18px; color: #b8b1a7; line-height: 1.5; }
      input, button {
        width: 100%;
        min-height: 44px;
        border-radius: 8px;
        font: inherit;
      }
      input {
        border: 1px solid #34383c;
        padding: 10px 12px;
        background: #101112;
        color: #f5f0e8;
      }
      button {
        margin-top: 12px;
        border: 0;
        background: #1ed760;
        color: #061208;
        font-weight: 800;
      }
      .error { color: #ffb4a8; }
    </style>
  </head>
  <body>
    <form method="post" action="/unlock">
      <h1>解鎖歌詞翻譯器</h1>
      <p>輸入你在 Render 設定的 APP_PASSWORD。</p>
      ${error}
      <input name="password" type="password" autocomplete="current-password" autofocus />
      <button type="submit">解鎖</button>
    </form>
  </body>
</html>`;

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const response = await fetch(`${spotifyAccounts}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Spotify token exchange failed: ${response.status}`);
  }

  const data = await response.json();
  return normalizeTokenSet(data);
}

async function refreshAccessToken(session) {
  if (!session.tokenSet?.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.tokenSet.refreshToken,
  });

  const response = await fetch(`${spotifyAccounts}/api/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    session.tokenSet = null;
    throw new Error(`Spotify token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  session.tokenSet = normalizeTokenSet(data, session.tokenSet.refreshToken);
  return session.tokenSet;
}

function normalizeTokenSet(data, fallbackRefreshToken = "") {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
}

async function getValidAccessToken(session) {
  if (!session.tokenSet) return null;
  if (Date.now() >= session.tokenSet.expiresAt) {
    await refreshAccessToken(session);
  }
  return session.tokenSet?.accessToken || null;
}

async function getCurrentTrack(session) {
  const accessToken = await getValidAccessToken(session);
  if (!accessToken) return null;

  const response = await fetch(`${spotifyApi}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (response.status === 403) {
    throw new Error("這個 Spotify 帳號還不能使用此 App。請到 Spotify Developer Dashboard 的 Users Management 把這個帳號加入名單。");
  }
  if (response.status === 401) {
    await refreshAccessToken(session);
    return getCurrentTrack(session);
  }
  if (!response.ok) {
    throw new Error(`Spotify now-playing failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data?.item || data.item.type !== "track") return null;

  const item = data.item;
  return {
    id: item.id,
    name: item.name,
    artists: item.artists.map((artist) => artist.name),
    album: item.album?.name || "",
    durationMs: item.duration_ms,
    progressMs: data.progress_ms || 0,
    serverTimeMs: Date.now(),
    isPlaying: Boolean(data.is_playing),
    image: item.album?.images?.[0]?.url || "",
    spotifyUrl: item.external_urls?.spotify || "",
  };
}

async function getLyrics(track) {
  if (lyricCache.has(track.id)) return lyricCache.get(track.id);

  const params = new URLSearchParams({
    artist_name: track.artists[0] || "",
    track_name: track.name,
    album_name: track.album || "",
    duration: String(Math.round(track.durationMs / 1000)),
  });

  let lyrics = null;
  const exact = await fetchJson(`https://lrclib.net/api/get?${params}`);

  if (exact?.plainLyrics || exact?.syncedLyrics || exact?.instrumental) {
    lyrics = normalizeLyrics(exact);
  } else {
    const searchParams = new URLSearchParams({
      q: `${track.name} ${track.artists.join(" ")}`,
    });
    const results = await fetchJson(`https://lrclib.net/api/search?${searchParams}`);
    const first = Array.isArray(results)
      ? results.find((item) => item.syncedLyrics || item.plainLyrics)
      : null;
    lyrics = first ? normalizeLyrics(first) : null;
  }

  lyricCache.set(track.id, lyrics);
  return lyrics;
}

function normalizeLyrics(raw) {
  const syncedLines = parseSyncedLyrics(raw.syncedLyrics || "");
  const plainLyrics = raw.plainLyrics || syncedLines.map((line) => line.text).join("\n");

  return {
    source: "LRCLIB",
    instrumental: Boolean(raw.instrumental),
    plainLyrics: raw.instrumental ? "Instrumental" : plainLyrics.trim(),
    syncedLines,
  };
}

function parseSyncedLyrics(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)$/);
      if (!match) return null;
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fraction = match[3] || "0";
      const ms = Number(fraction.padEnd(3, "0").slice(0, 3));
      const text = match[4].trim();
      if (!text) return null;
      return { timeMs: minutes * 60000 + seconds * 1000 + ms, text };
    })
    .filter(Boolean);
}

function getRequestTranslationOptions(req) {
  const provider = String(req.headers["x-translation-provider"] || "").toLowerCase();
  const apiKey = String(req.headers["x-translation-key"] || "").trim();
  const model = String(req.headers["x-translation-model"] || "").trim();

  return {
    provider: ["google", "openai", "deepseek", "gemini"].includes(provider) ? provider : "",
    apiKey,
    model,
  };
}

async function getBestTranslation(track, lyrics, userTranslation = {}) {
  return {
    ...await translateLyrics(lyrics.plainLyrics, userTranslation),
  };
}

async function getNetEaseTranslation(track, lyrics) {
  try {
    const candidates = await searchNetEaseSongs(track);

    for (const candidate of candidates) {
      const response = await fetchJson(
        `https://music.163.com/api/song/lyric?id=${candidate.id}&lv=1&kv=1&tv=1`,
        {
          Referer: "https://music.163.com/",
        },
      );
      const translatedLrc = response?.tlyric?.lyric || "";
      if (!translatedLrc.trim()) continue;

      const translatedLines = parseSyncedLyrics(translatedLrc);
      if (!translatedLines.length) continue;

      const aligned = alignTranslatedLyrics(lyrics, translatedLines);
      const text = aligned.lines.join("\n");
      if (text.trim()) {
        return { text, source: "NetEase translated lyrics", coverage: aligned.coverage };
      }
    }
  } catch (error) {
    console.warn(`NetEase translation lookup failed: ${error.message}`);
  }

  return null;
}

async function searchNetEaseSongs(track) {
  const query = encodeURIComponent(`${track.name} ${track.artists.join(" ")}`);
  const data = await fetchJson(`https://music.163.com/api/search/get/web?s=${query}&type=1&limit=8&offset=0`, {
    Referer: "https://music.163.com/",
  });
  const songs = data?.result?.songs || [];

  return songs
    .map((song) => ({
      id: song.id,
      name: song.name || "",
      durationMs: song.duration || 0,
      artists: (song.artists || []).map((artist) => artist.name || ""),
      score: scoreNetEaseSong(song, track),
    }))
    .filter((song) => song.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function scoreNetEaseSong(song, track) {
  const songName = normalizeSearchText(song.name || "");
  const trackName = normalizeSearchText(track.name || "");
  const songArtists = (song.artists || []).map((artist) => normalizeSearchText(artist.name || ""));
  const trackArtists = track.artists.map(normalizeSearchText);
  const durationDiff = Math.abs((song.duration || 0) - track.durationMs);

  let score = 0;
  if (songName === trackName) score += 4;
  else if (songName.includes(trackName) || trackName.includes(songName)) score += 2;

  if (songArtists.some((artist) => trackArtists.some((target) => artist.includes(target) || target.includes(artist)))) {
    score += 4;
  }

  if (durationDiff < 2500) score += 3;
  else if (durationDiff < 8000) score += 1;

  return score;
}

function normalizeSearchText(text) {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

function alignTranslatedLyrics(lyrics, translatedLines) {
  if (!lyrics.syncedLines.length) {
    const lines = translatedLines.map((line) => line.text);
    return { lines, coverage: lines.length ? 1 : 0 };
  }

  const lines = lyrics.syncedLines.map((line) => {
      const match = findClosestTimedLine(line.timeMs, translatedLines);
      return match && Math.abs(match.timeMs - line.timeMs) < 1600 ? match.text : "";
    });
  const translatedCount = lines.filter(Boolean).length;

  return {
    lines,
    coverage: lyrics.syncedLines.length ? translatedCount / lyrics.syncedLines.length : 0,
  };
}

function findClosestTimedLine(timeMs, lines) {
  let best = null;
  let bestDiff = Infinity;

  for (const line of lines) {
    const diff = Math.abs(line.timeMs - timeMs);
    if (diff < bestDiff) {
      best = line;
      bestDiff = diff;
    }
  }

  return best;
}

function buildLyricsResponse(lyrics, translation) {
  const translated = translation.text || "";
  const translatedLines = splitTranslatedLines(translated, true);
  const synced = lyrics.syncedLines.map((line, index) => ({
    ...line,
    translation: translatedLines[index] || "",
  }));

  return {
    source: lyrics.source,
    instrumental: lyrics.instrumental,
    original: lyrics.plainLyrics,
    translated,
    translationSource: translation.source || "",
    synced,
  };
}

function splitTranslatedLines(text, keepBlank = false) {
  const lines = (text || "").split(/\r?\n/).map((line) => line.trim());
  return keepBlank ? lines : lines.filter(Boolean);
}

function mergeMissingTranslatedLines(primaryText, fallbackText) {
  const primary = splitTranslatedLines(primaryText, true);
  const fallback = splitTranslatedLines(fallbackText, true);
  const length = Math.max(primary.length, fallback.length);
  const merged = [];

  for (let index = 0; index < length; index += 1) {
    merged.push(primary[index] || fallback[index] || "");
  }

  return merged.join("\n").trim();
}

async function translateLyrics(text, userTranslation = {}) {
  const cleanText = (text || "").trim();
  if (!cleanText || cleanText === "Instrumental") {
    return {
      text: cleanText === "Instrumental" ? "純音樂" : "",
      source: getMachineTranslationSource(userTranslation),
    };
  }

  const provider = getMachineTranslationProvider(userTranslation);
  const model = getMachineTranslationModel(provider, userTranslation);
  const keyHash = userTranslation.apiKey ? crypto.createHash("sha256").update(userTranslation.apiKey).digest("hex").slice(0, 12) : "server";
  const cacheKey = `${provider}:${model}:${keyHash}:${cleanText}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

  const result = await translateLyricsWithFallback(cleanText, userTranslation);

  translationCache.set(cacheKey, result);
  return result;
}

async function translateLyricsWithFallback(text, userTranslation = {}) {
  const provider = getMachineTranslationProvider(userTranslation);
  const apiKey = userTranslation.apiKey || "";
  const model = getMachineTranslationModel(provider, userTranslation);
  const isUserProvider = Boolean(userTranslation.provider && userTranslation.provider !== "server");

  if (isUserProvider && provider !== "google" && !apiKey) {
    throw new Error(`已選 ${getMachineTranslationSource(userTranslation)}，但還沒有填 API key。`);
  }

  if (isUserProvider && provider === "deepseek") {
    return { text: await translateLyricsWithDeepSeek(text, apiKey, model), source: `DeepSeek · ${model}` };
  }

  if (isUserProvider && provider === "openai") {
    return { text: await translateLyricsWithOpenAI(text, apiKey, model), source: `OpenAI · ${model}` };
  }

  if (isUserProvider && provider === "gemini") {
    return { text: await translateLyricsWithGemini(text, apiKey, model), source: `Gemini · ${model}` };
  }

  if (provider === "deepseek" && (apiKey || DEEPSEEK_API_KEY)) {
    try {
      return { text: await translateLyricsWithDeepSeek(text, apiKey || DEEPSEEK_API_KEY, model), source: "DeepSeek" };
    } catch (error) {
      console.warn(`DeepSeek translation unavailable, falling back: ${error.message}`);
    }
  }

  if (provider === "openai" && (apiKey || OPENAI_API_KEY)) {
    try {
      return { text: await translateLyricsWithOpenAI(text, apiKey || OPENAI_API_KEY, model), source: "OpenAI" };
    } catch (error) {
      console.warn(`OpenAI translation unavailable, falling back: ${error.message}`);
    }
  }

  if (provider === "gemini" && (apiKey || GEMINI_API_KEY)) {
    try {
      return { text: await translateLyricsWithGemini(text, apiKey || GEMINI_API_KEY, model), source: "Gemini" };
    } catch (error) {
      console.warn(`Gemini translation unavailable, falling back: ${error.message}`);
    }
  }

  return { text: await translateLyricsWithGoogle(text), source: "Google Translate" };
}

function getMachineTranslationSource(userTranslation = {}) {
  if (getMachineTranslationProvider(userTranslation) === "deepseek") return "DeepSeek";
  if (getMachineTranslationProvider(userTranslation) === "openai") return "OpenAI";
  if (getMachineTranslationProvider(userTranslation) === "gemini") return "Gemini";
  return "Google Translate";
}

function getMachineTranslationProvider(userTranslation = {}) {
  const provider = (userTranslation.provider || TRANSLATION_PROVIDER).toLowerCase();
  return ["google", "openai", "deepseek", "gemini"].includes(provider) ? provider : "google";
}

function getMachineTranslationModel(provider, userTranslation = {}) {
  if (userTranslation.model) return userTranslation.model;
  if (provider === "openai") return OPENAI_MODEL;
  if (provider === "deepseek") return DEEPSEEK_MODEL;
  if (provider === "gemini") return GEMINI_MODEL;
  return "";
}

async function translateLyricsWithGoogle(text) {
  const chunks = chunkText(text, 4200);
  const translated = [];

  for (const chunk of chunks) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", "zh-TW");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", chunk);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Translation failed: ${response.status}`);
    }

    const data = await response.json();
    translated.push((data?.[0] || []).map((part) => part?.[0] || "").join(""));
  }

  const result = translated.join("\n").trim();
  return result;
}

async function translateLyricsWithOpenAI(text, apiKey = OPENAI_API_KEY, model = OPENAI_MODEL) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = chunkLines(lines, 50);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const numberedLyrics = chunk.map((line, index) => `${index + 1}. ${line}`).join("\n");
    const prompt = [
      "你是專業歌詞翻譯助手。請把歌詞翻成自然、好懂、適合台灣讀者的繁體中文。",
      "要求：",
      "- 保留每一行的順序與行數。",
      "- 不要加入解釋、標題、編號或括號註記。",
      "- 可以意譯，讓語氣像中文歌詞或自然字幕，不要逐字硬翻。",
      "- 專有名詞、人名、品牌名通常保留原文。",
      "",
      "歌詞：",
      numberedLyrics,
    ].join("\n");

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: prompt,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI translation failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    translatedChunks.push(extractOpenAIText(data));
  }

  return translatedChunks.join("\n").trim();
}

async function translateLyricsWithDeepSeek(text, apiKey = DEEPSEEK_API_KEY, model = DEEPSEEK_MODEL) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = chunkLines(lines, 50);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const numberedLyrics = chunk.map((line, index) => `${index + 1}. ${line}`).join("\n");
    const messages = [
      {
        role: "system",
        content:
          "你是專業歌詞翻譯助手。請把歌詞翻成自然、好懂、適合台灣讀者的繁體中文。保留每一行的順序與行數，不要加入解釋、標題、編號或括號註記。可以意譯，讓語氣像中文歌詞或自然字幕，不要逐字硬翻。專有名詞、人名、品牌名通常保留原文。",
      },
      {
        role: "user",
        content: `歌詞：\n${numberedLyrics}`,
      },
    ];

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.4,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek translation failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    translatedChunks.push(data?.choices?.[0]?.message?.content?.trim() || "");
  }

  return translatedChunks.join("\n").trim();
}

async function translateLyricsWithGemini(text, apiKey = GEMINI_API_KEY, model = GEMINI_MODEL) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = chunkLines(lines, 50);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const numberedLyrics = chunk.map((line, index) => `${index + 1}. ${line}`).join("\n");
    const prompt = [
      "你是專業歌詞翻譯助手。請把歌詞翻成自然、好懂、適合台灣讀者的繁體中文。",
      "要求：",
      "- 保留每一行的順序與行數。",
      "- 不要加入解釋、標題、編號或括號註記。",
      "- 可以意譯，讓語氣像中文歌詞或自然字幕，不要逐字硬翻。",
      "- 專有名詞、人名、品牌名通常保留原文。",
      "",
      "歌詞：",
      numberedLyrics,
    ].join("\n");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini translation failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    translatedChunks.push(extractGeminiText(data));
  }

  return translatedChunks.join("\n").trim();
}

function extractGeminiText(data) {
  return (data.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function extractOpenAIText(data) {
  if (data.output_text) return data.output_text.trim();

  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("")
    .trim();
}

function chunkLines(lines, maxLines) {
  const chunks = [];
  for (let index = 0; index < lines.length; index += maxLines) {
    chunks.push(lines.slice(index, index + maxLines));
  }
  return chunks;
}

function chunkText(text, maxLength) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function fetchJson(url, extraHeaders = {}) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "spotify-lyrics-zh/0.1.0 (local personal app)",
      Accept: "application/json",
      ...extraHeaders,
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    return sendText(res, "Forbidden", 403);
  }

  fs.readFile(filePath, (error, data) => {
    if (error) return sendText(res, "Not found", 404);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream"
  );
}

function sendJson(res, value, status = 200, cookie = null) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(cookie ? { "Set-Cookie": cookie } : {}),
  });
  res.end(JSON.stringify(value));
}

function sendText(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(value);
}
