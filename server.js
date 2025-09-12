const path = require('path');
const http = require('http');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { Server } = require('socket.io');
const fs = require('fs');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);

// Config
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://daniel:daniel25@so.k6u9iol.mongodb.net/?retryWrites=true&w=majority&appName=so&authSource=admin';
const RENDER_URL = process.env.RENDER_URL || 'https://dimeloweb.onrender.com';

// VAPID keys: se usan las claves proporcionadas directamente (no variables de entorno)
const VAPID_PUBLIC = "BAVq02xbmcJl5m9IDyYJoewdka1rPwnInvkrAqrrcg6fgjRvjJGwmNUPmGAeOX0FQ0Kc_3H-sXEnQdw5LFrbWbk";
const VAPID_PRIVATE = "lsumd58Q-P1OiKgSmZzpsVUUW7YRozGHRNeCe_Ua024";

try {
	webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC, VAPID_PRIVATE);
	console.log('web-push VAPID configuradas con claves embebidas.');
} catch (e) {
	console.warn('Error configurando VAPID en web-push', e);
}

// Collection para push subscriptions
let pushSubscriptionsCollection = null;

// Middlewares
app.use(express.json());
// --- Añadir CORS headers para permitir requests desde file:// o cualquier origen ---
app.use((req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
	if (req.method === 'OPTIONS') return res.sendStatus(200);
	next();
});
// Servir carpeta uploads (fotos)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

app.use(express.static(path.join(__dirname))); // sirve index.html y archivos estáticos

// MongoDB connection
let db, transactions, walletCollection, users, scheduledPayments;
MongoClient.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
	.then(async client => {
		console.log('MongoDB conectado');
		db = client.db(); // usa la db por defecto del URI
		transactions = db.collection('transactions');
		walletCollection = db.collection('wallets');
		users = db.collection('users');
		scheduledPayments = db.collection('scheduledPayments');
		pushSubscriptionsCollection = db.collection('pushSubscriptions');

		// Inicializar documento único de wallet si no existe
		await walletCollection.updateOne(
			{ _id: 'singleton' },
			{ $setOnInsert: { balance: 0, weeklySalary: 0 } },
			{ upsert: true }
		);

		// Índices
		await users.createIndex({ username: 1 }, { unique: true }).catch(()=>{});
		await scheduledPayments.createIndex({ nextDue: 1 });
		await pushSubscriptionsCollection.createIndex({ endpoint: 1 }, { unique: true }).catch(()=>{});
	})
	.catch(err => console.error('MongoDB error', err));

// API
app.get('/api/transactions', async (req, res) => {
	try {
		const txs = await transactions.find().sort({ createdAt: -1 }).toArray();
		// convertir _id a string para el cliente
		const mapped = txs.map(t => ({ ...t, _id: t._id ? t._id.toString() : t._id }));
		res.json(mapped);
	} catch (err) {
		res.status(500).json({ error: 'Error al obtener transacciones' });
	}
});

// NUEVO: registrar usuario
app.post('/api/users/register', async (req, res) => {
	try {
		const { username } = req.body;
		if (!username || !username.trim()) return res.status(400).json({ error: 'username requerido' });
		const user = { username: username.trim(), createdAt: new Date(), photoUrl: null };
		const result = await users.insertOne(user);
		// Asegurar que _id se envía como string
		user._id = result.insertedId.toString();
		io.emit('user:registered', user);
		res.status(201).json(user);
	} catch (err) {
		if (err && err.code === 11000) return res.status(409).json({ error: 'username ya existe' });
		res.status(500).json({ error: 'Error al registrar usuario' });
	}
});

// NUEVO: listar usuarios
app.get('/api/users', async (req, res) => {
	try {
		const list = await users.find().sort({ createdAt: 1 }).toArray();
		// Convertir _id a string para el cliente y garantizar photoUrl existe
		const mapped = list.map(u => ({ ...u, _id: u._id ? u._id.toString() : u._id, photoUrl: u.photoUrl || null }));
		res.json(mapped);
	} catch (err) {
		res.status(500).json({ error: 'Error al obtener usuarios' });
	}
});

// NUEVO: subir foto de perfil (dataUrl en JSON)
app.post('/api/users/:id/photo', async (req, res) => {
	try {
		const { id } = req.params;
		const { dataUrl } = req.body;
		if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'dataUrl requerido' });

		// parse dataUrl: data:[<mediatype>][;base64],<data>
		const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
		if (!match) return res.status(400).json({ error: 'dataUrl no válido' });

		const mime = match[1]; // e.g. image/png
		const ext = mime.split('/')[1] || 'png';
		const b64 = match[2];
		const buf = Buffer.from(b64, 'base64');

		const filename = `user-${id}-${Date.now()}.${ext}`;
		const filepath = path.join(uploadsDir, filename);
		fs.writeFileSync(filepath, buf);

		const photoPath = `/uploads/${filename}`;

		// actualizar usuario
		await users.updateOne({ _id: new ObjectId(id) }, { $set: { photoUrl: photoPath } });
		const updated = await users.findOne({ _id: new ObjectId(id) });
		const out = { ...updated, _id: updated._id.toString(), photoUrl: updated.photoUrl || null };
		// emitir evento para clientes conectados
		io.emit('user:registered', out);
		res.json(out);
	} catch (err) {
		console.error('upload photo error', err);
		res.status(500).json({ error: 'Error al subir foto' });
	}
});

// modificar creación de transacción para incluir usuario
app.post('/api/transactions', async (req, res) => {
	try {
		const { description, amount, type, category, userId, username } = req.body;
		if (!description || !amount || !type) return res.status(400).json({ error: 'Datos incompletos' });
		const tx = {
			description,
			amount,
			type,
			category: category || 'General',
			createdAt: new Date(),
			userId: userId || null,
			username: username || null
		};
		const result = await transactions.insertOne(tx);
		tx._id = result.insertedId.toString();
		io.emit('transaction:created', tx);
		res.status(201).json(tx);
	} catch (err) {
		res.status(500).json({ error: 'Error al crear transacción' });
	}
});

app.delete('/api/transactions/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const result = await transactions.deleteOne({ _id: new ObjectId(id) });
		if (result.deletedCount === 0) return res.status(404).json({ error: 'No encontrado' });
		io.emit('transaction:deleted', { id });
		res.json({ id });
	} catch (err) {
		res.status(500).json({ error: 'Error al borrar transacción' });
	}
});

app.delete('/api/transactions', async (req, res) => {
	try {
		await transactions.deleteMany({});
		io.emit('transactions:cleared');
		res.json({ cleared: true });
	} catch (err) {
		res.status(500).json({ error: 'Error al borrar todas las transacciones' });
	}
});

// Nuevas rutas para billetera y sueldo semanal
app.get('/api/wallet', async (req, res) => {
	try {
		const w = await walletCollection.findOne({ _id: 'singleton' });
		res.json({ balance: (w && w.balance) || 0, weeklySalary: (w && w.weeklySalary) || 0 });
	} catch (err) {
		res.status(500).json({ error: 'Error al obtener la billetera' });
	}
});

app.post('/api/wallet/salary', async (req, res) => {
	try {
		const { weeklySalary } = req.body;
		if (weeklySalary == null) return res.status(400).json({ error: 'weeklySalary requerido' });

		await walletCollection.updateOne(
			{ _id: 'singleton' },
			{ $set: { weeklySalary: Number(weeklySalary) } },
			{ upsert: true }
		);

		const w = await walletCollection.findOne({ _id: 'singleton' });
		io.emit('wallet:updated', { balance: w.balance, weeklySalary: w.weeklySalary });
		res.json({ balance: w.balance, weeklySalary: w.weeklySalary });
	} catch (err) {
		res.status(500).json({ error: 'Error al configurar sueldo semanal' });
	}
});

app.post('/api/wallet/pay', async (req, res) => {
	try {
		const w = await walletCollection.findOne({ _id: 'singleton' });
		const salary = (w && w.weeklySalary) || 0;
		if (!salary || salary <= 0) return res.status(400).json({ error: 'Sueldo semanal no configurado o es 0' });

		const newBalance = (w.balance || 0) + salary;
		await walletCollection.updateOne({ _id: 'singleton' }, { $set: { balance: newBalance } });

		// Registrar como transacción de ingreso
		const tx = {
			description: 'Sueldo semanal',
			amount: Number(salary),
			type: 'income',
			category: 'Salary',
			createdAt: new Date()
		};
		const result = await transactions.insertOne(tx);
		tx._id = result.insertedId.toString();

		io.emit('wallet:updated', { balance: newBalance, weeklySalary: salary });
		io.emit('transaction:created', tx);

		res.json({ balance: newBalance, transaction: tx });
	} catch (err) {
		res.status(500).json({ error: 'Error al procesar pago de sueldo' });
	}
});

// NUEVO: listar pagos programados
app.get('/api/scheduled', async (req, res) => {
	try {
		const list = await scheduledPayments.find().sort({ nextDue: 1 }).toArray();
		const mapped = list.map(s => ({ ...s, _id: s._id ? s._id.toString() : s._id }));
		res.json(mapped);
	} catch (err) {
		res.status(500).json({ error: 'Error al obtener pagos programados' });
	}
});

// NUEVO: crear pago programado
app.post('/api/scheduled', async (req, res) => {
	try {
		const { description, amount, frequency, nextDue, endDate, category, userId, username, type } = req.body;
		if (!description || !amount || !frequency || !nextDue) return res.status(400).json({ error: 'Datos incompletos' });

		const doc = {
			description,
			amount: Number(amount),
			type: type || 'expense', // por defecto gasto
			frequency, // 'weekly' | 'monthly' | 'once'
			nextDue: new Date(nextDue),
			endDate: endDate ? new Date(endDate) : null,
			category: category || 'General',
			userId: userId || null,
			username: username || null,
			lastPaid: null,
			notifiedAt: null,
			active: true,
			createdAt: new Date()
		};
		const result = await scheduledPayments.insertOne(doc);
		doc._id = result.insertedId.toString();
		io.emit('scheduled:created', doc);
		res.status(201).json(doc);
	} catch (err) {
		res.status(500).json({ error: 'Error al crear pago programado' });
	}
});

// NUEVO: marcar pago programado como pagado
app.post('/api/scheduled/:id/pay', async (req, res) => {
	try {
		const { id } = req.params;
		const sched = await scheduledPayments.findOne({ _id: new ObjectId(id) });
		if (!sched) return res.status(404).json({ error: 'Programado no encontrado' });

		// crear transacción asociada
		const tx = {
			description: `${sched.description} (pago programado)`,
			amount: Number(sched.amount),
			type: sched.type || 'expense',
			category: sched.category || 'General',
			createdAt: new Date(),
			userId: sched.userId || null,
			username: sched.username || null
		};
		const r = await transactions.insertOne(tx);
		tx._id = r.insertedId.toString();

		// actualizar lastPaid y calcular nextDue según frecuencia
		const now = new Date();
		let next = sched.nextDue ? new Date(sched.nextDue) : now;
		// avanzar una unidad a partir de la fecha actual o nextDue
		if (sched.frequency === 'weekly') {
			next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
		} else if (sched.frequency === 'monthly') {
			next = new Date(next);
			next.setMonth(next.getMonth() + 1);
		} else {
			// once -> desactivar
			sched.active = false;
			next = null;
		}

		// si hay endDate y next > endDate -> desactivar
		if (sched.endDate && next && next > new Date(sched.endDate)) {
			sched.active = false;
			next = null;
		}

		const update = { $set: { lastPaid: now, nextDue: next, active: !!sched.active, notifiedAt: null } };
		await scheduledPayments.updateOne({ _id: new ObjectId(id) }, update);
		const updated = await scheduledPayments.findOne({ _id: new ObjectId(id) });
		// convertir _id a string en el objeto actualizado antes de emitir
		const updatedStr = { ...updated, _id: updated._id ? updated._id.toString() : updated._id };

		// emitir eventos
		io.emit('transaction:created', tx);
		io.emit('scheduled:paid', { scheduled: updatedStr, transaction: tx });

		res.json({ scheduled: updatedStr, transaction: tx });
	} catch (err) {
		res.status(500).json({ error: 'Error al procesar pago programado' });
	}
});

// NUEVO: eliminar pago programado
app.delete('/api/scheduled/:id', async (req, res) => {
	try {
		const { id } = req.params;
		const result = await scheduledPayments.deleteOne({ _id: new ObjectId(id) });
		if (result.deletedCount === 0) return res.status(404).json({ error: 'No encontrado' });
		io.emit('scheduled:deleted', { id });
		res.json({ id });
	} catch (err) {
		res.status(500).json({ error: 'Error al eliminar programado' });
	}
});

/* NUEVOS endpoints para Push */
// devolver VAPID public key (en base64)
app.get('/api/push/vapidPublicKey', (req, res) => {
	if (!VAPID_PUBLIC) return res.status(500).json({ error: 'VAPID key not configured' });
	res.json({ key: VAPID_PUBLIC });
});

// registrar suscripción push (body: { subscription, userId })
app.post('/api/push/subscribe', async (req, res) => {
	try {
		const { subscription, userId } = req.body;
		if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' });
		const doc = { endpoint: subscription.endpoint, subscription, userId: userId || null, createdAt: new Date() };
		// upsert por endpoint
		await pushSubscriptionsCollection.updateOne({ endpoint: doc.endpoint }, { $set: doc }, { upsert: true });
		res.json({ ok: true });
	} catch (err) {
		console.error('push subscribe error', err);
		res.status(500).json({ error: 'Error saving subscription' });
	}
});

// eliminar suscripción (body: { endpoint })
app.post('/api/push/unsubscribe', async (req, res) => {
	try {
		const { endpoint } = req.body;
		if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
		await pushSubscriptionsCollection.deleteOne({ endpoint });
		res.json({ ok: true });
	} catch (err) {
		console.error('push unsubscribe error', err);
		res.status(500).json({ error: 'Error removing subscription' });
	}
});

// Worker periódico para detectar vencimientos y emitir notificaciones
setInterval(async () => {
	try {
		if (!scheduledPayments) return;
		const now = new Date();
		// seleccionar activos con nextDue <= ahora y que no hayan sido notificados para ese nextDue
		const dueList = await scheduledPayments.find({ active: true, nextDue: { $lte: now } }).toArray();
		for (const s of dueList) {
			// evitar múltiples notificaciones si ya notificado recientemente para la misma nextDue
			if (s.notifiedAt && new Date(s.notifiedAt) >= new Date(s.nextDue)) continue;
			await scheduledPayments.updateOne({ _id: s._id }, { $set: { notifiedAt: new Date() } });
			io.emit('scheduled:due', s);

			// NUEVO: enviar push a suscripciones asociadas al usuario del programado (si existe)
			try {
				if (pushSubscriptionsCollection) {
					let subs = [];
					if (s.userId) {
						subs = await pushSubscriptionsCollection.find({ userId: String(s.userId) }).toArray();
					}
					// si no hay subs para el usuario, opcional: notificar a todas las subs (comentar/activar según necesidad)
					// if (subs.length === 0) subs = await pushSubscriptionsCollection.find().toArray();

					const payload = {
						title: 'Pago programado por vencer',
						body: `${s.description} — ${s.amount ? (Number(s.amount).toFixed(2) + ' EUR') : ''} vence hoy.`,
						url: '/', // puede ajustarse a una ruta que muestre pagos programados
						tag: `scheduled-${s._id ? s._id.toString() : Date.now()}`
					};

					for (const p of subs) {
						try {
							await webpush.sendNotification(p.subscription, JSON.stringify(payload));
						} catch (err) {
							// si la suscripción ya no es válida, eliminarla
							console.warn('webpush send error, removing subscription', err);
							try { await pushSubscriptionsCollection.deleteOne({ endpoint: p.endpoint }); } catch(e){/*ignore*/ }
						}
					}
				}
			} catch (err) {
				console.error('Error sending push notifications for scheduled due', err);
			}
		}
	} catch (err) {
		console.error('Error worker scheduled:', err);
	}
}, 60 * 1000); // cada minuto

// Socket.IO with explicit CORS origin (permitir el cliente alojado en Render)
// permitir cualquier origin para desarrollo local (puedes ajustar a RENDER_URL en producción)
const io = new Server(server, {
	cors: {
		origin: '*',
		methods: ['GET', 'POST']
	}
});

// Socket.IO logging
io.on('connection', socket => {
	console.log('socket conectado', socket.id);
	socket.on('disconnect', () => console.log('socket desconectado', socket.id));
});

// Start - escuchar en todas las interfaces (0.0.0.0) para entornos cloud
server.listen(PORT, '0.0.0.0', () => {
	console.log(`Servidor escuchando en puerto ${PORT}`);
	console.log(`Socket.IO origin permitido: ${RENDER_URL}`);
});
