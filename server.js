const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = parseInt(process.env.PORT) || 3000;
const API_TOKEN = process.env.API_TOKEN || '';
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const DOUBAO_CHAT_API = process.env.DOUBAO_CHAT_API || 'https://www.doubao.com/chat/completion';
const DOUBAO_ORIGIN = process.env.DOUBAO_ORIGIN || 'https://www.doubao.com';

let storedCookies = '';

if (fs.existsSync(COOKIES_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
    storedCookies = data.cookies || '';
  } catch (e) {}
}

function authMiddleware(req, res, next) {
  if (!API_TOKEN) return next();
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== API_TOKEN) return res.status(401).json({ error: 'Invalid API token' });
  next();
}

function parseSSEResponse(text) {
  const images = [];
  const seen = new Set();
  for (const line of text.split('\n')) {
    let d = line.trim();
    if (d.startsWith('data: ')) d = d.slice(6);
    else if (d.startsWith('data:')) d = d.slice(5);
    if (!d.startsWith('{')) continue;
    try {
      const data = JSON.parse(d);
      extractImages(data, images, seen);
      for (const op of (data?.patch_op || [])) {
        for (const block of (op?.patch_value?.content_block || [])) {
          extractImages(block, images, seen);
        }
      }
    } catch (_) {}
  }
  return images;
}

function extractImages(data, images, seen) {
  const blockArr = Array.isArray(data?.content_block) ? data.content_block : [data];
  for (const block of blockArr) {
    for (const c of (block?.content?.creation_block?.creations || [])) {
      const raw = c?.image?.image_ori_raw;
      if (!raw?.url || seen.has(raw.url)) continue;
      seen.add(raw.url);
      images.push({ no_watermark_url: raw.url, watermark_url: c?.image?.image_thumb?.url || null, width: raw.width || null, height: raw.height || null });
    }
  }
}

async function callDoubaoChat(prompt, model, ratio, cookies) {
  const cookiesToUse = cookies || storedCookies;
  if (!cookiesToUse) throw new Error('No cookies set. Call POST /api/auth/cookies first or pass cookies in request.');
  const response = await fetch(DOUBAO_CHAT_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream', 'Origin': DOUBAO_ORIGIN, 'Referer': DOUBAO_ORIGIN + '/chat/', 'Cookie': cookiesToUse, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    body: JSON.stringify({ model: model || 'Seedream 5.0', prompt, ratio: ratio || '1:1', stream: true }),
  });
  if (!response.ok) throw new Error('Doubao API returned ' + response.status);
  return parseSSEResponse(await response.text());
}

async function callViaFreeApi(url, token, prompt, model, ratio, style) {
  console.log('[proxy] Calling free-api:', url);
  
  const body = { model: model || 'Seedream 5.0', prompt, ratio: ratio || '1:1', stream: false };
  if (style !== undefined) body.style = style;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  
  if (!response.ok) throw new Error('Free-API returned ' + response.status);
  
  const raw = await response.json();
  const data = Array.isArray(raw) ? raw[0] : raw;
  
  let imageUrls = [];
  if (data?.choices?.[0]?.message?.images) {
    imageUrls = data.choices[0].message.images;
  } else if (data?.data?.[0]?.url) {
    imageUrls = data.data.map(d => d.url);
  } else if (data?.images) {
    imageUrls = data.images;
  }

  console.log('[proxy] Found', imageUrls.length, 'image URLs');

  return imageUrls.map(u => {
    const match = typeof u === 'string' ? u.match(/rc_gen_image\/([^?~]+)/) : null;
    return { no_watermark_url: u, watermark_url: u, file_key: match ? match[1] : null, source: 'free-api' };
  });
}

async function handleGenerate(req, res) {
  const { prompt, model, ratio, style, mode, cookies, free_api_url, free_api_token } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  console.log(`\n[api] /api/generate — mode=${mode || 'auto'} prompt="${prompt.slice(0, 60)}"`);
  
  // If cookies are passed in request, update stored cookies
  if (cookies) {
    storedCookies = cookies;
    try {
      fs.writeFileSync(COOKIES_FILE, JSON.stringify({ cookies: storedCookies, savedAt: new Date().toISOString() }));
      console.log('[api] Cookies updated from request, length:', cookies.length);
    } catch (e) {}
  }

  let images = [];

  // Mode 1: Direct Doubao API (needs cookies)
  if ((mode === 'direct' || (mode !== 'proxy' && storedCookies))) {
    try {
      images = await callDoubaoChat(prompt, model, ratio, cookies || storedCookies);
      if (images.length > 0) {
        console.log('[api] Direct API returned', images.length, 'image(s)');
        return res.json({ success: true, source: 'direct', prompt, count: images.length, images, created: Math.floor(Date.now()/1000), data: images.map(i => ({ url: i.no_watermark_url, width: i.width, height: i.height })) });
      }
    } catch (e) {
      console.warn('[api] Direct API failed:', e.message);
      if (mode === 'direct') return res.status(500).json({ error: e.message });
    }
  }

  // Mode 2: Proxy through free-api
  const proxyUrl = free_api_url || process.env.FREE_API_URL;
  const proxyToken = free_api_token || process.env.FREE_API_TOKEN;
  if (proxyUrl) {
    try {
      images = await callViaFreeApi(proxyUrl, proxyToken || '', prompt, model, ratio, style);
      return res.json({ success: true, source: 'proxy', prompt, count: images.length, images, created: Math.floor(Date.now()/1000), data: images.map(i => ({ url: i.no_watermark_url, width: i.width, height: i.height })) });
    } catch (e) {
      console.error('[api] Free-API failed:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(400).json({ error: 'No cookies set and no free-api URL. Pass cookies in request or set FREE_API_URL.' });
}

app.get('/health', (req, res) => res.json({ status: 'ok', hasCookies: !!storedCookies, mode: storedCookies ? 'direct+proxy' : 'proxy-only' }));

app.post('/api/auth/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ error: 'cookies required' });
  storedCookies = typeof cookies === 'string' ? cookies : Array.isArray(cookies) ? cookies.map(c => c.name + '=' + c.value).join('; ') : '';
  fs.writeFileSync(COOKIES_FILE, JSON.stringify({ cookies: storedCookies, savedAt: new Date().toISOString() }));
  console.log('[api] Cookies set via /api/auth/cookies, length:', storedCookies.length);
  res.json({ success: true, length: storedCookies.length });
});

app.get('/api/auth/status', (req, res) => res.json({ hasCookies: !!storedCookies, cookieLength: storedCookies.length }));

app.post('/api/generate', authMiddleware, handleGenerate);
app.post('/v1/images/generations', authMiddleware, handleGenerate);

app.listen(PORT, '0.0.0.0', () => {
  console.log('doubao-headless-api on port ' + PORT);
  console.log('Cookies:', storedCookies ? 'loaded (length:' + storedCookies.length + ')' : 'not set');
});
