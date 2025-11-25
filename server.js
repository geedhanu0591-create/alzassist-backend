// backend/server.js
// Full safe backend with meds, journals, appointments, notifications, SOS, web-push support

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const multer = require('multer');
const webpush = require('web-push');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' } });

// DB file
const DB_FILE = path.join(__dirname, 'database.json');

// Safe read / write functions (no atomic rename)
function readDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    const empty = {
      users: [],
      patients: [],
      caretakers: [],
      notifications: [],
      locationHistory: [],
      meds: [],
      journals: [],
      appointments: [],
      webpushSubscriptions: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
let db = readDB();

// multer for file uploads
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// --- web-push configuration (VAPID keys must be set in .env)
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:you@example.com', VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('Web-push VAPID keys set.');
} else {
  console.log('No VAPID keys found — web push disabled until configured.');
}

// ------------- Socket.IO real-time logic -------------
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join', (data) => {
    // optional room join by userId or caretaker
    if (data && data.userId) {
      socket.join(String(data.userId));
    }
  });

  socket.on('updateLocation', (payload) => {
    // store location
    db = readDB();
    db.locationHistory.push({ id: Date.now(), userId: payload.userId, lat: payload.lat, lng: payload.lng, time: payload.timestamp || Date.now() });
    writeDB(db);

    // broadcast to all connected caretakers (or use logic to emit to specific rooms)
    io.emit('locationUpdate', payload);
  });

  socket.on('sos', (payload) => {
    db = readDB();
    const n = { id: Date.now(), type: 'sos', message: `SOS from ${payload.name || payload.from}`, from: payload.from, time: payload.time || Date.now(), read: false };
    db.notifications.push(n);
    writeDB(db);

    io.emit('sos', payload);
    io.emit('notification', n);
    // attempt web-push to all subscriptions
    sendWebPushNotification(n).catch(console.warn);
  });

  socket.on('journal', (payload) => {
    db = readDB();
    db.journals.push(payload.entry);
    writeDB(db);

    io.emit('journal', payload);
    const n = { id: Date.now(), type: 'journal', message: `New journal from ${payload.author}`, time: Date.now(), read: false };
    db.notifications.push(n);
    writeDB(db);
    io.emit('notification', n);
    sendWebPushNotification(n).catch(console.warn);
  });

  socket.on('medicationUpdate', (payload) => {
    // broadcast med updates
    io.emit('medicationUpdate', payload);
    const n = { id: Date.now(), type: 'med', message: 'Medication updated', payload, time: Date.now(), read: false };
    db = readDB();
    db.notifications.push(n);
    writeDB(db);
    io.emit('notification', n);
    sendWebPushNotification(n).catch(console.warn);
  });
});

// ------------------- REST endpoints -------------------

// Basic auth-like register/login from your simple server (keep existing)
app.post('/register', (req, res) => {
  const { role, name, email, password } = req.body;
  db = readDB();
  if (db.users.find(u => u.email === email)) return res.status(400).json({ message: 'Email already exists' });
  const newUser = { id: Date.now(), role, name, email, password };
  db.users.push(newUser);
  writeDB(db);
  res.json({ message: 'Registered successfully' });
});
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db = readDB();
  const user = db.users.find(u => u.email === email && u.password === password);
  if (!user) return res.status(400).json({ message: 'Invalid credentials' });
  res.json(user);
});

// uploadPerson (you already had)
app.post('/uploadPerson', upload.single('photo'), (req, res) => {
  const { name, relation, phone, ownerId } = req.body;
  db = readDB();
  db.patients.push({ id: Date.now(), ownerId, name, relation, phone, photo: req.file ? req.file.filename : null });
  writeDB(db);
  res.json({ message: 'Person saved successfully' });
});

// ---------------- meds endpoints ----------------
app.get('/meds', (req, res) => {
  db = readDB();
  res.json(db.meds || []);
});

app.post('/meds', (req, res) => {
  const { name, dose, time, forUser } = req.body;
  db = readDB();
  const med = { id: Date.now().toString(), name, dose, time, forUser: forUser || null, createdAt: Date.now() };
  db.meds.push(med);
  writeDB(db);
  io.emit('medicationUpdate', { med, action: 'added' });
  res.json(med);
});

app.delete('/meds/:id', (req, res) => {
  const id = req.params.id;
  db = readDB();
  db.meds = (db.meds || []).filter(m => m.id !== id);
  writeDB(db);
  io.emit('medicationUpdate', { action: 'removed', id });
  res.json({ ok: true });
});

app.post('/meds/mark', (req, res) => {
  const { medId, by } = req.body;
  db = readDB();
  const hist = db.medHistory || [];
  const record = { id: Date.now().toString(), medId, by, time: Date.now() };
  db.medHistory = hist.concat(record);
  writeDB(db);
  io.emit('medicationUpdate', { action: 'taken', medId, by });
  res.json({ ok: true, record });
});

// ---------------- journals endpoints ----------------
app.get('/journals', (req, res) => {
  db = readDB();
  res.json(db.journals || []);
});

app.post('/journals', (req, res) => {
  const { author, text } = req.body;
  db = readDB();
  const entry = { id: Date.now().toString(), author, text, time: Date.now() };
  db.journals.push(entry);
  writeDB(db);
  io.emit('journal', { entry, author });
  const n = { id: Date.now(), type: 'journal', message: `New journal by ${author}`, time: Date.now(), read: false };
  db.notifications.push(n); writeDB(db);
  io.emit('notification', n);
  sendWebPushNotification(n).catch(console.warn);
  res.json(entry);
});

// --------------- appointments endpoints ---------------
app.get('/appointments', (req, res) => {
  db = readDB();
  res.json(db.appointments || []);
});

app.post('/appointments', (req, res) => {
  const { title, time, forUser, notes } = req.body;
  db = readDB();
  const appt = { id: Date.now().toString(), title, time: Number(time), forUser: forUser || null, notes: notes || '', createdAt: Date.now() };
  db.appointments.push(appt);
  writeDB(db);
  io.emit('appointmentCreated', appt);
  // schedule a simple reminder: server will check appointments periodically and emit reminders (see below)
  res.json(appt);
});

app.delete('/appointments/:id', (req, res) => {
  const id = req.params.id;
  db = readDB();
  db.appointments = (db.appointments || []).filter(a => a.id !== id);
  writeDB(db);
  res.json({ ok: true });
});

// --------------- notifications endpoints ---------------
app.get('/notifications', (req, res) => {
  db = readDB();
  res.json(db.notifications || []);
});

app.delete('/notifications/:id', (req, res) => {
  const id = req.params.id;
  db = readDB();
  db.notifications = (db.notifications || []).map(n => n.id === id ? {...n, read: true} : n);
  writeDB(db);
  res.json({ ok: true });
});

// --------------- SOS endpoint (HTTP version) ---------------
app.post('/sos', (req, res) => {
  const { from, name } = req.body;
  db = readDB();
  const n = { id: Date.now().toString(), type: 'sos', message: `SOS from ${name || from}`, from, time: Date.now(), read: false };
  db.notifications.push(n);
  writeDB(db);
  io.emit('sos', { from, name, time: Date.now() });
  io.emit('notification', n);
  sendWebPushNotification(n).catch(console.warn);
  res.json({ ok: true });
});

// --------------- web-push subscription endpoint ---------------
app.post('/subscribe', (req, res) => {
  const sub = req.body; // subscription object
  db = readDB();
  db.webpushSubscriptions = db.webpushSubscriptions || [];
  db.webpushSubscriptions.push(sub);
  writeDB(db);
  res.json({ ok: true });
});

// helper to send web push to stored subscriptions
async function sendWebPushNotification(payload) {
  db = readDB();
  const subs = db.webpushSubscriptions || [];
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.log('VAPID not configured - skipping web-push');
    return;
  }
  const promiseList = subs.map(s => {
    return webpush.sendNotification(s, JSON.stringify({ title: 'AlzAssist', body: payload.message, data: payload })).catch(err => {
      console.warn('webpush error', err);
      // optionally remove invalid subscriptions
    });
  });
  await Promise.allSettled(promiseList);
}

// ---------------- appointment reminder runner (simple) ---------------
setInterval(() => {
  // every minute, check for appointments within next minute and emit reminders
  db = readDB();
  const now = Date.now();
  const soon = db.appointments ? db.appointments.filter(a => a.time && a.time > now && a.time <= now + (60 * 1000)) : [];
  soon.forEach(a => {
    const n = { id: Date.now().toString(), type: 'appointment', message: `Upcoming: ${a.title}`, appointment: a, time: Date.now(), read: false };
    db.notifications.push(n);
    writeDB(db);
    io.emit('appointmentReminder', { appointment: a });
    io.emit('notification', n);
    sendWebPushNotification(n).catch(console.warn);
  });
}, 60 * 1000);

// ---------------- start server ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
