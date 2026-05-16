const express = require('express');
const mineflayer = require('mineflayer');
const Tesseract = require('tesseract.js');
const Jimp = require('jimp');
const { SocksClient } = require('socks');

const app = express();
const PORT = process.env.PORT || 3000;

let bot = null;
let eventsData = null;
let awaitingInventory = false;
let captchaSolving = false;

function parseTimeFromLore(loreText) {
  const match = loreText.match(/(\d+)ч\s*(\d+)м\s*(\d+)с/);
  if (!match) return null;
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
}

function parseEventStatus(loreText) {
  return {
    active: loreText.includes('завершится через'),
    secondsRemaining: parseTimeFromLore(loreText)
  };
}

async function solveCaptcha() {
  if (captchaSolving) return;
  captchaSolving = true;
  console.log('[CAPTCHA] Начало решения капчи...');

  try {
    await new Promise(r => setTimeout(r, 1000));

    let mapItem = null;
    for (const item of bot.inventory.slots) {
      if (item && item.name === 'filled_map') {
        mapItem = item;
        break;
      }
    }

    if (!mapItem) {
      console.log('[CAPTCHA] Карта не найдена в инвентаре');
      captchaSolving = false;
      return;
    }

    const mapId = mapItem.nbt?.value?.map?.value;
    console.log(`[CAPTCHA] ID карты: ${mapId}`);

    const mapData = bot._mapData?.[mapId];
    if (!mapData || !mapData.data) {
      console.log('[CAPTCHA] Данные карты недоступны');
      captchaSolving = false;
      return;
    }

    const width = 128, height = 128;
    const image = new Jimp({ width: width * 3, height: height * 3, color: 0xffffffff });

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const colorIndex = mapData.data[y * width + x];
        const dark = colorIndex < 50 ? 0 : 255;
        const color = Jimp.rgbaToInt(dark, dark, dark, 255);
        for (let dy = 0; dy < 3; dy++)
          for (let dx = 0; dx < 3; dx++)
            image.setPixelColor(color, x * 3 + dx, y * 3 + dy);
      }
    }

    image.grayscale().contrast(1);
    const buffer = await image.getBuffer('image/png');

    const result = await Tesseract.recognize(buffer, 'eng', {
      tessedit_char_whitelist: '0123456789'
    });

    const numbers = result.data.text.replace(/\D/g, '').trim();
    console.log(`[CAPTCHA] Распознано: "${numbers}"`);

    if (numbers) {
      bot.chat(numbers);
      console.log('[CAPTCHA] Ответ отправлен');
    } else {
      console.log('[CAPTCHA] Не удалось распознать цифры');
    }
  } catch (err) {
    console.error('[CAPTCHA] Ошибка:', err.message);
  } finally {
    captchaSolving = false;
  }
}

function parseInventory() {
  if (!bot?.inventory) { awaitingInventory = false; return; }
  const events = [];

  for (const item of bot.inventory.slots) {
    if (!item?.name) continue;
    const itemName = item.displayName || item.name;
    let lore = [];

    if (item.nbt?.value?.display) {
      const display = item.nbt.value.display.value;
      if (display.Lore?.value?.value)
        lore = display.Lore.value.value.map(l => l.value);
    }

    for (const line of lore) {
      if (line.includes('ч') && line.includes('м') && line.includes('с')) {
        const status = parseEventStatus(line);
        events.push({ name: itemName, ...status });
        console.log(`[EVENT] ${itemName} active:${status.active} seconds:${status.secondsRemaining}`);
        break;
      }
    }
  }

  eventsData = events;
  awaitingInventory = false;
  console.log(`[INVENTORY] Найдено событий: ${events.length}`);
}

function connectToMinecraft() {
  SocksClient.createConnection({
    proxy: {
  host: '176.114.86.151',
  port: 1080,
  type: 5
},
    command: 'connect',
    destination: {
      host: 'mc.aresmine.ru',
      port: 25565
    }
  }, (err, info) => {
    if (err) {
      console.error('[PROXY] Ошибка прокси:', err.message);
      setTimeout(connectToMinecraft, 5000);
      return;
    }

    console.log('[PROXY] Подключено через прокси');

    bot = mineflayer.createBot({
      host: 'mc.aresmine.ru',
      port: 25565,
      username: process.env.MC_USERNAME || 'EventBot',
      auth: 'offline',
      stream: info.socket
    });

    bot.on('login', () => console.log('[BOT] Авторизован'));
    bot.on('spawn', () => {
      console.log('[BOT] Заспавнился');
      setTimeout(() => {
        bot.chat('/srv grief');
        console.log('[BOT] Отправлен /srv grief');
      }, 3000);
    });
    bot.on('error', err => console.error('[ERROR]', err.message));
    bot.on('kicked', reason => {
      console.log('[BOT] Кикнут:', reason);
      setTimeout(connectToMinecraft, 5000);
    });
    bot.on('end', () => {
      console.log('[BOT] Отключён, переподключение...');
      setTimeout(connectToMinecraft, 5000);
    });

    bot.on('message', (msg) => {
      const text = msg.toString();
      console.log('[MSG]', text);

      if (text.includes('Введите номер с картинки')) {
        console.log('[CAPTCHA] Запрос капчи обнаружен');
        setTimeout(solveCaptcha, 500);
      }
      if (text.includes('Войдите на сервер') || text.includes('/L пароль')) {
        bot.chat('/L ' + (process.env.MC_PASSWORD || 'password123'));
        console.log('[BOT] Отправлен /L');
      }
      if (text.includes('Зарегистрируйтесь') || text.includes('/reg пароль')) {
        const pass = process.env.MC_PASSWORD || 'password123';
        bot.chat(`/reg ${pass} ${pass}`);
        console.log('[BOT] Отправлен /reg');
      }
    });

    bot._client.on('packet', (packet) => {
      if (packet.name === 'map') {
        if (!bot._mapData) bot._mapData = {};
        bot._mapData[packet.itemDamage] = packet;
      }
      if (awaitingInventory && packet.name === 'open_window') {
        setTimeout(parseInventory, 500);
      }
    });
  });
}

app.get('/ping', (req, res) => res.json({ status: 'ok' }));

app.get('/events', (req, res) => {
  if (!bot?.entity) return res.status(503).json({ error: 'Bot not connected' });

  awaitingInventory = true;
  eventsData = null;
  bot.chat('/a');
  console.log('[API] /events запрос, отправлен /a');

  const timeout = setTimeout(() => {
    if (awaitingInventory) {
      awaitingInventory = false;
      res.status(504).json({ error: 'Timeout' });
    }
  }, 5000);

  const interval = setInterval(() => {
    if (eventsData !== null) {
      clearInterval(interval);
      clearTimeout(timeout);
      res.json(eventsData);
    }
  }, 100);
});

app.listen(PORT, () => console.log(`[EXPRESS] Запущен на порту ${PORT}`));

console.log('[STARTUP] events-bot запускается...');
console.log(`[CONFIG] MC_USERNAME: ${process.env.MC_USERNAME || 'EventBot'}`);
connectToMinecraft();
