const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Встанови свій власний секретний код доступу
const ACCESS_CODE = '1234';

// Дані підключення до Supabase (можна винести у змінні середовища)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://klosisstvruqkiialvcx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Wn4Gn_lJq9SLRowgsnxlzQ_XqQ13-Ot';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Хтось приєднався до сервера');

  socket.on('check password', (password, callback) => {
    callback(password === ACCESS_CODE);
  });

  socket.on('join room', (room) => {
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
    supabase
      .from('messages')
      .insert({ room: data.room, username: data.user, text: data.text })
      .then(({ error }) => {
        if (error) console.error(error);
      });
    io.to(data.room).emit('chat message', { user: data.user, text: data.text });
  });

  socket.on('disconnect', () => {
    console.log('Хтось вийшов з сервера');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Сервер запущено! Порт:', PORT);
});