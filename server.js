const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Enable CORS for all routes (allow credentials if needed)
app.use(cors({ origin: true, credentials: true }));
// Allow preflight for all routes
app.options('*', cors());

// permitir JSON bodies
app.use(express.json());

// servir public en la raíz (ej. /style.css, /main.js, /sushi1.jpg)
app.use(express.static(path.join(__dirname, 'public')));

// rutas para promotor y restaurante (servir desde public para despliegue en Render)
app.get('/promotor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'promotor.html')));
app.get('/restaurante', (req, res) => res.sendFile(path.join(__dirname, 'public', 'restaurante.html')));

// namespace para restaurante
const restauranteNs = io.of('/restaurante');

// --- NEW (MongoDB) ---
const MONGO_URI = 'mongodb+srv://daniel:daniel25@so.k6u9iol.mongodb.net/?retryWrites=true&w=majority&appName=so&authSource=admin';

let mongoClient = null;
let db = null;
let usersCol = null;
let promotersCol = null;
let ordersCol = null;

async function initMongo() {
	// connect with a small timeout
	mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
	await mongoClient.connect();
	db = mongoClient.db('sushi_app'); // DB name
	usersCol = db.collection('users');
	promotersCol = db.collection('promoters');
	ordersCol = db.collection('orders');

	// ensure indexes for quick lookups
	await usersCol.createIndex({ phone: 1 }, { unique: true, sparse: true });
	await promotersCol.createIndex({ code: 1 }, { unique: true, sparse: true });
	await promotersCol.createIndex({ phone: 1 }, { sparse: true });
	await ordersCol.createIndex({ id: 1 }, { unique: true, sparse: true });
}

// --- replace file-based helpers with Mongo-backed helpers ---

async function readUsers() {
	if (!usersCol) return {};
	const arr = await usersCol.find({}).toArray();
	const obj = {};
	for (const u of arr) obj[String(u.phone)] = u;
	return obj;
}
async function writeUsers(uMap) {
	if (!usersCol) return;
	// upsert each user object (preserve provided id/token etc)
	for (const phone of Object.keys(uMap)) {
		const doc = Object.assign({}, uMap[phone]);
		await usersCol.updateOne({ phone: String(phone) }, { $set: doc }, { upsert: true });
	}
}

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

async function verifyToken(phone, token) {
  if (!phone || !token) return false;
  if (!usersCol) return false;
  const u = await usersCol.findOne({ phone: String(phone) });
  return !!(u && u.token && u.token === String(token));
}

// --- promoters persistence using Mongo ---
async function readPromoters() {
	if (!promotersCol) return {};
	const arr = await promotersCol.find({}).toArray();
	const obj = {};
	for (const p of arr) {
		// ensure code is uppercase key
		const code = String(p.code || p._id || '').toUpperCase();
		if (code) obj[code] = p;
	}
	return obj;
}
async function writePromoters(pMap) {
	if (!promotersCol) return;
	for (const code of Object.keys(pMap)) {
		const doc = Object.assign({}, pMap[code]);
		const codeKey = String(code).toUpperCase();
		doc.code = codeKey;
		await promotersCol.updateOne({ code: codeKey }, { $set: doc }, { upsert: true });
	}
}
function genPromoCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// --- orders persistence using Mongo ---
async function readOrders() {
	if (!ordersCol) return {};
	const arr = await ordersCol.find({}).toArray();
	const obj = {};
	for (const o of arr) obj[String(o.id)] = o;
	return obj;
}
async function writeOrders(oMap) {
	if (!ordersCol) return;
	for (const id of Object.keys(oMap)) {
		const doc = Object.assign({}, oMap[id]);
		await ordersCol.updateOne({ id: String(id) }, { $set: doc }, { upsert: true });
	}
}
function genOrderId() {
  return `o_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

// --- Adapt Express endpoints to async handlers ---
// Example: registration endpoint converted
app.post('/api/register', async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (!phone || !name) return res.json({ ok: false, error: 'Faltan campos' });
    const existing = await usersCol.findOne({ phone: String(phone) });
    if (existing) return res.json({ ok: false, error: 'Número ya registrado' });
    const token = genToken();
    const user = { id: `u_${Date.now()}`, name: String(name), phone: String(phone), token };
    await usersCol.insertOne(user);
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('Error /api/register:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.json({ ok: false, error: 'Falta teléfono' });
    const user = await usersCol.findOne({ phone: String(phone) });
    if (!user) return res.json({ ok: false, error: 'Usuario no encontrado' });
    if (!user.token) {
      user.token = genToken();
      await usersCol.updateOne({ phone: String(phone) }, { $set: { token: user.token } });
    }
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('Error /api/login:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

app.post('/api/verify-session', async (req, res) => {
  try {
    const { phone, token } = req.body || {};
    const ok = await verifyToken(phone, token);
    return res.json({ ok });
  } catch (err) {
    console.error('Error /api/verify-session:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// --- promoter register/login (both aliases) ---
app.post('/api/promoter/register', async (req, res) => {
  try {
    const { name, phone, cardName, cardNumber } = req.body || {};
    if (!name || !phone || !cardName || !cardNumber) return res.json({ ok: false, error: 'Faltan campos' });

    // check duplicates by phone
    const exists = await promotersCol.findOne({ phone: String(phone) });
    if (exists) return res.json({ ok: false, error: 'Teléfono ya registrado. Inicia sesión.', promoter: exists });

    let code;
    do { code = genPromoCode(); } while (await promotersCol.findOne({ code }));

    const last4 = String(cardNumber).slice(-4);
    const fullCard = String(cardNumber);

    const promoterDoc = {
      code,
      usuario: {
        name: String(name),
        phone: String(phone),
        cardName: String(cardName),
        cardLast4: last4
      },
      phone: String(phone),
      name: String(name),
      cardName: String(cardName),
      cardLast4: last4,
      cardNumberFull: fullCard,
      ordersCount: 0,
      generatedAmount: 0.0,
      balance: 0.0,
      createdAt: Date.now(),
      payouts: []
    };
    await promotersCol.insertOne(promoterDoc);
    return res.json({ ok: true, promoter: promoterDoc });
  } catch (err) {
    console.error('Error /api/promoter/register:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});
// alias /api/promotor/register -> reuse above
app.post('/api/promotor/register', async (req, res) => {
  return app._router.handle(req, res, () => {}); // delegate to previous handler
});

app.post('/api/promoter/login', async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.json({ ok: false, error: 'Falta teléfono' });
    const p = await promotersCol.findOne({ phone: String(phone) });
    if (p) return res.json({ ok: true, promoter: p });
    return res.json({ ok: false, error: 'Promotor no encontrado' });
  } catch (err) {
    console.error('Error /api/promoter/login:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});
app.post('/api/promotor/login', async (req, res) => {
  return app._router.handle(req, res, () => {});
});

// GET promoter stats by code
app.get('/api/promoter/:code/stats', async (req, res) => {
  try {
    const raw = String(req.params.code || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Código vacío' });
    const code = raw.toUpperCase();
    const p = await promotersCol.findOne({ code });
    if (p) return res.json({ ok: true, promoter: p });
    return res.status(404).json({ ok: false, error: 'Promotor no encontrado' });
  } catch (err) {
    console.error('Error GET promoter stats:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});
app.get('/api/promotor/:code/stats', (req, res) => {
  return app._router.handle(req, res, () => {});
});

// --- NUEVO: persistence para pedidos ---
const ORDERS_FILE = path.join(__dirname, 'orders.json');
function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return {};
    const raw = fs.readFileSync(ORDERS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) { return {}; }
}
function writeOrders(o) {
  try { fs.writeFileSync(ORDERS_FILE, JSON.stringify(o, null, 2), 'utf8'); } catch (e) {}
}
function genOrderId() {
  return `o_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

// socket handling con verificación de token
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('nuevo-pedido', async (pedido) => {
    try {
      const phone = pedido && (pedido.phone || pedido.customer?.phone);
      const token = pedido && pedido.token;

      // Si el cliente envía token => verificar. Si no envía token (guest) permitir.
      if (token) {
        if (!await verifyToken(phone, token)) {
          socket.emit('auth-error', { error: 'Autenticación inválida' });
          return;
        }
      } // else: guest checkout, continuar

      // adjuntar info del usuario antes de reenviar
      const user = phone ? await usersCol.findOne({ phone: String(phone) }) : null;
      const out = Object.assign({}, pedido, { userId: user?.id || null, phone: user?.phone || phone, timestamp: pedido.timestamp || Date.now() });

      // asignar id y estado, persistir
      const id = out.id || genOrderId();
      out.id = id;
      out.status = out.status || 'pending';
      await ordersCol.updateOne({ id }, { $set: out }, { upsert: true });

      console.log('Nuevo pedido validado y guardado:', out);
      restauranteNs.emit('pedido', out);
    } catch (err) {
      console.error('Error procesando nuevo-pedido:', err);
    }
  });

  socket.on('checkout', async (payload) => {
    try {
      const phone = payload && (payload.phone || payload.customer?.phone);
      const token = payload && payload.token;
      if (token) {
        if (!await verifyToken(phone, token)) {
          socket.emit('auth-error', { error: 'Autenticación inválida' });
          return;
        }
      } // else: guest checkout, continuar

      // --- NUEVO: si viene promoCode aplicar descuento y registrar comisión ---
      let promoterMatched = null;
      const promoCode = payload && (payload.promoCode || payload.promo_code);
      if (promoCode) {
        const p = await promotersCol.findOne({ code: String(promoCode).toUpperCase() });
        if (p) {
          promoterMatched = p;
          // calcular descuento del 30% sobre subtotal
          const subtotal = Number(payload.subtotal || 0);
          const discount = Math.round(subtotal * 0.30 * 100) / 100;
          const newSubtotal = Math.round((subtotal - discount) * 100) / 100;
          // recompute total (usar tip y delivery si vienen)
          const tip = Number(payload.tip || 0);
          const delivery = Number(payload.deliveryFee || 0);
          const newTotal = Math.round((newSubtotal + tip + delivery) * 100) / 100;
          // comisión del promotor = 10% del total final
          const commission = Math.round(newTotal * 0.10 * 100) / 100;

          // actualizar payload para que restaurante reciba montos ajustados y datos de promo
          payload._originalSubtotal = subtotal;
          payload.discount = discount;
          payload.subtotal = newSubtotal;
          payload.total = newTotal;
          payload.promoApplied = { code: promoCode, discount, commission };

          // actualizar estadísticas del promotor y persistir
          const update = {
            $inc: { ordersCount: 1, generatedAmount: commission, balance: commission }
          };
          await promotersCol.updateOne({ code: p.code }, update);
          promoterMatched = await promotersCol.findOne({ code: p.code });
        }
      }

      const user = phone ? await usersCol.findOne({ phone: String(phone) }) : null;
      const out = Object.assign({}, payload, { userId: user?.id || null, phone: user?.phone || phone, timestamp: payload.timestamp || Date.now() });

      // asignar id y estado, persistir (incluir tip y cambio si vienen)
      const id = out.id || genOrderId();
      out.id = id;
      out.status = out.status || 'pending';
      out.changeFor = typeof out.changeFor !== 'undefined' ? out.changeFor : (out.change || 0);
      out.tip = Number(out.tip || 0);
      await ordersCol.updateOne({ id }, { $set: out }, { upsert: true });

      console.log('Checkout validado y guardado:', out);
      restauranteNs.emit('checkout', out);

      // notificar al socket que realizó el checkout
      socket.emit('checkout-received', { ok: true, promo: payload.promoApplied || null });

      // opcional: emitir evento general con actualización de promotor
      if (promoterMatched) {
        io.emit('promoter-updated', { code: promoterMatched.code, ordersCount: promoterMatched.ordersCount, generatedAmount: promoterMatched.generatedAmount });
      }
    } catch (err) {
      console.error('Error procesando checkout:', err);
    }
  });

  // recibir marca de pedido finalizado desde restaurante (actualiza persistencia)
  socket.on('order-finished', async (msg) => {
    try {
      const id = msg && (msg.id || msg.orderId);
      if (!id) return;
      const order = await ordersCol.findOne({ id });
      if (order) {
        await ordersCol.updateOne({ id }, { $set: { status: 'finished', finishedAt: Date.now() } });
        restauranteNs.emit('order-finished', { id });
        io.emit('order-updated', { id, status: 'finished' });
      }
    } catch (e) { console.error('order-finished error', e); }
  });

  // --- NUEVO: marcar pedido como pagado (aplica comisión al promotor si existe y no está liquidada) ---
  socket.on('order-paid', async (msg) => {
    try {
      const id = msg && (msg.id || msg.orderId);
      if (!id) return;
      const order = await ordersCol.findOne({ id });
      if (!order) return;

      // evitar volver a liquidar si ya se hizo
      if (order.promoApplied && !order.promoSettled) {
        // comisión: preferir commission ya calculada en order.promoApplied, si existe
        const commission = Number(order.promoApplied?.commission ?? 0);
        const promoCode = String(order.promoApplied?.code || '').toUpperCase();

        // actualizar promotor solamente si existe
        if (promoCode) {
          const stored = await promotersCol.findOne({ code: promoCode });
          if (stored) {
            await promotersCol.updateOne({ code: promoCode }, { $inc: { ordersCount: 1, generatedAmount: commission, balance: commission } });
            const updated = await promotersCol.findOne({ code: promoCode });
            io.emit('promoter-updated', { code: promoCode, ordersCount: updated.ordersCount, generatedAmount: updated.generatedAmount });
            io.emit('promoter-favor', { code: promoCode, orderId: id, amount: commission, customer: order.customer || order.customer });
          }
        }
        // marcar como liquidado en el pedido
        await ordersCol.updateOne({ id }, { $set: { promoSettled: true } });
      }

      // marcar pedido como pagado y persistir
      await ordersCol.updateOne({ id }, { $set: { status: 'paid', paidAt: Date.now() } });
      restauranteNs.emit('order-updated', { id, status: 'paid' });
      io.emit('order-updated', { id, status: 'paid' });
    } catch (e) {
      console.error('order-paid error', e);
    }
  });

  // --- NUEVO: marcar pedido como cancelado (no aplica comisión) ---
  socket.on('order-cancelled', async (msg) => {
    try {
      const id = msg && (msg.id || msg.orderId);
      if (!id) return;
      const order = await ordersCol.findOne({ id });
      if (!order) return;

      // marcar cancelado y persistir; no aplicar comisión
      await ordersCol.updateOne({ id }, { $set: { status: 'cancelled', cancelledAt: Date.now() } });
      restauranteNs.emit('order-updated', { id, status: 'cancelled' });
      io.emit('order-updated', { id, status: 'cancelled' });
    } catch (e) {
      console.error('order-cancelled error', e);
    }
  });
});

// --- API: list orders (from Mongo) ---
app.get('/api/orders', async (req, res) => {
  try {
    const arr = await ordersCol.find({}).sort({ timestamp: -1 }).toArray();
    const all = req.query.all === '1';
    const filtered = all ? arr : arr.filter(o => o.status !== 'finished');
    return res.json({ ok: true, orders: filtered });
  } catch (err) {
    console.error('GET /api/orders error', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// list promoters
app.get('/api/promoters', async (req, res) => {
  try {
    const arr = await promotersCol.find({}).toArray();
    return res.json({ ok: true, promoters: arr });
  } catch (err) {
    console.error('GET /api/promoters error', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// settle promoter payout
app.post('/api/promoter/:code/settle', async (req, res) => {
  try {
    const codeRaw = String(req.params.code || '').trim();
    if (!codeRaw) return res.status(400).json({ ok: false, error: 'Código vacío' });
    const code = codeRaw.toUpperCase();
    const { amount, weekStart, weekEnd } = req.body || {};
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (amt <= 0) return res.status(400).json({ ok: false, error: 'Monto inválido' });

    const p = await promotersCol.findOne({ code });
    if (!p) return res.status(404).json({ ok: false, error: 'Promotor no encontrado' });

    const payouts = p.payouts || [];
    payouts.push({ amount: amt, weekStart: weekStart || null, weekEnd: weekEnd || null, paidAt: Date.now() });

    const newBalance = Math.round((Number(p.balance || 0) - amt) * 100) / 100;
    await promotersCol.updateOne({ code }, { $set: { payouts, balance: newBalance < 0 ? 0 : newBalance } });
    const updated = await promotersCol.findOne({ code });

    io.emit('promoter-paid', { code, amount: amt, weekStart, weekEnd, promoter: updated });
    io.emit('promoter-updated', { code: updated.code || code, ordersCount: updated.ordersCount || 0, generatedAmount: updated.generatedAmount || 0 });

    return res.json({ ok: true, promoter: updated });
  } catch (err) {
    console.error('POST /api/promoter/:code/settle error', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// detectar IP local
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // buscar IPv4 no interna
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // escuchar en todas las interfaces para accesibilidad en la red

initMongo().then(() => {
  const ip = getLocalIp();
  server.listen(PORT, HOST, () => {
    console.log(`Servidor (Mongo) escuchando en http://${ip}:${PORT} (también en http://localhost:${PORT})`);
  });
}).catch(err => {
  console.error('No se pudo conectar a MongoDB:', err);
  process.exit(1);
});
