const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Estado compartido ----------
// La posición del video se guarda como "posición base + tiempo transcurrido desde baseTime"
// así no hace falta ir actualizándola cada segundo.
const state = {
  current: null,   // { id, videoId, title, author, addedBy }
  playing: false,
  basePos: 0,
  baseTime: Date.now(),
  queue: [],
};
const users = new Map(); // socket.id -> nombre
const chat = [];         // últimos mensajes
let nextId = 1;

function position() {
  return state.playing ? state.basePos + (Date.now() - state.baseTime) / 1000 : state.basePos;
}

function setPos(pos, playing) {
  state.basePos = Math.max(0, pos);
  state.baseTime = Date.now();
  state.playing = playing;
}

function snapshot() {
  return { current: state.current, playing: state.playing, position: position(), queue: state.queue };
}

function broadcast() {
  io.emit('state', snapshot());
}

function sendUsers() {
  io.emit('users', [...users.values()]);
}

function pushChat(msg) {
  msg.time = Date.now();
  chat.push(msg);
  if (chat.length > 100) chat.shift();
  io.emit('chat', msg);
}

function system(text) {
  pushChat({ system: true, text });
}

function playItem(item) {
  state.current = item;
  setPos(0, true);
}

function next() {
  const item = state.queue.shift();
  if (item) {
    playItem(item);
  } else {
    state.current = null;
    setPos(0, false);
  }
  broadcast();
}

// Acepta enlaces de youtube.com, youtu.be, shorts, embed, live, music o un ID suelto
function parseVideoId(input) {
  if (typeof input !== 'string') return null;
  input = input.trim();
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input.startsWith('http') ? input : 'https://' + input);
    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1, 12);
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = url.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

async function fetchInfo(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title, author: data.author_name };
  } catch {
    return null;
  }
}

// ---------- Conexiones ----------
io.on('connection', (socket) => {
  const name = () => users.get(socket.id) || 'Alguien';

  socket.emit('state', snapshot());
  socket.emit('chatHistory', chat);

  socket.on('join', (rawName) => {
    const clean = String(rawName || '').trim().slice(0, 24) || `Invitado${Math.floor(Math.random() * 1000)}`;
    users.set(socket.id, clean);
    sendUsers();
    system(`${clean} se ha unido`);
  });

  socket.on('add', async ({ url, now } = {}) => {
    if (!users.has(socket.id)) return;
    const videoId = parseVideoId(url);
    if (!videoId) return socket.emit('toast', 'Ese enlace no parece un video de YouTube');

    const info = await fetchInfo(videoId);
    const item = {
      id: nextId++,
      videoId,
      title: info?.title || `Video ${videoId}`,
      author: info?.author || '',
      addedBy: name(),
    };

    if (now || !state.current) {
      playItem(item);
      system(`${name()} puso «${item.title}»`);
    } else {
      state.queue.push(item);
      system(`${name()} añadió «${item.title}» a la cola`);
    }
    broadcast();
  });

  socket.on('play', () => {
    if (!state.current || state.playing) return;
    setPos(position(), true);
    broadcast();
  });

  socket.on('pause', () => {
    if (!state.current || !state.playing) return;
    setPos(position(), false);
    broadcast();
  });

  socket.on('seek', (t) => {
    if (!state.current || typeof t !== 'number' || !isFinite(t)) return;
    setPos(t, state.playing);
    broadcast();
  });

  socket.on('skip', () => {
    if (!state.current) return;
    system(`${name()} pasó al siguiente video`);
    next();
  });

  // Todos los clientes avisan cuando acaba el video; solo cuenta el primero
  socket.on('ended', (itemId) => {
    if (state.current && state.current.id === itemId) next();
  });

  socket.on('videoError', (itemId) => {
    if (state.current && state.current.id === itemId) {
      system(`«${state.current.title}» no se puede reproducir aquí, saltando…`);
      next();
    }
  });

  socket.on('playFromQueue', (itemId) => {
    const i = state.queue.findIndex((q) => q.id === itemId);
    if (i === -1) return;
    const [item] = state.queue.splice(i, 1);
    playItem(item);
    system(`${name()} puso «${item.title}»`);
    broadcast();
  });

  socket.on('remove', (itemId) => {
    const i = state.queue.findIndex((q) => q.id === itemId);
    if (i === -1) return;
    state.queue.splice(i, 1);
    broadcast();
  });

  socket.on('move', ({ itemId, dir } = {}) => {
    const i = state.queue.findIndex((q) => q.id === itemId);
    const j = i + (dir < 0 ? -1 : 1);
    if (i === -1 || j < 0 || j >= state.queue.length) return;
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    broadcast();
  });

  socket.on('chat', (text) => {
    if (!users.has(socket.id)) return;
    text = String(text || '').trim().slice(0, 300);
    if (text) pushChat({ name: name(), text });
  });

  socket.on('disconnect', () => {
    if (users.has(socket.id)) {
      const n = name();
      users.delete(socket.id);
      sendUsers();
      system(`${n} se ha ido`);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n▶ YouTube compartido funcionando`);
  console.log(`  En este PC:        http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  En tu red (wifi):  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
