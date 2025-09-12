const express = require('express');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');
const http = require('http');
const { Server } = require('socket.io');

const app = express();

// Configuración
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://daniel:daniel25@so.k6u9iol.mongodb.net/?retryWrites=true&w=majority&appName=so&authSource=admin';
const DB_NAME = process.env.DB_NAME || 'gastos_app';
const COLLECTION = process.env.COLLECTION || 'transactions';
const RENDER_BACKEND = process.env.RENDER_BACKEND || 'https://dimeloweb.onrender.com';
const PORT = process.env.PORT || 3000;

// middlewares
app.use(express.json());
app.use((req, res, next) => {
	// CORS simple para desarrollo / uso desde el frontend
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
	if (req.method === 'OPTIONS') return res.sendStatus(204);
	next();
});

// Servir archivos estáticos (index.html, styles.css, app.js) desde la carpeta del proyecto
app.use(express.static(path.join(__dirname)));

// Healthcheck
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// --- MongoDB setup ---
let mongoClient;
let collection;

async function initMongo() {
	try {
		mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
		await mongoClient.connect();
		const db = mongoClient.db(DB_NAME);
		collection = db.collection(COLLECTION);
		console.log('Conectado a MongoDB:', DB_NAME, '/', COLLECTION);
	} catch (err) {
		console.error('Error conectando a MongoDB', err);
		process.exit(1);
	}
}

// Endpoints para transacciones
app.get('/api/transactions', async (req, res) => {
	try {
		const docs = await collection.find().sort({ date: -1 }).toArray();
		const result = docs.map(d => ({
			id: d._id.toString(),
			type: d.type,
			description: d.description,
			amount: d.amount,
			category: d.category,
			date: d.date
		}));
		res.json(result);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'error_server' });
	}
});

app.post('/api/transactions', async (req, res) => {
	try {
		const { type, description, amount, category, date } = req.body;
		if (!type || !description || amount == null) return res.status(400).json({ error: 'datos_invalidos' });
		const doc = {
			type,
			description,
			amount: Number(amount),
			category: category || 'General',
			date: date || new Date().toISOString()
		};
		const r = await collection.insertOne(doc);
		const created = {
			id: r.insertedId.toString(),
			...doc
		};
		// Emitir evento socket al crear una transacción
		if (typeof io !== 'undefined') io.emit('transaction:created', created);
		return res.status(201).json(created);
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'error_server' });
	}
});

app.delete('/api/transactions/:id', async (req, res) => {
	try {
		const id = req.params.id;
		if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'id_invalido' });
		const r = await collection.deleteOne({ _id: new ObjectId(id) });
		if (r.deletedCount === 0) return res.status(404).json({ error: 'no_encontrado' });
		// Emitir evento socket al eliminar una transacción
		if (typeof io !== 'undefined') io.emit('transaction:deleted', { id });
		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'error_server' });
	}
});

// Borrar todas las transacciones (uso: botón "Borrar todo" del frontend puede llamar aquí)
app.delete('/api/transactions/clear', async (req, res) => {
	try {
		await collection.deleteMany({});
		// Emitir evento socket al borrar todo
		if (typeof io !== 'undefined') io.emit('transactions:cleared');
		return res.json({ success: true });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: 'error_server' });
	}
});

// Proxy simple: reenvía peticiones a RENDER_BACKEND (mantiene la funcionalidad previa)
app.use('/api/proxy', async (req, res) => {
	try {
		// Construir URL destino: quita el prefijo /api/proxy
		const targetPath = req.originalUrl.replace(/^\/api\/proxy/, '') || '/';
		const targetUrl = new URL(targetPath, RENDER_BACKEND).toString();

		if (typeof fetch !== 'function') {
			console.warn('Global fetch no disponible. Ejecuta en Node 18+ o instala un polyfill.');
			return res.status(500).json({ error: 'fetch no disponible en este entorno' });
		}

		const headers = { ...req.headers };
		delete headers.host;

		const fetchOptions = {
			method: req.method,
			headers,
			body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
			redirect: 'follow'
		};

		const backendResp = await fetch(targetUrl, fetchOptions);
		res.status(backendResp.status);
		backendResp.headers.forEach((value, name) => {
			if (!['content-encoding', 'transfer-encoding', 'connection'].includes(name)) {
				res.setHeader(name, value);
			}
		});
		const text = await backendResp.text();
		const contentType = backendResp.headers.get('content-type') || '';
		if (contentType.includes('application/json')) {
			try { return res.json(JSON.parse(text)); } catch (e) { /* fallthrough */ }
		}
		return res.send(text);
	} catch (err) {
		console.error('Proxy error:', err);
		return res.status(502).json({ error: 'Error al conectar con el backend' });
	}
});

let io;
initMongo().then(() => {
	// Crear servidor HTTP y adjuntar socket.io
	const server = http.createServer(app);
	io = new Server(server);

	io.on('connection', socket => {
		console.log('Socket.io conectado:', socket.id);
		socket.on('disconnect', () => console.log('Socket.io desconectado:', socket.id));
	});

	server.listen(PORT, () => {
		console.log(`Server escuchando en puerto ${PORT}`);
		console.log(`Proxy hacia: ${RENDER_BACKEND} (usa /api/proxy/*)`);
	});
}).catch(err => {
	console.error('No se pudo iniciar el servidor:', err);
	process.exit(1);
});

// Manejo de cierre
process.on('SIGINT', async () => {
	console.log('Cerrando...');
	if (mongoClient) await mongoClient.close();
	// Cerrar socket.io si existe
	if (io) await io.close();
	process.exit(0);
});
