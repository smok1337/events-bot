const express = require('express');
const mineflayer = require('mineflayer');

const app = express();
const PORT = 3000;

let bot = null;
let eventsData = null;
let awaitingInventory = false;

// Функция для парсинга времени из лора
function parseTimeFromLore(loreText) {
  const match = loreText.match(/(\d+)ч\s*(\d+)м\s*(\d+)с/);
  if (!match) return null;
  
  const hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const seconds = parseInt(match[3]);
  
  return hours * 3600 + minutes * 60 + seconds;
}

// Функция для определения активности события
function parseEventStatus(loreText) {
  const isActive = loreText.includes('завершится через');
  const secondsRemaining = parseTimeFromLore(loreText);
  
  return {
    active: isActive,
    secondsRemaining: secondsRemaining
  };
}

// Подключение к серверу Minecraft
function connectToMinecraft() {
  const options = {
    host: 'aresmine.ru',
    port: 25565,
    username: process.env.MC_EMAIL,
    password: process.env.MC_PASSWORD,
    version: '1.21'
  };

  console.log(`[BOT] Подключение к серверу ${options.host}:${options.port}...`);
  
  bot = mineflayer.createBot(options);

  bot.on('login', () => {
    console.log('[BOT] Успешно авторизирован на сервере');
  });

  bot.on('spawn', () => {
    console.log('[BOT] Спавнулся на сервере');
  });

  bot.on('chat', (username, message) => {
    console.log(`[CHAT] ${username}: ${message}`);
  });

  bot.on('error', (err) => {
    console.error('[ERROR] Ошибка подключения:', err);
  });

  bot.on('kicked', (reason) => {
    console.log('[BOT] Исключен с сервера:', reason);
    setTimeout(() => connectToMinecraft(), 5000);
  });

  bot.on('end', () => {
    console.log('[BOT] Соединение разорвано');
    setTimeout(() => connectToMinecraft(), 5000);
  });

  // Перехват пакета открытия инвентаря
  bot._client.on('packet', (packet) => {
    if (awaitingInventory && packet.name === 'open_window') {
      console.log('[PACKET] Получен пакет открытия инвентаря');
      setTimeout(() => parseInventory(), 500);
    }
  });
}

// Функция для парсинга инвентаря
function parseInventory() {
  if (!bot || !bot.inventory) {
    console.log('[ERROR] Инвентарь не доступен');
    awaitingInventory = false;
    return;
  }

  const events = [];
  
  // Получаем все предметы из инвентаря
  for (let i = 0; i < bot.inventory.slots.length; i++) {
    const item = bot.inventory.slots[i];
    
    if (item && item.name) {
      const itemName = item.displayName || item.name;
      let lore = [];
      
      // Извлекаем лор из NBT данных если доступен
      if (item.nbt && item.nbt.value && item.nbt.value.display) {
        const display = item.nbt.value.display.value;
        if (display.Lore && display.Lore.value.value) {
          lore = display.Lore.value.value.map(line => line.value);
        }
      }
      
      // Ищем информацию о времени в лоре
      for (const loreLine of lore) {
        if (loreLine.includes('ч') && loreLine.includes('м') && loreLine.includes('с')) {
          const status = parseEventStatus(loreLine);
          
          events.push({
            name: itemName,
            secondsRemaining: status.secondsRemaining,
            active: status.active
          });
          
          console.log(`[EVENT] Найдено событие: ${itemName}, активно: ${status.active}, осталось: ${status.secondsRemaining}с`);
          break;
        }
      }
    }
  }
  
  eventsData = events;
  awaitingInventory = false;
  console.log(`[INVENTORY] Спарсено ${events.length} событий`);
}

// Express endpoints
app.get('/ping', (req, res) => {
  console.log('[API] GET /ping');
  res.json({ status: 'ok' });
});

app.get('/events', (req, res) => {
  console.log('[API] GET /events - запрос событий');
  
  if (!bot || !bot.entity) {
    console.log('[ERROR] Бот не подключен к серверу');
    return res.status(503).json({ error: 'Bot not connected' });
  }

  awaitingInventory = true;
  eventsData = null;
  
  // Пишем команду /a в чат
  console.log('[BOT] Отправка команды /a');
  bot.chat('/a');
  
  // Ждем парсинга инвентаря с таймаутом
  const timeout = setTimeout(() => {
    if (awaitingInventory) {
      awaitingInventory = false;
      console.log('[ERROR] Таймаут ожидания открытия инвентаря');
      res.status(504).json({ error: 'Inventory timeout' });
    }
  }, 5000);

  // Проверяем готовность результатов
  const checkInterval = setInterval(() => {
    if (eventsData !== null) {
      clearInterval(checkInterval);
      clearTimeout(timeout);
      console.log('[API] Возврат результатов:', eventsData);
      res.json(eventsData);
    }
  }, 100);
});

// Запуск Express сервера
app.listen(PORT, () => {
  console.log(`[EXPRESS] HTTP сервер запущен на порту ${PORT}`);
  console.log(`[EXPRESS] Доступные endpoints: /ping, /events`);
});

// Запуск подключения к Minecraft
console.log('[STARTUP] Запуск events-bot...');
console.log(`[CONFIG] MC_EMAIL: ${process.env.MC_EMAIL ? 'установлен' : 'НЕ установлен'}`);
console.log(`[CONFIG] MC_PASSWORD: ${process.env.MC_PASSWORD ? 'установлен' : 'НЕ установлен'}`);

if (!process.env.MC_EMAIL || !process.env.MC_PASSWORD) {
  console.error('[ERROR] Отсутствуют переменные окружения MC_EMAIL или MC_PASSWORD');
  process.exit(1);
}

connectToMinecraft();