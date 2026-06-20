const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Дані підключення до Supabase (можна винести у змінні середовища)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://klosisstvruqkiialvcx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Wn4Gn_lJq9SLRowgsnxlzQ_XqQ13-Ot';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static('public'));

// --- Сесії: token -> username (in-memory; при рестарті сервера всі розлогіняться) ---
const sessions = new Map();

const HANDLE_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/; // як @handle в Telegram: 5-32 символи, починається з літери

function makeRoomName(nameA, nameB) {
  const names = [nameA.toLowerCase(), nameB.toLowerCase()].sort();
  return names[0] + '_' + names[1];
}

function requireAuth(socket, callback) {
  if (!socket.username) {
    if (callback) callback({ success: false, error: 'Сесія недійсна, увійди знову' });
    return false;
  }
  return true;
}

io.on('connection', (socket) => {
  console.log('Хтось приєднався до сервера');

  // --- Реєстрація ---
  socket.on('register', async ({ username, password }, callback) => {
    username = (username || '').trim();
    password = (password || '').trim();

    if (!HANDLE_RE.test(username)) {
      return callback({
        success: false,
        error: 'Юзернейм: 5-32 символи, латиниця/цифри/підкреслення, починається з літери',
      });
    }
    if (password.length < 6) {
      return callback({ success: false, error: 'Пароль має бути не менше 6 символів' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .ilike('username', username)
      .maybeSingle();

    if (existing) {
      return callback({ success: false, error: 'Цей юзернейм вже зайнятий' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const { error } = await supabase
      .from('users')
      .insert({ username, password: passwordHash });

    if (error) {
      console.error(error);
      return callback({ success: false, error: 'Помилка реєстрації' });
    }

    callback({ success: true });
  });

  // --- Логін ---
  socket.on('login', async ({ username, password }, callback) => {
    username = (username || '').trim();
    password = (password || '').trim();

    const { data, error } = await supabase
      .from('users')
      .select('id, username, password')
      .ilike('username', username)
      .maybeSingle();

    if (error || !data) {
      return callback({ success: false, error: "Невірний юзернейм або пароль" });
    }

    const passwordMatches = await bcrypt.compare(password, data.password);
    if (!passwordMatches) {
      return callback({ success: false, error: "Невірний юзернейм або пароль" });
    }

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, data.username);

    socket.username = data.username;
    callback({ success: true, username: data.username, token });
  });

  // --- Автологін за збереженим токеном (наприклад, при перезавантаженні сторінки) ---
  socket.on('auto login', (token, callback) => {
    const username = sessions.get(token);
    if (!username) {
      return callback({ success: false });
    }
    socket.username = username;
    callback({ success: true, username });
  });

  // --- Логаут ---
  socket.on('logout', (token) => {
    sessions.delete(token);
    socket.username = null;
  });

  // --- Список чатів користувача ---
  socket.on('get chats', async (_unused, callback) => {
    if (!requireAuth(socket, () => callback([]))) return;
    const username = socket.username;

    const { data, error } = await supabase
      .from('messages')
      .select('room, username, text, created_at')
      .or(`room.ilike.${username.toLowerCase()}_%,room.ilike.%_${username.toLowerCase()}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(error);
      return callback([]);
    }

    const seen = new Map();
    for (const row of data) {
      if (!seen.has(row.room)) {
        const parts = row.room.split('_');
        const partner = parts[0] === username.toLowerCase() ? parts[1] : parts[0];
        seen.set(row.room, {
          room: row.room,
          partner,
          lastText: row.text,
          lastUser: row.username,
        });
      }
    }

    callback(Array.from(seen.values()));
  });

  // --- Почати новий чат ---
  socket.on('start chat', async ({ partnerUsername }, callback) => {
    if (!requireAuth(socket, callback)) return;
    partnerUsername = (partnerUsername || '').trim().replace(/^@/, '');

    if (!partnerUsername) {
      return callback({ success: false, error: "Введи юзернейм співрозмовника" });
    }
    if (partnerUsername.toLowerCase() === socket.username.toLowerCase()) {
      return callback({ success: false, error: 'Не можна написати самому собі' });
    }

    const { data, error } = await supabase
      .from('users')
      .select('username')
      .ilike('username', partnerUsername)
      .maybeSingle();

    if (error || !data) {
      return callback({ success: false, error: 'Користувача не знайдено' });
    }

    const room = makeRoomName(socket.username, data.username);
    callback({ success: true, room, partner: data.username });
  });

  socket.on('join room', (room) => {
    if (!requireAuth(socket)) return;

    // Перевіряємо, що цей юзер дійсно учасник кімнати, перш ніж пускати туди
    const parts = (room || '').split('_');
    if (parts.length !== 2 || !parts.includes(socket.username.toLowerCase())) {
      return;
    }

    socket.join(room);
    socket.currentRoom = room;

    supabase
      .from('messages')
      .select('username, text')
      .eq('room', room)
      .order('id', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error(error);
          return;
        }
        data.forEach((row) => {
          socket.emit('chat message', { user: row.username, text: row.text });
        });
      });
  });

  socket.on('chat message', (data) => {
    if (!requireAuth(socket)) return;
    // Кімната має бути та, в яку юзер реально приєднався — і він має бути її учасником
    if (data.room !== socket.currentRoom || !socket.rooms.has(data.room)) return;

    const payload = { room: data.room, username: socket.username, text: (data.text || '').trim() };
    if (!payload.text) return;

    supabase
      .from('messages')
      .insert(payload)
      .then(({ error }) => {
        if (error) console.error(error);
      });
    io.to(data.room).emit('chat message', { user: socket.username, text: payload.text });
  });

  socket.on('disconnect', () => {
    console.log('Хтось вийшов з сервера');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Сервер запущено! Порт:', PORT);
});
