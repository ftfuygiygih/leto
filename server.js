import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'bots.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveBots() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(bots, null, 2));
}

function saveChats() {
  fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
}

let bots = loadJson(DATA_FILE, []); // [{ id, token, username, firstName, active, ad }]
for (const b of bots) {
  b.ad = {
    text: '',
    triggers: ['/start'],
    autoReplyEnabled: false,
    scheduleEnabled: false,
    scheduleTime: '10:00',
    lastSentDate: null,
    ...(b.ad || {})
  };
}
let chats = loadJson(CHATS_FILE, {}); // botId -> { chatId: { name, username, lastSeen } }
const messages = {};   // id -> [{ chatId, text, from, date }]
const pollers = {};    // id -> { stopped: bool }

const tgUrl = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

async function sendText(token, chatId, text) {
  const r = await fetch(tgUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  return r.json();
}

async function broadcastToKnownChats(bot, text) {
  const botChats = chats[bot.id] || {};
  const chatIds = Object.keys(botChats);
  let sent = 0;
  const failed = [];
  for (const chatId of chatIds) {
    try {
      const data = await sendText(bot.token, chatId, text);
      if (data.ok) sent++;
      else failed.push(chatId);
    } catch {
      failed.push(chatId);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { sent, failed: failed.length, total: chatIds.length };
}

async function startPolling(bot) {
  if (pollers[bot.id]) return;
  const state = { stopped: false, offset: 0 };
  pollers[bot.id] = state;
  messages[bot.id] = messages[bot.id] || [];

  (async function loop() {
    while (!state.stopped) {
      try {
        const r = await fetch(tgUrl(bot.token, 'getUpdates') + `?timeout=25&offset=${state.offset}`);
        const data = await r.json();
        if (data.ok) {
          for (const upd of data.result) {
            state.offset = upd.update_id + 1;
            const msg = upd.message || upd.channel_post;
            if (msg) {
              const fromName = msg.from ? (msg.from.username || msg.from.first_name) : 'канал';
              messages[bot.id].unshift({
                chatId: msg.chat.id,
                text: msg.text || '[не текст]',
                from: fromName,
                date: new Date(msg.date * 1000).toISOString()
              });
              messages[bot.id] = messages[bot.id].slice(0, 50);

              chats[bot.id] = chats[bot.id] || {};
              chats[bot.id][msg.chat.id] = {
                name: msg.chat.title || fromName,
                username: msg.chat.username || (msg.from && msg.from.username) || null,
                lastSeen: new Date(msg.date * 1000).toISOString()
              };
              saveChats();

              const ad = bot.ad || {};
              if (ad.autoReplyEnabled && ad.text && msg.text) {
                const command = msg.text.trim().split(' ')[0].split('@')[0];
                if ((ad.triggers || []).includes(command)) {
                  sendText(bot.token, msg.chat.id, ad.text).catch(() => {});
                }
              }
            }
          }
        }
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
}

function stopPolling(id) {
  if (pollers[id]) {
    pollers[id].stopped = true;
    delete pollers[id];
  }
}

for (const b of bots) if (b.active) startPolling(b);

app.get('/api/bots', (req, res) => {
  res.json(bots.map(({ id, username, firstName, active }) => ({ id, username, firstName, active })));
});

app.post('/api/bots', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Укажи токен бота' });
  if (bots.some((b) => b.token === token)) return res.status(400).json({ error: 'Этот бот уже в списке' });
  try {
    const r = await fetch(tgUrl(token, 'getMe'));
    const data = await r.json();
    if (!data.ok) return res.status(400).json({ error: 'Telegram не узнал этот токен' });
    const bot = {
      id: String(data.result.id),
      token,
      username: data.result.username,
      firstName: data.result.first_name,
      active: false
    };
    bots.push(bot);
    saveBots();
    res.json({ id: bot.id, username: bot.username, firstName: bot.firstName, active: bot.active });
  } catch {
    res.status(502).json({ error: 'Не получилось достучаться до Telegram' });
  }
});

app.post('/api/bots/:id/toggle', (req, res) => {
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  bot.active = !bot.active;
  if (bot.active) startPolling(bot);
  else stopPolling(bot.id);
  saveBots();
  res.json({ active: bot.active });
});

app.get('/api/bots/:id/messages', (req, res) => {
  res.json(messages[req.params.id] || []);
});

app.post('/api/bots/:id/send', async (req, res) => {
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const { chatId, text } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: 'Нужны chat ID и текст' });
  try {
    const data = await sendText(bot.token, chatId, text);
    if (!data.ok) return res.status(400).json({ error: data.description || 'Telegram отклонил сообщение' });
    res.json({ ok: true });
  } catch {
    res.status(502).json({ error: 'Не получилось достучаться до Telegram' });
  }
});

app.get('/api/bots/:id/chats', (req, res) => {
  const botChats = chats[req.params.id] || {};
  const list = Object.entries(botChats)
    .map(([chatId, info]) => ({ chatId, ...info }))
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  res.json(list);
});

app.post('/api/bots/:id/broadcast', async (req, res) => {
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Нужен текст рассылки' });
  if (!Object.keys(chats[bot.id] || {}).length) {
    return res.status(400).json({ error: 'Пока нет ни одного известного чата — бот ещё никому не отвечал' });
  }
  const result = await broadcastToKnownChats(bot, text);
  res.json(result);
});

app.get('/api/bots/:id/ad', (req, res) => {
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  res.json(bot.ad);
});

app.post('/api/bots/:id/ad', (req, res) => {
  const bot = bots.find((b) => b.id === req.params.id);
  if (!bot) return res.status(404).json({ error: 'Бот не найден' });
  const { text, triggers, autoReplyEnabled, scheduleEnabled, scheduleTime } = req.body;
  if (typeof text === 'string') bot.ad.text = text;
  if (Array.isArray(triggers)) {
    bot.ad.triggers = triggers
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('/') ? t : '/' + t));
  }
  if (typeof autoReplyEnabled === 'boolean') bot.ad.autoReplyEnabled = autoReplyEnabled;
  if (typeof scheduleEnabled === 'boolean') bot.ad.scheduleEnabled = scheduleEnabled;
  if (typeof scheduleTime === 'string' && /^\d{2}:\d{2}$/.test(scheduleTime)) bot.ad.scheduleTime = scheduleTime;
  saveBots();
  res.json(bot.ad);
});

app.delete('/api/bots/:id', (req, res) => {
  stopPolling(req.params.id);
  bots = bots.filter((b) => b.id !== req.params.id);
  delete messages[req.params.id];
  delete chats[req.params.id];
  saveBots();
  saveChats();
  res.json({ ok: true });
});

// Раз в минуту проверяем, не пора ли кому-то из ботов разослать рекламу по расписанию
setInterval(async () => {
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);
  const today = now.toISOString().slice(0, 10);
  for (const bot of bots) {
    const ad = bot.ad;
    if (!ad || !ad.scheduleEnabled || !ad.text) continue;
    if (ad.scheduleTime !== hhmm) continue;
    if (ad.lastSentDate === today) continue;
    ad.lastSentDate = today;
    saveBots();
    broadcastToKnownChats(bot, ad.text).catch(() => {});
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot manager running on port ${PORT}`));
