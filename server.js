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
// permitir bodies grandes (dataURLs) para subir imágenes grandes
app.use(express.json({ limit: '50mb' }));
// --- Añadir CORS headers para permitir requests desde file:// o cualquier origen ---
app.use((req, res, next) => {
	const allowedOrigins = [
		'https://control-lovat.vercel.app',
		'https://dimeloweb.onrender.com',
		'http://localhost:3000',
		'http://127.0.0.1:3000'
	];
	const origin = req.headers.origin;
	if (allowedOrigins.includes(origin)) {
		res.header('Access-Control-Allow-Origin', origin);
	} else {
		res.header('Access-Control-Allow-Origin', '*');
	}
	res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
	// Si usas cookies, añade:
	// res.header('Access-Control-Allow-Credentials', 'true');
	if (req.method === 'OPTIONS') return res.sendStatus(200);
	next();
});
// Servir carpeta uploads (fotos)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

app.use(express.static(path.join(__dirname))); // sirve index.html y archivos estáticos

// MongoDB connection
let db, transactions, walletCollection, users, scheduledPayments, messages;
MongoClient.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
	.then(async client => {
		console.log('MongoDB conectado');
		db = client.db(); // usa la db por defecto del URI
		transactions = db.collection('transactions');
		walletCollection = db.collection('wallets');
		users = db.collection('users');
		scheduledPayments = db.collection('scheduledPayments');
		pushSubscriptionsCollection = db.collection('pushSubscriptions');

		// NUEVO: colección de mensajes
		messages = db.collection('messages');

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
		// índice para mensajes por fecha
		await messages.createIndex({ createdAt: 1 }).catch(()=>{});
	})
	.catch(err => console.error('MongoDB error', err));

// helper: calcular balance actual a partir de transacciones (ingresos - gastos)
async function computeBalanceFromTransactions() {
	try {
		if (!transactions) return 0;
		const agg = await transactions.aggregate([
			{
				$group: {
					_id: null,
					income: { $sum: { $cond: [{ $eq: ['$type', 'income'] }, '$amount', 0] } },
					expense: { $sum: { $cond: [{ $eq: ['$type', 'expense'] }, '$amount', 0] } }
				}
			}
		]).toArray();
		const row = agg && agg[0] ? agg[0] : { income: 0, expense: 0 };
		const income = Number(row.income || 0);
		const expense = Number(row.expense || 0);
		return income - expense;
	} catch (e) {
		console.warn('computeBalanceFromTransactions error', e);
		return 0;
	}
}

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
		// Convertir _id a string y establecer photoUrl si hay foto en BD o en fs
		const mapped = list.map(u => {
			const idStr = u._id ? u._id.toString() : u._id;
			let photoUrl = null;
			if (u.photoBase64 && u.photoMime) {
				photoUrl = `/api/users/${idStr}/photo`;
			} else if (u.photoUrl) {
				photoUrl = u.photoUrl;
			}
			return ({ ...u, _id: idStr, photoUrl });
		});
		res.json(mapped);
	} catch (err) {
		res.status(500).json({ error: 'Error al obtener usuarios' });
	}
});

// NUEVO: subir foto de perfil (dataUrl en JSON) - almacenar en MongoDB en lugar del filesystem
app.post('/api/users/:id/photo', async (req, res) => {
	try {
		const { id } = req.params;
		const { dataUrl } = req.body;
		if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'dataUrl requerido' });

		// parse dataUrl: data:[<mediatype>][;base64],<data>
		const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
		if (!match) return res.status(400).json({ error: 'dataUrl no válido' });

		const mime = match[1]; // e.g. image/png
		const b64 = match[2];

		// Guardar en la colección users: photoMime + photoBase64
		try {
			await users.updateOne(
				{ _id: new ObjectId(id) },
				{ $set: { photoMime: mime, photoBase64: b64, photoUrl: `/api/users/${id}/photo` } }
			);
		} catch (e) {
			// si id no es ObjectId válido o no existe, devolver error
			return res.status(400).json({ error: 'user id no válido o no existe' });
		}

		const updated = await users.findOne({ _id: new ObjectId(id) });
		const out = { ...updated, _id: updated._id.toString(), photoUrl: updated.photoUrl || null };
		io.emit('user:registered', out);
		res.json(out);
	} catch (err) {
		console.error('upload photo error', err);
		res.status(500).json({ error: 'Error al subir foto' });
	}
});

// NUEVO: servir foto del usuario desde MongoDB (persistente aunque el servidor se reinicie)
app.get('/api/users/:id/photo', async (req, res) => {
	try {
		const { id } = req.params;
		let u;
		try {
			u = await users.findOne({ _id: new ObjectId(id) });
		} catch (e) {
			return res.status(404).send('Not found');
		}
		if (!u) return res.status(404).send('Not found');

		// si tenemos foto en DB (photoBase64 + photoMime) devolverla
		if (u.photoBase64 && u.photoMime) {
			const buf = Buffer.from(u.photoBase64, 'base64');
			// cachear por un tiempo razonable (puedes ajustar Cache-Control)
			res.setHeader('Content-Type', u.photoMime);
			res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 día
			return res.send(buf);
		}

		// fallback: si existía photoUrl que apunta a uploads (por compatibilidad), intentar servir desde FS
		if (u.photoUrl && u.photoUrl.startsWith('/uploads/')) {
			const filepath = path.join(__dirname, u.photoUrl.replace('/uploads/', 'uploads/'));
			if (fs.existsSync(filepath)) {
				const stat = fs.statSync(filepath);
				res.setHeader('Content-Type', 'application/octet-stream');
				res.setHeader('Cache-Control', 'public, max-age=86400');
				return res.sendFile(filepath);
			}
		}

		// no hay foto
		return res.status(404).send('Not found');
	} catch (err) {
		console.error('GET user photo error', err);
		res.status(500).send('Error');
	}
});

// modificar creación de transacción para incluir usuario y emitir wallet:updated
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

		// emitir wallet actualizado calculado desde transacciones
		try {
			const balance = await computeBalanceFromTransactions();
			const w = await walletCollection.findOne({ _id: 'singleton' }) || {};
			io.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });
		} catch (err) { console.warn('emit wallet after tx create', err); }

		// --- NUEVO: Notificación push al crear gasto/ingreso ---
		try {
			if (pushSubscriptionsCollection) {
				let subs = [];
				if (userId) {
					subs = await pushSubscriptionsCollection.find({ userId: String(userId) }).toArray();
				}
				if (subs.length === 0) subs = await pushSubscriptionsCollection.find().toArray();
				const payload = {
					title: type === 'income' ? 'Nuevo ingreso' : 'Nuevo gasto',
					body: `${description} — ${Number(amount).toFixed(2)} EUR`,
					url: '/',
					tag: `transaction-${tx._id}`
				};
				for (const p of subs) {
					try {
						await webpush.sendNotification(p.subscription, JSON.stringify(payload));
					} catch (err) {
						try { await pushSubscriptionsCollection.deleteOne({ endpoint: p.endpoint }); } catch(e){}
					}
				}
			}
		} catch (err) {
			console.error('Error sending push for transaction', err);
		}
		// --- FIN NUEVO ---

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

		// emitir wallet actualizado calculado desde transacciones
		try {
			const balance = await computeBalanceFromTransactions();
			const w = await walletCollection.findOne({ _id: 'singleton' }) || {};
			io.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });
		} catch (err) { console.warn('emit wallet after tx delete', err); }

		res.json({ id });
	} catch (err) {
		res.status(500).json({ error: 'Error al borrar transacción' });
	}
});

app.delete('/api/transactions', async (req, res) => {
	try {
		await transactions.deleteMany({});
		io.emit('transactions:cleared');

		// emitir wallet actualizado calculado desde transacciones (ahora 0)
		try {
			const balance = await computeBalanceFromTransactions();
			const w = await walletCollection.findOne({ _id: 'singleton' }) || {};
			io.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });
		} catch (err) { console.warn('emit wallet after clear', err); }

		res.json({ cleared: true });
	} catch (err) {
		res.status(500).json({ error: 'Error al borrar todas las transacciones' });
	}
});

// Nuevas rutas para billetera y sueldo semanal
app.get('/api/wallet', async (req, res) => {
	try {
		const w = await walletCollection.findOne({ _id: 'singleton' });
		const weeklySalary = (w && typeof w.weeklySalary !== 'undefined') ? w.weeklySalary : 0;
		const balance = await computeBalanceFromTransactions();
		res.json({ balance: balance, weeklySalary: weeklySalary });
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

		const balance = await computeBalanceFromTransactions();
		const w = await walletCollection.findOne({ _id: 'singleton' }) || {};
		io.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });

		res.json({ balance: balance, weeklySalary: (w.weeklySalary || 0) });
	} catch (err) {
		res.status(500).json({ error: 'Error al configurar sueldo semanal' });
	}
});

app.post('/api/wallet/pay', async (req, res) => {
	try {
		const w = await walletCollection.findOne({ _id: 'singleton' }) || {};
		const salary = (w && w.weeklySalary) || 0;
		if (!salary || salary <= 0) return res.status(400).json({ error: 'Sueldo semanal no configurado o es 0' });

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

		// Calcular balance desde transacciones y emitir
		const balance = await computeBalanceFromTransactions();
		io.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });
		io.emit('transaction:created', tx);

		res.json({ balance: balance, transaction: tx });
	} catch (err) {
		res.status(500).json({ error: 'Error al procesar pago de sueldo' });
	}
});

// NUEVO: listar pagos programados (solo activos)
app.get('/api/scheduled', async (req, res) => {
	try {
		const list = await scheduledPayments.find({ $or: [ { active: { $ne: false } }, { active: { $exists: false } } ] }).sort({ nextDue: 1 }).toArray();
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
			type: type || 'expense',
			frequency, // 'weekly' | 'monthly' | 'biweekly' | 'once'
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

		// calcular siguiente fecha según frecuencia
		const now = new Date();
		let next = sched.nextDue ? new Date(sched.nextDue) : now;
		if (sched.frequency === 'weekly') next = new Date(next.getTime() + 7 * 24 * 60 * 60 * 1000);
		else if (sched.frequency === 'biweekly') next = new Date(next.getTime() + 14 * 24 * 60 * 60 * 1000);
		else if (sched.frequency === 'monthly') { next = new Date(next); next.setMonth(next.getMonth() + 1); }
		else { sched.active = false; next = null; } // once -> desactivar

		let ended = false;
		if (sched.endDate && next && next > new Date(sched.endDate)) {
			sched.active = false;
			next = null;
			ended = true;
		}

		const update = { $set: { lastPaid: now, nextDue: next, active: !!sched.active, notifiedAt: null } };
		await scheduledPayments.updateOne({ _id: new ObjectId(id) }, update);
		const updated = await scheduledPayments.findOne({ _id: new ObjectId(id) });
		const updatedStr = { ...updated, _id: updated._id ? updated._id.toString() : updated._id };

		// Emitir la transacción y el evento programado a TODOS los clientes
		// (io.emit es global; usar io.sockets.emit por redundancia en algunos entornos)
		try {
			io.emit('transaction:created', tx);
			if (io && io.sockets && typeof io.sockets.emit === 'function') {
				io.sockets.emit('transaction:created', tx);
			}
			io.emit('scheduled:paid', { scheduled: updatedStr, transaction: tx });
		} catch (e) {
			console.warn('emit scheduled pay events failed', e);
		}

		// Recalcular y emitir wallet actualizado a todos
		try {
			const balance = await computeBalanceFromTransactions();
			const w = await walletCollection.findOne({ _id: 'singleton' }) || {};
			io.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });
			if (io && io.sockets && typeof io.sockets.emit === 'function') {
				io.sockets.emit('wallet:updated', { balance, weeklySalary: (w.weeklySalary || 0) });
			}
		} catch (e) {
			console.warn('emit wallet after scheduled pay failed', e);
		}

		// --- Notificaciones push al pagar programado (mantener) ---
		try {
			if (pushSubscriptionsCollection) {
				let subs = [];
				if (sched.userId) {
					subs = await pushSubscriptionsCollection.find({ userId: String(sched.userId) }).toArray();
				}
				if (subs.length === 0) subs = await pushSubscriptionsCollection.find().toArray();
				const payload = {
					title: 'Pago programado realizado',
					body: `${sched.description} — ${Number(sched.amount).toFixed(2)} EUR`,
					url: '/',
					tag: `scheduled-paid-${sched._id}`
				};
				for (const p of subs) {
					try {
						await webpush.sendNotification(p.subscription, JSON.stringify(payload));
					} catch (err) {
						try { await pushSubscriptionsCollection.deleteOne({ endpoint: p.endpoint }); } catch(e){}
					}
				}
			}
		} catch (err) {
			console.error('Error sending push for scheduled pay', err);
		}
		// --- FIN NUEVO ---

		// Emitir evento especial si terminó
		if (ended) {
			io.emit('scheduled:ended', updatedStr);
		}

		res.json({ scheduled: updatedStr, transaction: tx });
	} catch (err) {
		console.error('Error en /api/scheduled/:id/pay', err);
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

// NUEVO: endpoint para enviar notificación de mensaje al user destino
app.post('/api/push/sendMessage', async (req, res) => {
	try {
		const { toUserId, title, body, data, tag } = req.body;
		if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
		if (!pushSubscriptionsCollection) return res.status(500).json({ error: 'Push collection not ready' });

		const subs = await pushSubscriptionsCollection.find({ userId: String(toUserId) }).toArray();
		if (!subs || subs.length === 0) return res.json({ sent: 0, note: 'no subscriptions for user' });

		const payload = {
			title: title || 'Nuevo mensaje',
			body: body || '',
			url: (data && data.url) || '/',
			tag: tag || `msg-${Date.now()}`
		};

		let sent = 0;
		for (const p of subs) {
			try {
				await webpush.sendNotification(p.subscription, JSON.stringify(payload));
				sent++;
			} catch (err) {
				console.warn('webpush send error, removing subscription', err);
				try { await pushSubscriptionsCollection.deleteOne({ endpoint: p.endpoint }); } catch(e){ /*ignore*/ }
			}
		}
		res.json({ sent });
	} catch (err) {
		console.error('Error in sendMessage push', err);
		res.status(500).json({ error: 'Error sending message pushes' });
	}
});

// NUEVO: endpoint para "despertar" el servidor o comprobar estado
app.get('/api/ping', (req, res) => {
	res.status(200).json({ pong: true, ts: Date.now() });
});

// --- Añadir endpoints de mensajes ---
// Obtener historial entre dos usuarios (user1 y user2)
app.get('/api/messages', async (req, res) => {
	try {
		const { user1, user2 } = req.query;
		if (!user1 || !user2) return res.status(400).json({ error: 'user1 y user2 requeridos' });

		const q = {
			$or: [
				{ fromUserId: String(user1), toUserId: String(user2) },
				{ fromUserId: String(user2), toUserId: String(user1) }
			]
		};
		const list = await messages.find(q).sort({ createdAt: 1 }).toArray();
		const mapped = list.map(m => ({ ...m, _id: m._id ? m._id.toString() : m._id }));
		res.json(mapped);
	} catch (err) {
		console.error('GET /api/messages error', err);
		res.status(500).json({ error: 'Error al obtener mensajes' });
	}
});

// Crear y enviar mensaje
app.post('/api/messages', async (req, res) => {
	try {
		const { fromUserId, toUserId, text } = req.body;
		if (!fromUserId || !toUserId || !text) return res.status(400).json({ error: 'fromUserId, toUserId y text requeridos' });

		const msg = {
			fromUserId: String(fromUserId),
			toUserId: String(toUserId),
			text: String(text),
			createdAt: new Date()
		};
		const result = await messages.insertOne(msg);
		msg._id = result.insertedId.toString();

		// Emitir solo a las rooms de remitente y destinatario (siempre que io exista)
		try {
			if (typeof io !== 'undefined' && io) {
				io.to(String(toUserId)).emit('message:created', msg);
				io.to(String(fromUserId)).emit('message:created', msg);
				// fallback global (opcional)
				io.emit('message:created', msg);
			}
		} catch (e) {
			console.warn('emit message error', e);
		}

		// ENVIAR PUSH a suscripciones del usuario destino (si existen)
		(async function sendPushForMessage() {
			try {
				if (!pushSubscriptionsCollection) return;
				const subs = await pushSubscriptionsCollection.find({ userId: String(toUserId) }).toArray();
				if (!subs || subs.length === 0) return;

				// Intentar obtener nombre del remitente para mostrar en la notificación
				let senderName = 'Nuevo mensaje';
				try {
					const u = await users.findOne({ _id: new ObjectId(fromUserId) });
					if (u && u.username) senderName = u.username;
				} catch(e){ /* puede que fromUserId no sea ObjectId válido, ignorar */ }

				const payload = {
					title: senderName,
					body: text.length > 120 ? text.slice(0, 117) + '...' : text,
					url: '/', // ajustar si se desea abrir ruta específica
					tag: `msg-${msg._id}`
				};

				for (const p of subs) {
					try {
						await webpush.sendNotification(p.subscription, JSON.stringify(payload));
					} catch (err) {
						// si la suscripción ya no es válida, eliminarla
						console.warn('webpush send error for message, removing subscription', err);
						try { await pushSubscriptionsCollection.deleteOne({ endpoint: p.endpoint }); } catch(e){ /* ignore */ }
					}
				}
			} catch (err) {
				console.error('Error sending push for message', err);
			}
		})();

		res.status(201).json(msg);
	} catch (err) {
		console.error('POST /api/messages error', err);
		res.status(500).json({ error: 'Error al crear mensaje' });
	}
});

// Añadir endpoint DELETE para mensajes
app.delete('/api/messages/:id', async (req, res) => {
	try {
		const { id } = req.params;
		if (!id) return res.status(400).json({ error: 'id requerido' });

		// intentar obtener el mensaje para conocer remitente/destino
		let msg;
		try {
			msg = await messages.findOne({ _id: new ObjectId(id) });
		} catch (e) {
			// id no es ObjectId válido
			return res.status(400).json({ error: 'id no válido' });
		}
		if (!msg) return res.status(404).json({ error: 'Mensaje no encontrado' });

		// borrar el mensaje
		const result = await messages.deleteOne({ _id: new ObjectId(id) });
		if (result.deletedCount === 0) return res.status(404).json({ error: 'No encontrado' });

		// emitir evento solo a las rooms relevantes (remitente y destinatario) y fallback global
		try {
			const fromId = msg.fromUserId ? String(msg.fromUserId) : null;
			const toId = msg.toUserId ? String(msg.toUserId) : null;
			const payload = { messageId: id, fromUserId: fromId, toUserId: toId };

			if (fromId) io.to(fromId).emit('message:deleted', payload);
			if (toId && toId !== fromId) io.to(toId).emit('message:deleted', payload);
			// fallback global para clientes que no están en rooms
			io.emit('message:deleted', payload);
		} catch (e) {
			console.warn('emit message:deleted failed', e);
		}

		res.json({ id });
	} catch (err) {
		console.error('DELETE /api/messages/:id error', err);
		res.status(500).json({ error: 'Error al eliminar mensaje' });
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

		// NUEVO: detectar pagos programados que han terminado y emitir evento especial
		const endedList = await scheduledPayments.find({
			active: true,
			endDate: { $ne: null, $lte: now }
		}).toArray();
		for (const s of endedList) {
			await scheduledPayments.updateOne({ _id: s._id }, { $set: { active: false } });
			const endedObj = { ...s, active: false, _id: s._id.toString() };
			io.emit('scheduled:ended', endedObj);
		}
	} catch (err) {
		console.error('Error worker scheduled:', err);
	}
}, 60 * 1000); // cada minuto

// Socket.IO with explicit CORS origin (permitir el cliente alojado en Render)
// permitir cualquier origin para desarrollo local (puedes ajustar a RENDER_URL en producción)
const userPresence = {}; // { userId: { online: true, lastSeen: Date, typingTo: userId|null } }

const io = new Server(server, {
	cors: {
		origin: '*',
		methods: ['GET', 'POST']
	}
});

io.on('connection', socket => {
	console.log('socket conectado', socket.id);

	let currentUserId = null;

	socket.on('user:join', userId => {
		try {
			if (!userId) return;
			currentUserId = String(userId);
			socket.join(currentUserId);
			userPresence[currentUserId] = userPresence[currentUserId] || {};
			userPresence[currentUserId].online = true;
			userPresence[currentUserId].lastSeen = new Date();
			userPresence[currentUserId].typingTo = null;
			io.emit('presence:update', { userId: currentUserId, online: true, lastSeen: userPresence[currentUserId].lastSeen });
			console.log('socket', socket.id, 'joined user room', currentUserId);
		} catch(e){ console.warn(e); }
	});

	socket.on('user:leave', userId => {
		try {
			if (!userId) return;
			socket.leave(String(userId));
			if (userPresence[userId]) {
				userPresence[userId].online = false;
				userPresence[userId].lastSeen = new Date();
				userPresence[userId].typingTo = null;
				io.emit('presence:update', { userId, online: false, lastSeen: userPresence[userId].lastSeen });
			}
		} catch(e){}
	});

	socket.on('typing', ({ fromUserId, toUserId, typing }) => {
		if (!fromUserId || !toUserId) return;
		userPresence[fromUserId] = userPresence[fromUserId] || {};
		userPresence[fromUserId].typingTo = typing ? toUserId : null;
		io.to(String(toUserId)).emit('typing', { fromUserId, typing });
	});

	socket.on('message:read', ({ fromUserId, toUserId, messageId }) => {
		// Notifica al remitente que el mensaje fue leído
		if (fromUserId && toUserId && messageId) {
			io.to(String(fromUserId)).emit('message:read', { fromUserId, toUserId, messageId });
		}
	});

	socket.on('disconnect', () => {
		if (currentUserId) {
			userPresence[currentUserId].online = false;
			userPresence[currentUserId].lastSeen = new Date();
			userPresence[currentUserId].typingTo = null;
			io.emit('presence:update', { userId: currentUserId, online: false, lastSeen: userPresence[currentUserId].lastSeen });
		}
		console.log('socket desconectado', socket.id);
	});
});

// Start - escuchar en todas las interfaces (0.0.0.0) para entornos cloud
server.listen(PORT, '0.0.0.0', () => {
	console.log(`Servidor escuchando en puerto ${PORT}`);
	console.log(`Socket.IO origin permitido: ${RENDER_URL}`);
});


