const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// permitir JSON bodies
app.use(express.json());

// servir public en la raíz (ej. /style.css, /main.js, /sushi1.jpg)
app.use(express.static(path.join(__dirname, 'public')));

// rutas para promotor y restaurante (servir desde public para despliegue en Render)
app.get('/promotor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'promotor.html')));
app.get('/restaurante', (req, res) => res.sendFile(path.join(__dirname, 'public', 'restaurante.html')));

// namespace para restaurante
const restauranteNs = io.of('/restaurante');

// simple persistence de usuarios en users.json
const USERS_FILE = path.join(__dirname, 'users.json');
function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) { return {}; }
}
function writeUsers(u) {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), 'utf8'); } catch (e) {}
}

// generar token seguro
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function verifyToken(phone, token) {
  if (!phone || !token) return false;
  const users = readUsers();
  const u = users[String(phone)];
  return !!(u && u.token && u.token === String(token));
}

// API: registro (genera token)
app.post('/api/register', (req, res) => {
  const { name, phone } = req.body || {};
  if (!phone || !name) return res.json({ ok: false, error: 'Faltan campos' });
  const users = readUsers();
  if (users[phone]) return res.json({ ok: false, error: 'Número ya registrado' });
  const token = genToken();
  const user = { id: `u_${Date.now()}`, name: String(name), phone: String(phone), token };
  users[phone] = user;
  writeUsers(users);
  return res.json({ ok: true, user });
});
// API: login (por teléfono) - devuelve token existente o crea uno si falta
app.post('/api/login', (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.json({ ok: false, error: 'Falta teléfono' });
  const users = readUsers();
  if (!users[phone]) return res.json({ ok: false, error: 'Usuario no encontrado' });
  if (!users[phone].token) {
    users[phone].token = genToken();
    writeUsers(users);
  }
  return res.json({ ok: true, user: users[phone] });
});

// endpoint de verificación opcional
app.post('/api/verify-session', (req, res) => {
  const { phone, token } = req.body || {};
  if (verifyToken(phone, token)) return res.json({ ok: true });
  return res.json({ ok: false });
});

// --- NUEVO: simple persistence para promotores ---
const PROMOTERS_FILE = path.join(__dirname, 'promoters.json');
function readPromoters() {
  try {
    if (!fs.existsSync(PROMOTERS_FILE)) return {};
    const raw = fs.readFileSync(PROMOTERS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) { return {}; }
}
function writePromoters(p) {
  try { fs.writeFileSync(PROMOTERS_FILE, JSON.stringify(p, null, 2), 'utf8'); } catch (e) {}
}
function genPromoCode() {
  // 6 chars alfanum mayúsculas
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// API: registrar promotor (genera promoCode y guarda datos no sensibles)
app.post('/api/promoter/register', (req, res) => {
  try {
    const { name, phone, cardName, cardNumber } = req.body || {};
    if (!name || !phone || !cardName || !cardNumber) return res.json({ ok: false, error: 'Faltan campos' });

    const promoters = readPromoters();

    // NO permitir duplicados por teléfono
    for (const code of Object.keys(promoters)) {
      const p = promoters[code];
      if (p && String(p.phone) === String(phone)) {
        return res.json({ ok: false, error: 'Teléfono ya registrado. Inicia sesión.', promoter: p });
      }
    }

    // generar código único (asegurar no colisión)
    let code;
    do { code = genPromoCode(); } while (promoters[code]);

    // almacenar solo últimos 4 dígitos de la tarjeta por seguridad
    const last4 = String(cardNumber).slice(-4);

    // almacenar número completo (local dev). Si prefieres no guardar el número completo,
    // cambia esto para almacenar solo el último 4 o encriptarlo.
    const fullCard = String(cardNumber);

    // Guardar el usuario junto con el código en el objeto
    promoters[code] = {
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
      createdAt: Date.now()
    };
    writePromoters(promoters);
    return res.json({ ok: true, promoter: promoters[code] });
  } catch (err) {
    console.error('Error register promoter:', err);
    return res.json({ ok: false, error: 'Error interno' });
  }
});
// --- ALIAS: permitir "promotor" (misma lógica) ---
app.post('/api/promotor/register', (req, res) => {
  try {
    const { name, phone, cardName, cardNumber } = req.body || {};
    if (!name || !phone || !cardName || !cardNumber) return res.json({ ok: false, error: 'Faltan campos' });

    const promoters = readPromoters();
    for (const code of Object.keys(promoters)) {
      const p = promoters[code];
      if (p && String(p.phone) === String(phone)) {
        return res.json({ ok: false, error: 'Teléfono ya registrado. Inicia sesión.', promoter: p });
      }
    }
    let code;
    do { code = genPromoCode(); } while (promoters[code]);
    const last4 = String(cardNumber).slice(-4);
    const fullCard = String(cardNumber);
    promoters[code] = {
      code,
      name: String(name),
      phone: String(phone),
      cardName: String(cardName),
      cardLast4: last4,
      cardNumberFull: fullCard,
      ordersCount: 0,
      generatedAmount: 0.0,
      balance: 0.0,
      createdAt: Date.now()
    };
    writePromoters(promoters);
    return res.json({ ok: true, promoter: promoters[code] });
  } catch (err) {
    console.error('Error register promotor alias:', err);
    return res.json({ ok: false, error: 'Error interno' });
  }
});

// --- NUEVO: login de promotor por teléfono (devuelve promotor si existe)
app.post('/api/promoter/login', (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.json({ ok: false, error: 'Falta teléfono' });
    const promoters = readPromoters();
    for (const code of Object.keys(promoters)) {
      const p = promoters[code];
      if (p && String(p.phone) === String(phone)) {
        // Devolver el objeto completo, incluyendo el código y usuario
        return res.json({ ok: true, promoter: p });
      }
    }
    return res.json({ ok: false, error: 'Promotor no encontrado' });
  } catch (err) {
    console.error('Error promoter login:', err);
    return res.json({ ok: false, error: 'Error interno' });
  }
});
// --- ALIAS: aceptar también /api/promotor/login ---
app.post('/api/promotor/login', (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.json({ ok: false, error: 'Falta teléfono' });
    const promoters = readPromoters();
    for (const code of Object.keys(promoters)) {
      const p = promoters[code];
      if (p && String(p.phone) === String(phone)) {
        return res.json({ ok: true, promoter: p });
      }
    }
    return res.json({ ok: false, error: 'Promotor no encontrado' });
  } catch (err) {
    console.error('Error promotor alias login:', err);
    return res.json({ ok: false, error: 'Error interno' });
  }
});

// --- NEW: obtener estadísticas de un promotor por código (GET) ---
app.get('/api/promoter/:code/stats', (req, res) => {
  try {
    const raw = String(req.params.code || '').trim();
    if (!raw) return res.status(400).json({ ok: false, error: 'Código vacío' });
    const code = raw.toUpperCase();
    const promoters = readPromoters();
    const p = promoters[code] || null;
    if (p) return res.json({ ok: true, promoter: p });
    return res.status(404).json({ ok: false, error: 'Promotor no encontrado' });
  } catch (err) {
    console.error('Error GET promoter stats:', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});
// alias con ortografía alternativa 'promotor'
app.get('/api/promotor/:code/stats', (req, res) => {
  // reutilizar la ruta anterior
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

  socket.on('nuevo-pedido', (pedido) => {
    try {
      const phone = pedido && (pedido.phone || pedido.customer?.phone);
      const token = pedido && pedido.token;

      // Si el cliente envía token => verificar. Si no envía token (guest) permitir.
      if (token) {
        if (!verifyToken(phone, token)) {
          socket.emit('auth-error', { error: 'Autenticación inválida' });
          return;
        }
      } // else: guest checkout, continuar

      // adjuntar info del usuario antes de reenviar
      const users = readUsers();
      const user = users[String(phone)];
      const out = Object.assign({}, pedido, { userId: user?.id || null, phone: user?.phone || phone, timestamp: pedido.timestamp || Date.now() });

      // asignar id y estado, persistir
      const ordersObj = readOrders();
      const id = out.id || genOrderId();
      out.id = id;
      out.status = out.status || 'pending';
      ordersObj[id] = out;
      writeOrders(ordersObj);

      console.log('Nuevo pedido validado y guardado:', out);
      restauranteNs.emit('pedido', out);
    } catch (err) {
      console.error('Error procesando nuevo-pedido:', err);
    }
  });

  socket.on('checkout', (payload) => {
    try {
      const phone = payload && (payload.phone || payload.customer?.phone);
      const token = payload && payload.token;

      // Si el cliente envía token => verificar. Si no envía token (guest) permitir.
      if (token) {
        if (!verifyToken(phone, token)) {
          socket.emit('auth-error', { error: 'Autenticación inválida' });
          return;
        }
      } // else: guest checkout, continuar

      // --- NUEVO: si viene promoCode aplicar descuento y registrar comisión ---
      const promoCode = payload && (payload.promoCode || payload.promo_code);
      let promoterMatched = null;
      if (promoCode) {
        const promoters = readPromoters();
        const p = promoters[String(promoCode).toUpperCase()];
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
          const promotersObj = readPromoters();
          const stored = promotersObj[String(promoCode).toUpperCase()];
          if (stored) {
            stored.ordersCount = (stored.ordersCount || 0) + 1;
            stored.generatedAmount = Math.round((Number(stored.generatedAmount || 0) + commission) * 100) / 100;
            stored.balance = Math.round((Number(stored.balance || 0) + commission) * 100) / 100;
            promotersObj[String(promoCode).toUpperCase()] = stored;
            writePromoters(promotersObj);
            promoterMatched = stored;
          }
        }
      }

      const users = readUsers();
      const user = users[String(phone)];
      const out = Object.assign({}, payload, { userId: user?.id || null, phone: user?.phone || phone, timestamp: payload.timestamp || Date.now() });

      // asignar id y estado, persistir (incluir tip y cambio si vienen)
      const ordersObj = readOrders();
      const id = out.id || genOrderId();
      out.id = id;
      out.status = out.status || 'pending';
      // ensure changeFor field preserved (may be named changeFor or change)
      out.changeFor = typeof out.changeFor !== 'undefined' ? out.changeFor : (out.change || 0);
      out.tip = Number(out.tip || 0);
      ordersObj[id] = out;
      writeOrders(ordersObj);

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
  socket.on('order-finished', (msg) => {
    try {
      const id = msg && (msg.id || msg.orderId);
      if (!id) return;
      const ordersObj = readOrders();
      if (ordersObj[id]) {
        ordersObj[id].status = 'finished';
        ordersObj[id].finishedAt = Date.now();
        writeOrders(ordersObj);
        // notificar a namespace/restaurante y clientes conectados
        restauranteNs.emit('order-finished', { id });
        io.emit('order-updated', { id, status: 'finished' });
      }
    } catch (e) { console.error('order-finished error', e); }
  });

  // --- NUEVO: marcar pedido como pagado (aplica comisión al promotor si existe y no está liquidada) ---
  socket.on('order-paid', (msg) => {
    try {
      const id = msg && (msg.id || msg.orderId);
      if (!id) return;
      const ordersObj = readOrders();
      const order = ordersObj[id];
      if (!order) return;

      // evitar volver a liquidar si ya se hizo
      if (order.promoApplied && !order.promoSettled) {
        // comisión: preferir commission ya calculada en order.promoApplied, si existe
        const commission = Number(order.promoApplied?.commission ?? 0);
        const promoCode = String(order.promoApplied?.code || '').toUpperCase();

        // actualizar promotor solamente si existe
        if (promoCode) {
          const promotersObj = readPromoters();
          const stored = promotersObj[promoCode];
          if (stored) {
            stored.ordersCount = (stored.ordersCount || 0) + 1;
            stored.generatedAmount = Math.round((Number(stored.generatedAmount || 0) + commission) * 100) / 100;
            stored.balance = Math.round((Number(stored.balance || 0) + commission) * 100) / 100;
            promotersObj[promoCode] = stored;
            writePromoters(promotersObj);
            // notificar a promotores y clientes
            io.emit('promoter-updated', { code: promoCode, ordersCount: stored.ordersCount, generatedAmount: stored.generatedAmount });
            io.emit('promoter-favor', { code: promoCode, orderId: id, amount: commission, customer: order.customer || order.customer });
          }
        }
        // marcar como liquidado en el pedido
        order.promoSettled = true;
      }

      // marcar pedido como pagado y persistir
      order.status = 'paid';
      order.paidAt = Date.now();
      ordersObj[id] = order;
      writeOrders(ordersObj);

      // notificar UI restaurante y demás clientes
      restauranteNs.emit('order-updated', { id, status: 'paid' });
      io.emit('order-updated', { id, status: 'paid' });
    } catch (e) {
      console.error('order-paid error', e);
    }
  });

  // --- NUEVO: marcar pedido como cancelado (no aplica comisión) ---
  socket.on('order-cancelled', (msg) => {
    try {
      const id = msg && (msg.id || msg.orderId);
      if (!id) return;
      const ordersObj = readOrders();
      const order = ordersObj[id];
      if (!order) return;

      // marcar cancelado y persistir; no aplicar comisión
      order.status = 'cancelled';
      order.cancelledAt = Date.now();
      ordersObj[id] = order;
      writeOrders(ordersObj);

      // notificar UI restaurante y promotores (si es necesario)
      restauranteNs.emit('order-updated', { id, status: 'cancelled' });
      io.emit('order-updated', { id, status: 'cancelled' });
    } catch (e) {
      console.error('order-cancelled error', e);
    }
  });
});

// --- NUEVO: endpoint para obtener pedidos persistidos ---
app.get('/api/orders', (req, res) => {
  try {
    const ordersObj = readOrders();
    // devolver array ordenado por timestamp descendente
    const arr = Object.keys(ordersObj).map(k => ordersObj[k]).sort((a,b)=> (b.timestamp||0) - (a.timestamp||0));
    // por defecto devolver sólo pendientes (no finished), permitir ?all=1 para todos
    const all = req.query.all === '1';
    const filtered = all ? arr : arr.filter(o => o.status !== 'finished');
    return res.json({ ok: true, orders: filtered });
  } catch (err) {
    console.error('GET /api/orders error', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ---------- NUEVO: listar todos los promotores ----------
app.get('/api/promoters', (req, res) => {
  try {
    const promoters = readPromoters();
    const arr = Object.keys(promoters).map(k => promoters[k]);
    return res.json({ ok: true, promoters: arr });
  } catch (err) {
    console.error('GET /api/promoters error', err);
    return res.status(500).json({ ok: false, error: 'Error interno' });
  }
});

// ---------- NUEVO: registrar pago semanal para un promotor ----------
app.post('/api/promoter/:code/settle', (req, res) => {
  try {
    const codeRaw = String(req.params.code || '').trim();
    if (!codeRaw) return res.status(400).json({ ok: false, error: 'Código vacío' });
    const code = codeRaw.toUpperCase();
    const { amount, weekStart, weekEnd } = req.body || {};
    const amt = Math.round((Number(amount) || 0) * 100) / 100;
    if (amt <= 0) return res.status(400).json({ ok: false, error: 'Monto inválido' });

    const promoters = readPromoters();
    const p = promoters[code];
    if (!p) return res.status(404).json({ ok: false, error: 'Promotor no encontrado' });

    // crear registro de payout
    p.payouts = p.payouts || [];
    p.payouts.push({
      amount: amt,
      weekStart: weekStart || null,
      weekEnd: weekEnd || null,
      paidAt: Date.now()
    });

    // disminuir balance (no permitir balance negativo por aquí, pero registramos la operación)
    p.balance = Math.round((Number(p.balance || 0) - amt) * 100) / 100;
    if (p.balance < 0) p.balance = 0;

    promoters[code] = p;
    writePromoters(promoters);

    // notificar a clientes/promotores conectados
    io.emit('promoter-paid', { code, amount: amt, weekStart, weekEnd, promoter: p });
    io.emit('promoter-updated', { code: p.code || code, ordersCount: p.ordersCount || 0, generatedAmount: p.generatedAmount || 0 });

    return res.json({ ok: true, promoter: p });
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

server.listen(PORT, HOST, () => {
  const ip = getLocalIp();
  console.log(`Servidor escuchando en http://${ip}:${PORT} (también en http://localhost:${PORT})`);
});
