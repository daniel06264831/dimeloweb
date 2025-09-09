const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const os = require('os');
const PDFDocument = require('pdfkit');
const multer = require('multer');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { MongoClient } = require('mongodb');
const cors = require('cors');

// MongoDB URI: use environment variable if provided, otherwise fall back to default
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://daniel:daniel25@capacitacion.nxd7yl9.mongodb.net/?retryWrites=true&w=majority&appName=capacitacion&authSource=admin';

// Defaults for Render deployment (can be overridden in environment variables)
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'https://dimeloweb.onrender.com';
process.env.SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
process.env.SMTP_PORT = process.env.SMTP_PORT || '587';
process.env.SMTP_SECURE = process.env.SMTP_SECURE || 'false';
process.env.FROM_EMAIL = process.env.FROM_EMAIL || (process.env.SMTP_USER || '');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN || '*' } });

const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
// static serving moved below after API routes to avoid static fallback for /api/*

app.use(express.static(path.join(__dirname, 'public')));

// In-memory caches (backed by MongoDB)
let dbClient = null;
let db = null;
let projectsCache = [];
let transactionsCache = [];
let usersCache = [];

async function initDb() {
  const uri = MONGODB_URI;
  dbClient = await MongoClient.connect(uri);
  db = dbClient.db();

  // Load collections into in-memory caches (no local seeding in Render)
  const pColl = db.collection('projects');
  const tColl = db.collection('transactions');
  const uColl = db.collection('users');

  projectsCache = await pColl.find({}).toArray();
  transactionsCache = await tColl.find({}).toArray();
  usersCache = await uColl.find({}).toArray();

  console.log('Connected to MongoDB and caches initialized (no local files used)');
}

// Replace file-based read/write with cache-backed helpers
function readProjects() {
  // return same shape as before
  return { projects: projectsCache.map(p => {
    const copy = Object.assign({}, p);
    delete copy._id;
    return copy;
  }) };
}

function writeProjects(data) {
  projectsCache = (data && data.projects) ? data.projects.map(p => Object.assign({}, p)) : [];
  // persist async
  (async () => {
    try {
      if (!db) return; // DB not ready
      const coll = db.collection('projects');
      await coll.deleteMany({});
      if (projectsCache.length) await coll.insertMany(projectsCache);
    } catch (e) { console.error('writeProjects error', e); }
  })();
}

function readTransactions() {
  return { transactions: transactionsCache.map(t => { const copy = Object.assign({}, t); delete copy._id; return copy; }) };
}

function writeTransactions(data) {
  transactionsCache = (data && data.transactions) ? data.transactions.map(t => Object.assign({}, t)) : [];
  (async () => {
    try {
      if (!db) return;
      const coll = db.collection('transactions');
      await coll.deleteMany({});
      if (transactionsCache.length) await coll.insertMany(transactionsCache);
    } catch (e) { console.error('writeTransactions error', e); }
  })();
}

function readUsers() {
  return { users: usersCache.map(u => { const copy = Object.assign({}, u); delete copy._id; return copy; }) };
}

function writeUsers(data) {
  usersCache = (data && data.users) ? data.users.map(u => Object.assign({}, u)) : [];
  (async () => {
    try {
      if (!db) return;
      const coll = db.collection('users');
      await coll.deleteMany({});
      if (usersCache.length) await coll.insertMany(usersCache);
    } catch (e) { console.error('writeUsers error', e); }
  })();
}

// REST endpoints (optional)
app.get('/api/projects', (req, res) => {
  res.json(readProjects());
});

app.post('/api/projects', (req, res) => {
  const data = readProjects();
  const project = req.body;
  project.id = Date.now().toString();
  project.items = project.items || [];
  data.projects.push(project);
  writeProjects(data);
  io.emit('projects:update', data);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  const data = readProjects();
  const idx = data.projects.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.projects[idx] = Object.assign({}, data.projects[idx], req.body);
  writeProjects(data);
  io.emit('projects:update', data);
  res.json(data.projects[idx]);
});

app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  const data = readProjects();
  const idx = data.projects.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const removed = data.projects.splice(idx, 1)[0];
  writeProjects(data);
  io.emit('projects:update', data);
  res.json(removed);
});

app.post('/api/transactions/pdf', (req, res) => {
  const { projectId, transactionIds } = req.body || {};
  if (!projectId || !Array.isArray(transactionIds)) return res.status(400).json({ error: 'Invalid payload' });

  const txData = readTransactions();
  const selected = txData.transactions.filter(t => t.projectId === projectId && transactionIds.includes(t.id));
  if (!selected.length) return res.status(400).json({ error: 'No transactions selected' });

  // stream PDF directly to response
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=transacciones_${projectId}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);

  // Header / branding
  doc.rect(0, 0, doc.page.width, 80).fill('#0e4c94');
  doc.fillColor('#ffffff').fontSize(24).text('NAISATA', 40, 24);
  doc.fillColor('#ffffff').fontSize(10).text('Reporte de movimientos', 40, 50);
  doc.moveDown(3);

  // Table header
  doc.moveDown(1);
  doc.fillColor('#000000').fontSize(10);
  const tableTop = doc.y;
  doc.text('Fecha', 40, tableTop);
  doc.text('Tipo', 150, tableTop);
  doc.text('Nombre', 210, tableTop);
  doc.text('Parte', 340, tableTop);
  doc.text('Ubicación', 420, tableTop);
  doc.text('Cantidad', 520, tableTop);
  doc.moveDown(0.5);

  // Rows
  selected.forEach(t => {
    const y = doc.y;
    doc.fontSize(9).fillColor('#222').text(new Date(t.date).toLocaleString(), 40, y);
    doc.text(t.type.toUpperCase(), 150, y);
    doc.text(t.name, 210, y, { width: 120 });
    doc.text(t.partNumber || '-', 340, y);
    doc.text(t.location || '-', 420, y);
    doc.text(String(t.qty), 520, y);
    doc.moveDown(0.6);
  });

  doc.end();
});

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const users = readUsers();
  if (users.users.find(u => u.username === username)) return res.status(400).json({ error: 'User exists' });
  const hash = bcrypt.hashSync(password, 8);
  const user = { id: Date.now().toString(), username, passwordHash: hash };
  users.users.push(user);
  writeUsers(users);
  // simple token
  const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
  res.json({ id: user.id, username: user.username, token });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const users = readUsers();
  const user = users.users.find(u => u.username === username);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  if (!bcrypt.compareSync(password, user.passwordHash)) return res.status(400).json({ error: 'Invalid credentials' });
  const token = Buffer.from(`${user.id}:${user.username}`).toString('base64');
  res.json({ id: user.id, username: user.username, token });
});

// Middleware to verify token (simple)
function authFromHeader(req) {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const parts = auth.split(' ');
  const token = parts.length === 2 ? parts[1] : auth;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [id, username] = decoded.split(':');
    return { id, username };
  } catch (e) { return null; }
}

// Protect import endpoint example
app.post('/api/projects/:id/import', upload.single('file'), (req, res) => {
  const projectId = req.params.id;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file' });

  const authUser = authFromHeader(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });

  const data = readProjects();
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const ext = path.extname(file.originalname).toLowerCase();
  let items = [];
  try {
    if (ext === '.json') {
      const raw = fs.readFileSync(file.path, 'utf8');
      const parsed = JSON.parse(raw);
      // expect array or { items: [] }
      if (Array.isArray(parsed)) items = parsed;
      else if (parsed.items && Array.isArray(parsed.items)) items = parsed.items;
    } else if (ext === '.xls' || ext === '.xlsx') {
      const workbook = XLSX.readFile(file.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      items = XLSX.utils.sheet_to_json(sheet);
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    // Normalize items: support Spanish and English column names
    items.forEach(it => {
      const get = (...keys) => {
        for (const k of keys) {
          if (it[k] !== undefined && it[k] !== null && String(it[k]).trim() !== '') return it[k];
        }
        return undefined;
      };

      const rawName = get('name', 'Name', 'nombre', 'Nombre', 'Nombre del insumo');
      const rawPart = get('partNumber', 'part_number', 'numero_parte', 'numeroParte', 'Número de parte', 'numero_parte');
      const rawLocation = get('location', 'ubicacion', 'Ubicación', 'Ubicacion', 'Location', 'ubicacion');
      const rawQty = get('qty', 'cantidad', 'Cantidad', 'amount', 'cant', 'cantidad_total', 'Cantidad_total');
      const rawId = get('id', 'ID', 'Id', 'identificador');

      // normalize qty
      let qtyNum = 0;
      if (rawQty !== undefined && rawQty !== null && String(rawQty).trim() !== '') {
        if (typeof rawQty === 'number') qtyNum = rawQty;
        else {
          const s = String(rawQty).replace(/\s+/g, '').replace(/\./g, '').replace(/,/g, '.');
          const parsed = parseFloat(s);
          qtyNum = Number.isFinite(parsed) ? parsed : 0;
        }
      }

      const item = {
        id: rawId ? String(rawId) : (Date.now().toString() + Math.floor(Math.random()*1000)),
        name: rawName ? String(rawName).trim() : undefined,
        partNumber: rawPart ? String(rawPart).trim() : null,
        location: rawLocation ? String(rawLocation).trim() : null,
        qty: qtyNum
      };

      if (item.name) project.items.push(item);
    });

    writeProjects(data);
    io.emit('projects:update', data);
    fs.unlinkSync(file.path);
    res.json({ imported: true, added: project.items.length });
  } catch (err) {
    console.error(err);
    try { fs.unlinkSync(file.path); } catch(e){}
    res.status(500).json({ error: 'Import failed' });
  }
});

// helper to generate PDF buffer from selected transactions
function generatePdfBuffer(selected) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // Header / branding
      doc.rect(0, 0, doc.page.width, 80).fill('#0e4c94');
      doc.fillColor('#ffffff').fontSize(24).text('NAISATA', 40, 24);
      doc.fillColor('#ffffff').fontSize(10).text('Reporte de movimientos', 40, 50);
      doc.moveDown(3);

      // Table header
      doc.moveDown(1);
      doc.fillColor('#000000').fontSize(10);
      const tableTop = doc.y;
      doc.text('Fecha', 40, tableTop);
      doc.text('Tipo', 150, tableTop);
      doc.text('Nombre', 210, tableTop);
      doc.text('Parte', 340, tableTop);
      doc.text('Ubicación', 420, tableTop);
      doc.text('Cantidad', 520, tableTop);
      doc.moveDown(0.5);

      // Rows
      selected.forEach(t => {
        const y = doc.y;
        doc.fontSize(9).fillColor('#222').text(new Date(t.date).toLocaleString(), 40, y);
        doc.text(t.type.toUpperCase(), 150, y);
        doc.text(t.name, 210, y, { width: 120 });
        doc.text(t.partNumber || '-', 340, y);
        doc.text(t.location || '-', 420, y);
        doc.text(String(t.qty), 520, y);
        doc.moveDown(0.6);
      });

      doc.end();
    } catch (err) { reject(err); }
  });
}

// endpoint to send PDF by email
app.post('/api/transactions/pdf/send', async (req, res) => {
  const authUser = authFromHeader(req);
  if (!authUser) return res.status(401).json({ error: 'Unauthorized' });
  const { projectId, transactionIds, email } = req.body || {};
  if (!projectId || !Array.isArray(transactionIds) || transactionIds.length === 0) return res.status(400).json({ error: 'Invalid payload' });
  if (!email) return res.status(400).json({ error: 'Email required' });

  const txData = readTransactions();
  const selected = txData.transactions.filter(t => t.projectId === projectId && transactionIds.includes(t.id));
  if (!selected.length) return res.status(400).json({ error: 'No transactions selected' });

  try {
    const pdfBuffer = await generatePdfBuffer(selected);

    // create transporter from env
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.example.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: (process.env.SMTP_SECURE === 'true') || false,
      auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
      }
    });

    const from = process.env.FROM_EMAIL || (process.env.SMTP_USER || 'no-reply@example.com');
    const info = await transporter.sendMail({
      from,
      to: email,
      subject: `Transacciones - proyecto ${projectId}`,
      text: `Adjunto reporte PDF de las transacciones seleccionadas para el proyecto ${projectId}`,
      attachments: [{ filename: `transacciones_${projectId}.pdf`, content: pdfBuffer }]
    });

    return res.json({ sent: true, messageId: info.messageId });
  } catch (err) {
    console.error('Error sending PDF email', err);
    return res.status(500).json({ error: 'Failed to send email' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Client connected', socket.id);
  // Send current projects and transactions
  socket.emit('projects:init', readProjects());
  socket.emit('transactions:init', readTransactions());

  socket.on('project:create', (project) => {
    const data = readProjects();
    project.id = Date.now().toString();
    project.items = project.items || [];
    data.projects.push(project);
    writeProjects(data);
    io.emit('projects:update', data);
  });

  socket.on('project:update', (project) => {
    const data = readProjects();
    const idx = data.projects.findIndex(p => p.id === project.id);
    if (idx !== -1) {
      data.projects[idx] = project;
      writeProjects(data);
      io.emit('projects:update', data);
    }
  });

  // Disabled to force using API endpoint with auth
  // socket.on('project:delete', (id) => {
  //   const data = readProjects();
  //   const idx = data.projects.findIndex(p => p.id === id);
  //   if (idx !== -1) {
  //     data.projects.splice(idx, 1);
  //     writeProjects(data);
  //     io.emit('projects:update', data);
  //   }
  // });

  socket.on('item:add', ({ projectId, item }) => {
    const data = readProjects();
    const p = data.projects.find(pr => pr.id === projectId);
    if (p) {
      item.id = Date.now().toString();
      p.items.push(item);
      writeProjects(data);
      io.emit('projects:update', data);
    }
  });

  socket.on('item:update', ({ projectId, item }) => {
    const data = readProjects();
    const p = data.projects.find(pr => pr.id === projectId);
    if (p) {
      const idx = p.items.findIndex(it => it.id === item.id);
      if (idx !== -1) {
        p.items[idx] = item;
        writeProjects(data);
        io.emit('projects:update', data);
      }
    }
  });

  socket.on('item:delete', ({ projectId, itemId }) => {
    const data = readProjects();
    const p = data.projects.find(pr => pr.id === projectId);
    if (p) {
      const idx = p.items.findIndex(it => it.id === itemId);
      if (idx !== -1) {
        p.items.splice(idx, 1);
        writeProjects(data);
        io.emit('projects:update', data);
      }
    }
  });

  socket.on('item:out', ({ projectId, itemId, qty, note }) => {
    const data = readProjects();
    const p = data.projects.find(pr => pr.id === projectId);
    if (!p) return;
    const it = p.items.find(i => i.id === itemId);
    if (!it) return;
    const outQty = Number(qty) || 0;
    if (outQty <= 0) return;
    it.qty = Math.max(0, (Number(it.qty) || 0) - outQty);
    const txData = readTransactions();
    txData.transactions.push({
      id: Date.now().toString(),
      projectId,
      itemId,
      name: it.name,
      partNumber: it.partNumber || null,
      location: it.location || null,
      qty: outQty,
      note: note || null,
      type: 'salida',
      date: new Date().toISOString()
    });
    writeProjects(data);
    writeTransactions(txData);
    io.emit('projects:update', data);
    io.emit('transactions:update', txData);
  });

  // Registrar entrada (devolución)
  socket.on('item:in', ({ projectId, itemId, qty, note }) => {
    const data = readProjects();
    const p = data.projects.find(pr => pr.id === projectId);
    if (!p) return;
    const it = p.items.find(i => i.id === itemId);
    if (!it) return;
    const inQty = Number(qty) || 0;
    if (inQty <= 0) return;
    it.qty = (Number(it.qty) || 0) + inQty;
    const txData = readTransactions();
    txData.transactions.push({
      id: Date.now().toString(),
      projectId,
      itemId,
      name: it.name,
      partNumber: it.partNumber || null,
      location: it.location || null,
      qty: inQty,
      note: note || null,
      type: 'entrada',
      date: new Date().toISOString()
    });
    writeProjects(data);
    writeTransactions(txData);
    io.emit('projects:update', data);
    io.emit('transactions:update', txData);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

async function startServer() {
  try {
    await initDb();
  } catch (err) {
    console.error('DB init failed:', err);
    // continue running but app will be read-only until DB is available
  }

  server.listen(PORT, HOST, () => console.log(`Server listening on http://${HOST}:${PORT}`));
}

// Graceful shutdown: close MongoDB client and server
async function shutdown() {
  try {
    console.log('Shutting down...');
    if (dbClient && dbClient.close) await dbClient.close();
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
    // force exit after timeout
    setTimeout(() => process.exit(0), 5000);
  } catch (err) {
    console.error('Error during shutdown', err);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer();

// Improve 404 handler for API routes to return JSON
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  next();
});

app.post('/api/projects/:id/delete', (req, res) => {
  const auth = authFromHeader(req);
  if (!auth) return res.status(401).json({ error: 'Unauthorized' });
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const users = readUsers();
  const user = users.users.find(u => u.id === auth.id && u.username === auth.username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!bcrypt.compareSync(password, user.passwordHash)) return res.status(403).json({ error: 'Invalid password' });

  const data = readProjects();
  const idx = data.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Project not found' });
  const removed = data.projects.splice(idx, 1)[0];
  writeProjects(data);
  io.emit('projects:update', data);
  res.json({ deleted: true, project: removed });
});
