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

// --- Онлайн-юзери: username (lowercase) -> кількість активних сокетів ---
const onlineCounts = new Map();

function markOnline(username) {
  const key = username.toLowerCase();
  const count = (onlineCounts.get(key) || 0) + 1;
  onlineCounts.set(key, count);
  if (count === 1) {
    io.emit('user status', { username, online: true });
  }
}

function markOffline(username) {
  if (!username) return;
  const key = username.toLowerCase();
  const count = (onlineCounts.get(key) || 0) - 1;
  if (count <= 0) {
    onlineCounts.delete(key);
    io.emit('user status', { username, online: false });
  } else {
    onlineCounts.set(key, count);
  }
}

const HANDLE_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/; // як @handle в Telegram: 5-32 символи, починається з літери

function makeRoomName(nameA, nameB) {
  const names = [nameA.toLowerCase(), nameB.toLowerCase()].sort();
  return names[0] + '_' + names[1];
}

function getRoomPartner(room, username) {
  const currentUser = (username || '').toLowerCase();
  return (room || '').split('_').find((name) => name !== currentUser) || '';
}

function emitToUser(username, event, payload) {
  const target = (username || '').toLowerCase();
  if (!target) return;

  for (const s of io.sockets.sockets.values()) {
    if (s.username && s.username.toLowerCase() === target) {
      s.emit(event, payload);
    }
  }
}

function requireAuth(socket, callback) {
  if (!socket.username) {
    if (callback) callback({ success: false, error: 'Сесія недійсна, увійди знову' });
    return false;
  }
  return true;
}

// Позначає всі чужі непрочитані повідомлення в кімнаті прочитаними і сповіщає кімнату
async function markRoomRead(socket, room) {
  const { data, error } = await supabase
    .from('messages')
    .update({ read: true })
    .eq('room', room)
    .neq('username', socket.username)
    .eq('read', false)
    .select('id');

  if (error) {
    console.error(error);
    return;
  }
  if (data && data.length > 0) {
    io.to(room).emit('messages read', { room, ids: data.map((r) => r.id) });
  }
}

// Чи зараз хтось із кімнати (окрім автора) реально дивиться саме цю кімнату
function isPartnerViewingRoom(room, authorUsername) {
  const roomSet = io.sockets.adapter.rooms.get(room);
  if (!roomSet) return false;
  for (const socketId of roomSet) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.username && s.username !== authorUsername && s.currentRoom === room) {
      return true;
    }
  }
  return false;
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
    markOnline(socket.username);
    callback({ success: true, username: data.username, token });
  });

  // --- Автологін за збереженим токеном (наприклад, при перезавантаженні сторінки) ---
  socket.on('auto login', (token, callback) => {
    const username = sessions.get(token);
    if (!username) {
      return callback({ success: false });
    }
    socket.username = username;
    markOnline(username);
    callback({ success: true, username });
  });

  // --- Логаут ---
  socket.on('logout', (token) => {
    sessions.delete(token);
    markOffline(socket.username);
    socket.username = null;
  });

  // --- Список онлайн-юзернеймів ---
  socket.on('get online users', (_unused, callback) => {
    callback(Array.from(onlineCounts.keys()));
  });

  // --- Друкує / перестав друкувати ---
  socket.on('typing', ({ room }) => {
    if (!requireAuth(socket)) return;
    if (room !== socket.currentRoom || !socket.rooms.has(room)) return;
    socket.to(room).emit('typing', { room, user: socket.username });
  });

  socket.on('stop typing', ({ room }) => {
    if (!requireAuth(socket)) return;
    if (!room) return;
    socket.to(room).emit('stop typing', { room, user: socket.username });
  });

  // --- Список чатів користувача ---
  socket.on('get chats', async (_unused, callback) => {
    if (!requireAuth(socket, () => callback([]))) return;
    const username = socket.username;

    const { data, error } = await supabase
      .from('messages')
      .select('room, username, text, created_at, read, deleted')
      .or(`room.ilike.${username.toLowerCase()}_%,room.ilike.%_${username.toLowerCase()}`)
      .order('created_at', { ascending: false });

    if (error) {
      console.error(error);
      return callback([]);
    }

    const chats = new Map();
    for (const row of data) {
      let chat = chats.get(row.room);
      if (!chat) {
        const parts = row.room.split('_');
        const partner = parts[0] === username.toLowerCase() ? parts[1] : parts[0];
        chat = {
          room: row.room,
          partner,
          lastText: row.deleted ? 'Повідомлення видалено' : row.text,
          lastUser: row.username,
          unread: 0,
        };
        chats.set(row.room, chat);
      }
      // Непрочитані = повідомлення не від мене і ще не прочитані
      if (row.username !== username && !row.read) {
        chat.unread += 1;
      }
    }

    callback(Array.from(chats.values()));
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

    if (socket.currentRoom && socket.currentRoom !== room) {
      socket.leave(socket.currentRoom);
    }
    socket.join(room);
    socket.currentRoom = room;

    supabase
      .from('messages')
      .select('id, username, text, read, edited, deleted')
      .eq('room', room)
      .order('id', { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error(error);
          return;
        }
        data.forEach((row) => {
          socket.emit('chat message', {
            id: row.id,
            user: row.username,
            text: row.deleted ? '' : row.text,
            read: row.read,
            edited: row.edited,
            deleted: row.deleted,
          });
        });
        markRoomRead(socket, room);
      });
  });

  socket.on('chat message', async (data) => {
    if (!requireAuth(socket)) return;
    // Кімната має бути та, в яку юзер реально приєднався — і він має бути її учасником
    if (data.room !== socket.currentRoom || !socket.rooms.has(data.room)) return;

    const text = (data.text || '').trim();
    if (!text) return;

    const partnerIsViewing = isPartnerViewingRoom(data.room, socket.username);

    const { data: inserted, error } = await supabase
      .from('messages')
      .insert({ room: data.room, username: socket.username, text, read: partnerIsViewing })
      .select('id')
      .single();

    if (error) {
      console.error(error);
      return;
    }

    io.to(data.room).emit('chat message', {
      id: inserted.id,
      user: socket.username,
      text,
      read: partnerIsViewing,
    });

    const partnerUsername = getRoomPartner(data.room, socket.username);
    emitToUser(partnerUsername, 'new message notification', {
      id: inserted.id,
      room: data.room,
      from: socket.username,
      text,
    });
  });

  // --- Редагування повідомлення ---
  socket.on('edit message', async (data, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});
    const room = data && data.room;
    const id = data && data.id;
    const text = (data && data.text || '').trim();

    if (room !== socket.currentRoom || !socket.rooms.has(room)) {
      return cb({ success: false, error: 'Невірна кімната' });
    }
    if (!text) return cb({ success: false, error: 'Текст не може бути порожнім' });

    // Перевіряємо, що повідомлення належить цьому юзеру і не видалене
    const { data: existing, error: fetchErr } = await supabase
      .from('messages')
      .select('id, username, deleted')
      .eq('id', id)
      .eq('room', room)
      .maybeSingle();

    if (fetchErr || !existing || existing.username !== socket.username || existing.deleted) {
      return cb({ success: false, error: 'Неможливо редагувати це повідомлення' });
    }

    const { error } = await supabase
      .from('messages')
      .update({ text, edited: true })
      .eq('id', id);

    if (error) {
      console.error(error);
      return cb({ success: false, error: 'Помилка редагування' });
    }

    io.to(room).emit('message edited', { room, id, text });
    cb({ success: true });
  });

  // --- Видалення повідомлення ---
  socket.on('delete message', async (data, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});
    const room = data && data.room;
    const id = data && data.id;

    if (room !== socket.currentRoom || !socket.rooms.has(room)) {
      return cb({ success: false, error: 'Невірна кімната' });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('messages')
      .select('id, username')
      .eq('id', id)
      .eq('room', room)
      .maybeSingle();

    if (fetchErr || !existing || existing.username !== socket.username) {
      return cb({ success: false, error: 'Неможливо видалити це повідомлення' });
    }

    const { error } = await supabase
      .from('messages')
      .update({ deleted: true, text: '' })
      .eq('id', id);

    if (error) {
      console.error(error);
      return cb({ success: false, error: 'Помилка видалення' });
    }

    io.to(room).emit('message deleted', { room, id });
    cb({ success: true });
  });

  socket.on('disconnect', () => {
    console.log('Хтось вийшов з сервера');
    markOffline(socket.username);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Сервер запущено! Порт:', PORT);
});
