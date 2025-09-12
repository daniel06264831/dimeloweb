const path = require('path');
const http = require('http');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Config
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://daniel:daniel25@so.k6u9iol.mongodb.net/?retryWrites=true&w=majority&appName=so&authSource=admin';
const RENDER_URL = process.env.RENDER_URL || 'https://dimeloweb.onrender.com';

// Middlewares
app.use(express.json());
app.use(express.static(path.join(__dirname))); // sirve index.html y archivos estáticos

// MongoDB connection
let db, transactions;
MongoClient.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
	.then(client => {
		console.log('MongoDB conectado');
		db = client.db(); // usa la db por defecto del URI
		transactions = db.collection('transactions');
	})
	.catch(err => console.error('MongoDB error', err));

// API
app.get('/api/transactions', async (req, res) => {
	try {
		const txs = await transactions.find().sort({ createdAt: -1 }).toArray();
		res.json(txs);
	} catch (err) {
		res.status(500).json({ error: 'Error al obtener transacciones' });
	}
});

app.post('/api/transactions', async (req, res) => {
	try {
		const { description, amount, type, category } = req.body;
		if (!description || !amount || !type) return res.status(400).json({ error: 'Datos incompletos' });
		const tx = {
			description,
			amount,
			type,
			category: category || 'General',
			createdAt: new Date()
		};
		const result = await transactions.insertOne(tx);
		tx._id = result.insertedId;
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

// Socket.IO with explicit CORS origin (permitir el cliente alojado en Render)
const io = new Server(server, {
	cors: {
		origin: RENDER_URL,
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
