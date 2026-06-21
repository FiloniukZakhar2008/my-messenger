const express = require('express');
const http = require('http');
const crypto = require('crypto');
const multer = require('multer');
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

const VOICE_BUCKET = 'chat-media';
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VOICE_BYTES },
});

function messagePreview(row) {
  if (row.deleted) return 'Повідомлення видалено';
  if (row.type === 'voice') return '🎤 Голосове повідомлення';
  return row.text || '';
}

function getSessionUsername(token) {
  return sessions.get((token || '').trim()) || null;
}

function isRoomMember(room, username) {
  const parts = (room || '').split('_');
  const user = (username || '').toLowerCase();
  return parts.length === 2 && parts.includes(user);
}

async function uploadVoiceFile(room, buffer, mimeType) {
  const ext = (mimeType || '').includes('ogg') ? 'ogg' : 'webm';
  const filePath = `voice/${room}/${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const { error } = await supabase.storage
    .from(VOICE_BUCKET)
    .upload(filePath, buffer, { contentType: mimeType || 'audio/webm', upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

async function broadcastVoiceMessage(room, username, mediaUrl, duration, partnerIsViewing) {
  const { data: inserted, error } = await supabase
    .from('messages')
    .insert({
      room,
      username,
      text: '',
      type: 'voice',
      media_url: mediaUrl,
      duration,
      read: partnerIsViewing,
    })
    .select('id, created_at')
    .single();

  if (error) throw error;

  const payload = {
    id: inserted.id,
    user: username,
    type: 'voice',
    mediaUrl,
    duration,
    read: partnerIsViewing,
    createdAt: inserted.created_at,
  };

  io.to(room).emit('chat message', payload);

  const partnerUsername = getRoomPartner(room, username);
  emitToUser(partnerUsername, 'new message notification', {
    id: inserted.id,
    room,
    from: username,
    type: 'voice',
    text: '🎤 Голосове повідомлення',
  });

  return payload;
}

app.use(express.static('public'));

app.post('/api/voice-message', voiceUpload.single('audio'), async (req, res) => {
  try {
    const username = getSessionUsername(req.body && req.body.token);
    if (!username) {
      return res.status(401).json({ success: false, error: 'Сесія недійсна, увійди знову' });
    }

    const room = (req.body && req.body.room || '').trim();
    if (!isRoomMember(room, username)) {
      return res.status(403).json({ success: false, error: 'Немає доступу до цієї кімнати' });
    }

    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'Аудіофайл не отримано' });
    }

    const duration = Math.max(0, Math.min(300, Number(req.body.duration) || 0));
    const mimeType = req.file.mimetype || 'audio/webm';
    if (!mimeType.startsWith('audio/')) {
      return res.status(400).json({ success: false, error: 'Дозволені лише аудіофайли' });
    }

    const mediaUrl = await uploadVoiceFile(room, req.file.buffer, mimeType);
    const partnerIsViewing = isPartnerViewingRoom(room, username);
    const payload = await broadcastVoiceMessage(room, username, mediaUrl, duration, partnerIsViewing);

    res.json({ success: true, message: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Не вдалось надіслати голосове повідомлення' });
  }
});

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
      .select('id, username, password, bio, avatar_color')
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
    callback({
      success: true,
      username: data.username,
      token,
      bio: data.bio || '',
      avatarColor: data.avatar_color || '',
    });
  });

  // --- Автологін за збереженим токеном (наприклад, при перезавантаженні сторінки) ---
  socket.on('auto login', async (token, callback) => {
    const username = sessions.get(token);
    if (!username) {
      return callback({ success: false });
    }
    socket.username = username;
    markOnline(username);

    const { data } = await supabase
      .from('users')
      .select('bio, avatar_color')
      .ilike('username', username)
      .maybeSingle();

    callback({
      success: true,
      username,
      bio: (data && data.bio) || '',
      avatarColor: (data && data.avatar_color) || '',
    });
  });

  // --- Логаут ---
  socket.on('logout', (token) => {
    sessions.delete(token);
    markOffline(socket.username);
    socket.username = null;
  });

  // --- Оновлення підпису й кольору аватарки (видно іншим користувачам) ---
  socket.on('update profile', async ({ bio, avatarColor }, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});

    const cleanBio = (bio || '').toString().trim().slice(0, 80);
    const cleanColor = (avatarColor || '').toString().trim().slice(0, 16);

    const { error } = await supabase
      .from('users')
      .update({ bio: cleanBio, avatar_color: cleanColor || null })
      .ilike('username', socket.username);

    if (error) {
      console.error(error);
      return cb({ success: false, error: 'Не вдалося зберегти профіль' });
    }

    io.emit('profile updated', { username: socket.username, bio: cleanBio, avatarColor: cleanColor });
    cb({ success: true, bio: cleanBio, avatarColor: cleanColor });
  });

  // --- Публічний профіль будь-якого користувача (підпис + колір аватарки) ---
  socket.on('get profile', async (username, callback) => {
    const cb = callback || (() => {});
    const { data, error } = await supabase
      .from('users')
      .select('username, bio, avatar_color')
      .ilike('username', (username || '').toString().trim())
      .maybeSingle();

    if (error || !data) return cb(null);
    cb({ username: data.username, bio: data.bio || '', avatarColor: data.avatar_color || '' });
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
      .select('room, username, text, created_at, read, deleted, type, duration')
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
          lastText: messagePreview(row),
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

    // Підтягуємо публічні профілі (підпис + колір аватарки) усіх співрозмовників одним запитом
    const partners = Array.from(chats.values()).map((c) => c.partner);
    const profileByUsername = {};
    if (partners.length > 0) {
      const orFilter = partners.map((p) => `username.ilike.${p}`).join(',');
      const { data: profileRows } = await supabase
        .from('users')
        .select('username, bio, avatar_color')
        .or(orFilter);
      (profileRows || []).forEach((row) => {
        profileByUsername[row.username.toLowerCase()] = {
          bio: row.bio || '',
          avatarColor: row.avatar_color || '',
        };
      });
    }

    const result = Array.from(chats.values()).map((chat) => {
      const profile = profileByUsername[chat.partner] || { bio: '', avatarColor: '' };
      return { ...chat, bio: profile.bio, avatarColor: profile.avatarColor };
    });

    callback(result);
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
      .select('username, bio, avatar_color')
      .ilike('username', partnerUsername)
      .maybeSingle();

    if (error || !data) {
      return callback({ success: false, error: 'Користувача не знайдено' });
    }

    const room = makeRoomName(socket.username, data.username);
    callback({
      success: true,
      room,
      partner: data.username,
      bio: data.bio || '',
      avatarColor: data.avatar_color || '',
    });
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
      .select('id, username, text, read, edited, deleted, type, media_url, duration, created_at')
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
            type: row.deleted ? 'text' : (row.type || 'text'),
            mediaUrl: row.deleted ? null : row.media_url,
            duration: row.duration,
            read: row.read,
            edited: row.edited,
            deleted: row.deleted,
            createdAt: row.created_at,
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
      .select('id, created_at')
      .single();

    if (error) {
      console.error(error);
      return;
    }

    io.to(data.room).emit('chat message', {
      id: inserted.id,
      user: socket.username,
      type: 'text',
      text,
      read: partnerIsViewing,
      createdAt: inserted.created_at,
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
      .select('id, username, deleted, type')
      .eq('id', id)
      .eq('room', room)
      .maybeSingle();

    if (fetchErr || !existing || existing.username !== socket.username || existing.deleted) {
      return cb({ success: false, error: 'Неможливо редагувати це повідомлення' });
    }

    if (existing.type && existing.type !== 'text') {
      return cb({ success: false, error: 'Можна редагувати лише текстові повідомлення' });
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
