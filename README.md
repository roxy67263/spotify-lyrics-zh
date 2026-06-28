# Spotify 歌詞中文翻譯器

這是一個網頁 App：它會讀取你 Spotify 目前正在播放的歌曲，搜尋歌詞，翻譯成繁體中文，並在有同步歌詞時高亮目前唱到的句子。

## 本機使用

1. 到 Spotify Developer Dashboard 建立 App。
2. 在 Spotify App 的 Redirect URIs 加入：

   ```text
   http://127.0.0.1:3000/callback
   ```

3. 複製 `.env.example` 成 `.env`，填入 `SPOTIFY_CLIENT_ID` 和 `SPOTIFY_CLIENT_SECRET`。
4. 啟動：

   ```bash
   npm start
   ```

5. 打開：

   ```text
   http://127.0.0.1:3000
   ```

## 固定外網網址

本機 ngrok 固定網址：

```text
https://argue-panoramic-untrimmed.ngrok-free.dev
```

雙擊 `啟動固定網址.bat` 可以同時開本機 App 和 ngrok。這種方式需要你的電腦保持開機。

## Render 雲端部署

如果你希望電腦關機後也能用，請部署到 Render。

### 需要填的環境變數

在 Render 的 Environment 裡加入：

```text
SPOTIFY_CLIENT_ID=你的 Spotify Client ID
SPOTIFY_CLIENT_SECRET=你的 Spotify Client Secret
SPOTIFY_REDIRECT_URI=https://你的-render網址.onrender.com/callback
APP_PASSWORD=你自己設定的登入密碼
TRANSLATION_PROVIDER=google
OPENAI_API_KEY=可選，填了翻譯會更自然
OPENAI_MODEL=gpt-5.4-mini
DEEPSEEK_API_KEY=可選，填了會用低成本 DeepSeek 翻譯
DEEPSEEK_MODEL=deepseek-v4-flash
GEMINI_API_KEY=可選，Google AI Studio / Gemini API key
GEMINI_MODEL=gemini-2.5-flash
```

`SESSION_SECRET` 可以讓 Render 自動產生，或自己填一串很長的隨機文字。

### Spotify Redirect URI

Render 部署完成後，會有一個網址，例如：

```text
https://spotify-lyrics-zh.onrender.com
```

請回到 Spotify Developer Dashboard，把這個加入 Redirect URIs：

```text
https://spotify-lyrics-zh.onrender.com/callback
```

同時 Render 的 `SPOTIFY_REDIRECT_URI` 也要填一模一樣的網址。

## 備註

- Spotify 官方 Web API 可以取得目前播放歌曲，但不提供歌詞。
- 歌詞來源使用 LRCLIB；有些歌曲可能找不到歌詞。
- 如果 LRCLIB 有同步歌詞，App 會跟著 Spotify 播放進度高亮目前句子。
- 每個瀏覽器都有自己的 Spotify 登入狀態，不同使用者不會互相覆蓋。
- 每個人也可以在「翻譯設定」輸入自己的 Gemini/OpenAI/DeepSeek API key；key 只存在該瀏覽器，不會存到伺服器。
- 預設使用免金鑰的 Google Translate 網路端點，不需要付費 API 額度。
- 如果之後想改用 Gemini、DeepSeek 或 OpenAI，可以把 `TRANSLATION_PROVIDER` 改成 `gemini`、`deepseek` 或 `openai`，再填對應 API key。
