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
const APP_COOKIE = "spotify_lyrics_app";
const SCOPE = "user-read-currently-playing user-read-playback-state";

const publicDir = path.join(__dirname, "public");
const spotifyAccounts = "https://accounts.spotify.com";
const spotifyApi = "https://api.spotify.com/v1";

let authState = "";
let tokenSet = null;
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

      authState = crypto.randomBytes(16).toString("hex");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        scope: SCOPE,
        redirect_uri: REDIRECT_URI,
        state: authState,
      });

      res.writeHead(302, { Location: `${spotifyAccounts}/authorize?${params}` });
      return res.end();
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (!code || state !== authState) {
        return sendText(res, "Spotify login failed. Please try again.", 400);
      }

      tokenSet = await exchangeCodeForToken(code);
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (url.pathname === "/logout") {
      tokenSet = null;
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (url.pathname === "/api/now-playing") {
      const track = await getCurrentTrack();

      if (!track) {
        return sendJson(res, {
          authenticated: Boolean(tokenSet),
          playing: false,
          track: null,
          lyrics: null,
        });
      }

      const lyrics = await getLyrics(track);
      const translated = lyrics ? await translateLyrics(lyrics.plainLyrics) : "";

      return sendJson(res, {
        authenticated: true,
        playing: track.isPlaying,
        track,
        lyrics: lyrics ? buildLyricsResponse(lyrics, translated) : null,
      });
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

function isAppUnlocked(req) {
  if (!APP_PASSWORD) return true;
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[APP_COOKIE] && verifySignedValue(cookies[APP_COOKIE], "unlocked");
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

async function refreshAccessToken() {
  if (!tokenSet?.refreshToken) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenSet.refreshToken,
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
    tokenSet = null;
    throw new Error(`Spotify token refresh failed: ${response.status}`);
  }

  const data = await response.json();
  tokenSet = normalizeTokenSet(data, tokenSet.refreshToken);
  return tokenSet;
}

function normalizeTokenSet(data, fallbackRefreshToken = "") {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + (data.expires_in - 30) * 1000,
  };
}

async function getValidAccessToken() {
  if (!tokenSet) return null;
  if (Date.now() >= tokenSet.expiresAt) {
    await refreshAccessToken();
  }
  return tokenSet?.accessToken || null;
}

async function getCurrentTrack() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return null;

  const response = await fetch(`${spotifyApi}/me/player/currently-playing`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (response.status === 401) {
    await refreshAccessToken();
    return getCurrentTrack();
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

function buildLyricsResponse(lyrics, translated) {
  const translatedLines = splitTranslatedLines(translated);
  const synced = lyrics.syncedLines.map((line, index) => ({
    ...line,
    translation: translatedLines[index] || "",
  }));

  return {
    source: lyrics.source,
    instrumental: lyrics.instrumental,
    original: lyrics.plainLyrics,
    translated,
    synced,
  };
}

function splitTranslatedLines(text) {
  return (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function translateLyrics(text) {
  const cleanText = (text || "").trim();
  if (!cleanText || cleanText === "Instrumental") {
    return cleanText === "Instrumental" ? "純音樂" : "";
  }
  if (translationCache.has(cleanText)) return translationCache.get(cleanText);

  const chunks = chunkText(cleanText, 4200);
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
  translationCache.set(cleanText, result);
  return result;
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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "spotify-lyrics-zh/0.1.0 (local personal app)",
      Accept: "application/json",
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

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function sendText(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(value);
}
