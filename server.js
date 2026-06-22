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

// Дані підключення до Supabase — лише через змінні середовища (.env, не в git!)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Помилка: заповни SUPABASE_URL та SUPABASE_KEY у файлі .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VOICE_BUCKET = 'chat-media';
const MAX_VOICE_BYTES = 5 * 1024 * 1024;
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VOICE_BYTES },
});

const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES },
});

function messagePreview(row) {
  if (row.deleted) return 'Повідомлення видалено';
  if (row.type === 'voice') return '🎤 Голосове повідомлення';
  if (row.type === 'video') return '📹 Відеоповідомлення';
  return row.text || '';
}

function getSessionUsername(token) {
  return sessions.get((token || '').trim()) || null;
}

// Перевірка членства лише для ПРИВАТНИХ кімнат (voice/video API).
// Групові голосові/відео повідомлення поки не реалізовані — туди не пускаємо.
function isRoomMember(room, username) {
  if ((room || '').startsWith('group_')) return false;
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

async function uploadVideoFile(room, buffer, mimeType) {
  const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  const filePath = `video/${room}/${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const { error } = await supabase.storage
    .from(VOICE_BUCKET)
    .upload(filePath, buffer, { contentType: mimeType || 'video/webm', upsert: false });

  if (error) throw error;

  const { data } = supabase.storage.from(VOICE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

async function broadcastVideoMessage(room, username, mediaUrl, duration, partnerIsViewing) {
  const { data: inserted, error } = await supabase
    .from('messages')
    .insert({
      room,
      username,
      text: '',
      type: 'video',
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
    type: 'video',
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
    type: 'video',
    text: '📹 Відеоповідомлення',
  });

  return payload;
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

app.post('/api/video-message', videoUpload.single('video'), async (req, res) => {
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
      return res.status(400).json({ success: false, error: 'Відеофайл не отримано' });
    }

    const duration = Math.max(0, Math.min(300, Number(req.body.duration) || 0));
    // Приймаємо будь-який mime що записує браузер (webm, mp4, x-matroska тощо)
    const rawMime = req.file.mimetype || '';
    const mimeType = rawMime || 'video/webm';

    const mediaUrl = await uploadVideoFile(room, req.file.buffer, mimeType);
    const partnerIsViewing = isPartnerViewingRoom(room, username);
    const payload = await broadcastVideoMessage(room, username, mediaUrl, duration, partnerIsViewing);

    res.json({ success: true, message: payload });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Не вдалось надіслати відеоповідомлення' });
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

// --- Групи: ролі та права ---
// owner   — найвища роль: будь-яка дія + єдиний, хто може змінювати ролі
// admin   — як owner, окрім зміни ролей і видалення/кіку owner/admin
// member  — пише, видаляє СВОЇ повідомлення, додає нових учасників
// serf    — "раб божий": лише пише повідомлення, нічого більше
const ROLE_RANK = { owner: 3, admin: 2, member: 1, serf: 0 };

function groupRoomName(groupId) {
  return `group_${groupId}`;
}

function isGroupRoom(room) {
  return typeof room === 'string' && room.startsWith('group_');
}

function groupIdFromRoom(room) {
  const id = Number((room || '').replace('group_', ''));
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function getMembership(groupId, username) {
  const { data, error } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .ilike('username', username)
    .maybeSingle();
  if (error || !data) return null;
  return data.role;
}

function canDeleteOthersMessages(role) {
  return role === 'owner' || role === 'admin';
}

function canAddMembers(role) {
  return role === 'owner' || role === 'admin' || role === 'member';
}

function canKickMembers(role) {
  return role === 'owner' || role === 'admin';
}

function canChangeRoles(role) {
  return role === 'owner';
}

// Адмін не може кікнути/принизити іншого admin чи owner — тільки owner може
function canActOnTarget(actorRole, targetRole) {
  if (actorRole === 'owner') return targetRole !== 'owner'; // власник не діє на самого себе через ці методи
  if (actorRole === 'admin') return targetRole === 'member' || targetRole === 'serf';
  return false;
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

// Безпечно тягне підпис/колір аватарки. Якщо колонок bio/avatar_color ще
// немає в базі (наприклад, не виконана SQL-міграція) — не ламає логін/чати,
// просто повертає пусті значення.
async function fetchPublicProfile(username) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('bio, avatar_color')
      .ilike('username', username)
      .maybeSingle();
    if (error || !data) return { bio: '', avatarColor: '' };
    return { bio: data.bio || '', avatarColor: data.avatar_color || '' };
  } catch (_err) {
    return { bio: '', avatarColor: '' };
  }
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

    const profile = await fetchPublicProfile(data.username);
    callback({
      success: true,
      username: data.username,
      token,
      bio: profile.bio,
      avatarColor: profile.avatarColor,
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

    const profile = await fetchPublicProfile(username);
    callback({
      success: true,
      username,
      bio: profile.bio,
      avatarColor: profile.avatarColor,
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

    // Спочатку перевіримо, чи колонки існують, зробивши SELECT
    const { data: checkData, error: checkError } = await supabase
      .from('users')
      .select('bio, avatar_color')
      .ilike('username', socket.username)
      .maybeSingle();

    if (checkError) {
      const msg = checkError.message || '';
      console.error('[update profile] SELECT check failed:', checkError);
      if (msg.includes('column') && (msg.includes('bio') || msg.includes('avatar_color'))) {
        return cb({ success: false, error: 'SQL-міграцію не виконано. Запусти profile-fields.sql у Supabase → SQL Editor' });
      }
      return cb({ success: false, error: 'Помилка бази даних: ' + msg });
    }

    const { error, count } = await supabase
      .from('users')
      .update({ bio: cleanBio, avatar_color: cleanColor || null })
      .ilike('username', socket.username)
      .select();

    if (error) {
      const msg = error.message || '';
      console.error('[update profile] UPDATE failed:', error);
      if (msg.includes('column') && (msg.includes('bio') || msg.includes('avatar_color'))) {
        return cb({ success: false, error: 'SQL-міграцію не виконано. Запусти profile-fields.sql у Supabase → SQL Editor' });
      }
      if (msg.includes('row-level security') || msg.includes('policy') || error.code === '42501') {
        return cb({ success: false, error: 'RLS блокує UPDATE. Додай політику у Supabase → Authentication → Policies' });
      }
      return cb({ success: false, error: 'Не вдалося зберегти профіль: ' + msg });
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
      .is('group_id', null)
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
      .select('username')
      .ilike('username', partnerUsername)
      .maybeSingle();

    if (error || !data) {
      return callback({ success: false, error: 'Користувача не знайдено' });
    }

    const room = makeRoomName(socket.username, data.username);
    const profile = await fetchPublicProfile(data.username);
    callback({
      success: true,
      room,
      partner: data.username,
      bio: profile.bio,
      avatarColor: profile.avatarColor,
    });
  });

  socket.on('join room', async (room) => {
    if (!requireAuth(socket)) return;

    if (isGroupRoom(room)) {
      const groupId = groupIdFromRoom(room);
      if (!groupId) return;
      const role = await getMembership(groupId, socket.username);
      if (!role) return; // не учасник цієї групи — не пускаємо

      if (socket.currentRoom && socket.currentRoom !== room) {
        socket.leave(socket.currentRoom);
      }
      socket.join(room);
      socket.currentRoom = room;
    } else {
      // Приватний чат: кімната — це 'user1_user2', перевіряємо, що юзер є учасником
      const parts = (room || '').split('_');
      if (parts.length !== 2 || !parts.includes(socket.username.toLowerCase())) {
        return;
      }

      if (socket.currentRoom && socket.currentRoom !== room) {
        socket.leave(socket.currentRoom);
      }
      socket.join(room);
      socket.currentRoom = room;
    }

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

  // =============================================================
  // --- Групи ---
  // =============================================================

  // Створити групу — той, хто створює, стає owner
  socket.on('create group', async ({ name }, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});

    const cleanName = (name || '').toString().trim().slice(0, 64);
    if (!cleanName) {
      return cb({ success: false, error: 'Введи назву групи' });
    }

    const { data: group, error: groupErr } = await supabase
      .from('groups')
      .insert({ name: cleanName, created_by: socket.username })
      .select('id, name, created_at')
      .single();

    if (groupErr || !group) {
      console.error(groupErr);
      return cb({ success: false, error: 'Не вдалося створити групу' });
    }

    const { error: memberErr } = await supabase
      .from('group_members')
      .insert({ group_id: group.id, username: socket.username, role: 'owner' });

    if (memberErr) {
      console.error(memberErr);
      return cb({ success: false, error: 'Групу створено, але не вдалося додати власника' });
    }

    cb({
      success: true,
      group: { id: group.id, name: group.name, room: groupRoomName(group.id), role: 'owner' },
    });
  });

  // Додати учасника в групу (owner, admin, member — НЕ serf)
  socket.on('add group member', async ({ room, username }, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});

    const groupId = groupIdFromRoom(room);
    if (!groupId) return cb({ success: false, error: 'Невірна група' });

    const myRole = await getMembership(groupId, socket.username);
    if (!myRole) return cb({ success: false, error: 'Ти не учасник цієї групи' });
    if (!canAddMembers(myRole)) {
      return cb({ success: false, error: 'У тебе немає прав додавати учасників' });
    }

    const targetUsername = (username || '').toString().trim().replace(/^@/, '');
    if (!targetUsername) return cb({ success: false, error: 'Введи юзернейм' });

    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('username')
      .ilike('username', targetUsername)
      .maybeSingle();

    if (userErr || !userRow) {
      return cb({ success: false, error: 'Користувача не знайдено' });
    }

    const existingRole = await getMembership(groupId, userRow.username);
    if (existingRole) {
      return cb({ success: false, error: 'Цей користувач вже в групі' });
    }

    const { error: insertErr } = await supabase
      .from('group_members')
      .insert({ group_id: groupId, username: userRow.username, role: 'member' });

    if (insertErr) {
      console.error(insertErr);
      return cb({ success: false, error: 'Не вдалося додати учасника' });
    }

    io.to(room).emit('group member added', { room, username: userRow.username, role: 'member' });
    emitToUser(userRow.username, 'added to group', { room, groupId, addedBy: socket.username });
    cb({ success: true });
  });

  // Видалити (кікнути) учасника — owner/admin, з обмеженнями canActOnTarget
  socket.on('remove group member', async ({ room, username }, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});

    const groupId = groupIdFromRoom(room);
    if (!groupId) return cb({ success: false, error: 'Невірна група' });

    const myRole = await getMembership(groupId, socket.username);
    if (!myRole) return cb({ success: false, error: 'Ти не учасник цієї групи' });
    if (!canKickMembers(myRole)) {
      return cb({ success: false, error: 'У тебе немає прав видаляти учасників' });
    }

    const targetUsername = (username || '').toString().trim();
    if (targetUsername.toLowerCase() === socket.username.toLowerCase()) {
      return cb({ success: false, error: 'Не можна видалити самого себе звідси' });
    }

    const targetRole = await getMembership(groupId, targetUsername);
    if (!targetRole) return cb({ success: false, error: 'Цього користувача немає в групі' });

    if (!canActOnTarget(myRole, targetRole)) {
      return cb({ success: false, error: 'У тебе немає прав видалити цього учасника' });
    }

    const { error } = await supabase
      .from('group_members')
      .delete()
      .eq('group_id', groupId)
      .ilike('username', targetUsername);

    if (error) {
      console.error(error);
      return cb({ success: false, error: 'Не вдалося видалити учасника' });
    }

    io.to(room).emit('group member removed', { room, username: targetUsername });
    emitToUser(targetUsername, 'removed from group', { room, groupId, removedBy: socket.username });
    cb({ success: true });
  });

  // Змінити роль учасника — лише owner, і не на самого owner
  socket.on('change member role', async ({ room, username, role }, callback) => {
    if (!requireAuth(socket, callback)) return;
    const cb = callback || (() => {});

    const groupId = groupIdFromRoom(room);
    if (!groupId) return cb({ success: false, error: 'Невірна група' });

    const myRole = await getMembership(groupId, socket.username);
    if (!myRole) return cb({ success: false, error: 'Ти не учасник цієї групи' });
    if (!canChangeRoles(myRole)) {
      return cb({ success: false, error: 'Лише власник може змінювати ролі' });
    }

    const newRole = (role || '').toString().trim();
    if (!Object.prototype.hasOwnProperty.call(ROLE_RANK, newRole) || newRole === 'owner') {
      return cb({ success: false, error: 'Невірна роль' });
    }

    const targetUsername = (username || '').toString().trim();
    if (targetUsername.toLowerCase() === socket.username.toLowerCase()) {
      return cb({ success: false, error: 'Не можна змінити власну роль' });
    }

    const targetRole = await getMembership(groupId, targetUsername);
    if (!targetRole) return cb({ success: false, error: 'Цього користувача немає в групі' });
    if (targetRole === 'owner') {
      return cb({ success: false, error: 'Не можна змінити роль власника' });
    }

    const { error } = await supabase
      .from('group_members')
      .update({ role: newRole })
      .eq('group_id', groupId)
      .ilike('username', targetUsername);

    if (error) {
      console.error(error);
      return cb({ success: false, error: 'Не вдалося змінити роль' });
    }

    io.to(room).emit('member role changed', { room, username: targetUsername, role: newRole });
    cb({ success: true, role: newRole });
  });

  // Список учасників групи з ролями
  socket.on('get group members', async (room, callback) => {
    const cb = callback || (() => {});
    const groupId = groupIdFromRoom(room);
    if (!groupId) return cb([]);

    const myRole = await getMembership(groupId, socket.username);
    if (!myRole) return cb([]); // не учасник — нічого не бачить

    const { data, error } = await supabase
      .from('group_members')
      .select('username, role, joined_at')
      .eq('group_id', groupId)
      .order('joined_at', { ascending: true });

    if (error) {
      console.error(error);
      return cb([]);
    }
    cb(data || []);
  });

  // Список груп, у яких я перебуваю
  socket.on('get groups', async (_unused, callback) => {
    const cb = callback || (() => {});
    if (!requireAuth(socket, () => cb([]))) return;

    const { data, error } = await supabase
      .from('group_members')
      .select('role, groups(id, name)')
      .ilike('username', socket.username);

    if (error) {
      console.error(error);
      return cb([]);
    }

    const result = (data || [])
      .filter((row) => row.groups)
      .map((row) => ({
        id: row.groups.id,
        name: row.groups.name,
        room: groupRoomName(row.groups.id),
        role: row.role,
      }));
    cb(result);
  });



  socket.on('chat message', async (data) => {
    if (!requireAuth(socket)) return;
    // Кімната має бути та, в яку юзер реально приєднався — і він має бути її учасником
    if (data.room !== socket.currentRoom || !socket.rooms.has(data.room)) return;

    const text = (data.text || '').trim();
    if (!text) return;

    const groupId = isGroupRoom(data.room) ? groupIdFromRoom(data.room) : null;
    if (groupId) {
      // Усі ролі, включно з "раб божий", можуть писати — перевіряємо лише членство
      const role = await getMembership(groupId, socket.username);
      if (!role) return;
    }

    const partnerIsViewing = isPartnerViewingRoom(data.room, socket.username);

    const { data: inserted, error } = await supabase
      .from('messages')
      .insert({
        room: data.room,
        username: socket.username,
        text,
        read: partnerIsViewing,
        group_id: groupId,
      })
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

    if (!groupId) {
      const partnerUsername = getRoomPartner(data.room, socket.username);
      emitToUser(partnerUsername, 'new message notification', {
        id: inserted.id,
        room: data.room,
        from: socket.username,
        text,
      });
    }
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

    if (isGroupRoom(room)) {
      const groupId = groupIdFromRoom(room);
      const myRole = await getMembership(groupId, socket.username);
      if (!myRole) return cb({ success: false, error: 'Ти не учасник цієї групи' });
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

    if (fetchErr || !existing) {
      return cb({ success: false, error: 'Неможливо видалити це повідомлення' });
    }

    const isOwnMessage = existing.username === socket.username;
    const groupId = isGroupRoom(room) ? groupIdFromRoom(room) : null;

    if (groupId) {
      const myRole = await getMembership(groupId, socket.username);
      if (!myRole) return cb({ success: false, error: 'Ти не учасник цієї групи' });

      if (isOwnMessage) {
        // "Раб божий" не може видаляти навіть власні повідомлення
        if (myRole === 'serf') {
          return cb({ success: false, error: 'У тебе немає прав видаляти повідомлення' });
        }
      } else if (!canDeleteOthersMessages(myRole)) {
        return cb({ success: false, error: 'У тебе немає прав видаляти чужі повідомлення' });
      }
    } else if (!isOwnMessage) {
      // Приватний чат: можна видаляти лише власні повідомлення
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
