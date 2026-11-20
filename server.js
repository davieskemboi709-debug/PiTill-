'use strict';

// PiTill API — Node.js 18+, Express, and MySQL.
// Copy .env.example to .env and apply schema.sql before starting the server.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const crypto = require('node:crypto');

const PI_API = 'https://api.minepi.com/v2';
const app = express();
const PORT = Number(process.env.PORT || 3000);
const SCALE = 100000000n; // Matches DECIMAL(..., 8) and avoids floating-point money comparisons.

for (const name of ['PI_API_KEY', 'DB_HOST', 'DB_USER', 'DB_NAME']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  decimalNumbers: false,
});

// Enable browser CORS only for explicitly configured origins. Same-origin deployments need no CORS.
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (allowedOrigins.length) {
  app.use(cors({ origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  } }));
}
app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function moneyUnits(value) {
  const text = String(value ?? '');
  if (!/^\d{1,12}(?:\.\d{1,8})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt((fraction + '00000000').slice(0, 8));
}

async function piRequest(path, { method = 'GET', body, bearer } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = {};
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    else headers.Authorization = `Key ${process.env.PI_API_KEY}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${PI_API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    if (!response.ok) {
      const error = new Error('Pi API request failed');
      error.status = response.status;
      error.upstream = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function auth(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ error: 'Bearer access token required' });
  try {
    const me = await piRequest('/me', { bearer: match[1] });
    if (!me || typeof me.uid !== 'string' || !me.uid) {
      return res.status(401).json({ error: 'Invalid Pi token' });
    }
    const username = typeof me.username === 'string' ? me.username : null;
    await db.execute(
      'INSERT INTO users (pi_uid, username) VALUES (?, ?) ON DUPLICATE KEY UPDATE username = VALUES(username)',
      [me.uid, username],
    );
    const [rows] = await db.execute('SELECT id, pi_uid, username FROM users WHERE pi_uid = ?', [me.uid]);
    if (!rows[0]) return res.status(401).json({ error: 'Unable to load user' });
    req.user = rows[0];
    return next();
  } catch {
    return res.status(401).json({ error: 'Pi authentication failed' });
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/profile', auth, asyncRoute(async (req, res) => {
  const { role, business_name: businessName } = req.body || {};
  if (!['shop', 'freelancer'].includes(role)) {
    return res.status(400).json({ error: 'role must be shop or freelancer' });
  }
  if (businessName != null && (typeof businessName !== 'string' || businessName.trim().length > 120)) {
    return res.status(400).json({ error: 'business_name must be at most 120 characters' });
  }
  await db.execute('UPDATE users SET role = ?, business_name = ? WHERE id = ?', [
    role, businessName ? businessName.trim() : null, req.user.id,
  ]);
  res.json({ ok: true });
}));

app.post('/api/requests', auth, asyncRoute(async (req, res) => {
  const { title, amount, client_name: clientName, due_date: dueDate } = req.body || {};
  const units = moneyUnits(amount);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200 || units === null || units <= 0n) {
    return res.status(400).json({ error: 'A title (up to 200 characters) and positive amount (up to 8 decimals) are required' });
  }
  if (clientName != null && (typeof clientName !== 'string' || clientName.trim().length > 120)) {
    return res.status(400).json({ error: 'client_name must be at most 120 characters' });
  }
  if (dueDate != null && (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`)))) {
    return res.status(400).json({ error: 'due_date must use YYYY-MM-DD format' });
  }
  const code = crypto.randomBytes(16).toString('hex');
  const amountText = (units / SCALE).toString() + (units % SCALE ? `.${(units % SCALE).toString().padStart(8, '0').replace(/0+$/, '')}` : '');
  await db.execute(
    'INSERT INTO payment_requests (public_code, merchant_id, title, amount, client_name, due_date) VALUES (?, ?, ?, ?, ?, ?)',
    [code, req.user.id, title.trim(), amountText, clientName ? clientName.trim() : null, dueDate || null],
  );
  const baseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  res.status(201).json({ code, link: `${baseUrl}/pay/${code}` });
}));

app.get('/api/requests', auth, asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    'SELECT id, public_code, title, amount, client_name, due_date, status, created_at FROM payment_requests WHERE merchant_id = ? ORDER BY created_at DESC',
    [req.user.id],
  );
  res.json(rows);
}));

app.get('/api/requests/:code', asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT pr.public_code, pr.title, pr.amount, pr.status, pr.due_date, u.username, u.business_name
       FROM payment_requests pr JOIN users u ON u.id = pr.merchant_id WHERE pr.public_code = ?`,
    [req.params.code],
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

// The Pi SDK payment must include metadata: { public_code: requestCode } when created.
app.post('/api/payments/approve', auth, asyncRoute(async (req, res) => {
  const { paymentId, code } = req.body || {};
  if (typeof paymentId !== 'string' || !paymentId || paymentId.length > 255 || typeof code !== 'string' || !/^[a-f0-9]{32}$/.test(code)) {
    return res.status(400).json({ error: 'Valid paymentId and request code are required' });
  }

  const [requestRows] = await db.execute(
    "SELECT id, amount FROM payment_requests WHERE public_code = ? AND status = 'pending'",
    [code],
  );
  const request = requestRows[0];
  if (!request) return res.status(404).json({ error: 'Request not payable' });

  let piPayment;
  try {
    piPayment = await piRequest(`/payments/${encodeURIComponent(paymentId)}`);
  } catch {
    return res.status(502).json({ error: 'Could not verify payment with Pi' });
  }
  if (!piPayment || piPayment.user_uid !== req.user.pi_uid ||
      moneyUnits(piPayment.amount) !== moneyUnits(request.amount) ||
      !piPayment.metadata || piPayment.metadata.public_code !== code) {
    return res.status(400).json({ error: 'Payment owner, amount, or request metadata did not match' });
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [lockedRequests] = await conn.execute(
      "SELECT id, amount, status FROM payment_requests WHERE id = ? FOR UPDATE", [request.id],
    );
    const lockedRequest = lockedRequests[0];
    if (!lockedRequest || lockedRequest.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: 'Request is no longer payable' });
    }
    const [existingRows] = await conn.execute('SELECT * FROM payments WHERE pi_payment_id = ? FOR UPDATE', [paymentId]);
    let payment = existingRows[0];
    if (payment && (payment.request_id !== request.id || payment.payer_pi_uid !== req.user.pi_uid)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Payment is already associated with another request or payer' });
    }
    if (payment && payment.status === 'approved') {
      await conn.commit();
      return res.json({ ok: true });
    }
    if (payment && payment.status !== 'created') {
      await conn.rollback();
      return res.status(409).json({ error: 'Payment cannot be approved in its current state' });
    }
    if (!payment) {
      const [insert] = await conn.execute(
        "INSERT INTO payments (request_id, payer_pi_uid, pi_payment_id, amount, status) VALUES (?, ?, ?, ?, 'created')",
        [request.id, req.user.pi_uid, paymentId, request.amount],
      );
      payment = { id: insert.insertId };
    }
    await piRequest(`/payments/${encodeURIComponent(paymentId)}/approve`, { method: 'POST' });
    await conn.execute("UPDATE payments SET status = 'approved' WHERE id = ?", [payment.id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Payment has already been processed' });
    throw error;
  } finally {
    conn.release();
  }
}));

app.post('/api/payments/complete', auth, asyncRoute(async (req, res) => {
  const { paymentId, txid } = req.body || {};
  if (typeof paymentId !== 'string' || !paymentId || paymentId.length > 255 || typeof txid !== 'string' || !txid || txid.length > 255) {
    return res.status(400).json({ error: 'Valid paymentId and txid are required' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [paymentRows] = await conn.execute('SELECT * FROM payments WHERE pi_payment_id = ? FOR UPDATE', [paymentId]);
    const payment = paymentRows[0];
    if (!payment || payment.payer_pi_uid !== req.user.pi_uid) {
      await conn.rollback();
      return res.status(404).json({ error: 'Payment not found for this payer' });
    }
    if (payment.status === 'completed') {
      await conn.rollback();
      if (payment.txid !== txid) return res.status(409).json({ error: 'Payment was completed with a different transaction id' });
      return res.json({ ok: true, alreadyCompleted: true });
    }
    if (payment.status !== 'approved') {
      await conn.rollback();
      return res.status(409).json({ error: 'Payment has not been approved' });
    }
    const [requestRows] = await conn.execute('SELECT status FROM payment_requests WHERE id = ? FOR UPDATE', [payment.request_id]);
    if (!requestRows[0] || requestRows[0].status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: 'Request is no longer payable' });
    }

    // Keep the row locks until the Pi completion succeeds, so a second payment cannot pay the same request.
    await piRequest(`/payments/${encodeURIComponent(paymentId)}/complete`, { method: 'POST', body: { txid } });
    await conn.execute("UPDATE payments SET status = 'completed', txid = ?, completed_at = NOW() WHERE id = ?", [txid, payment.id]);
    await conn.execute("UPDATE payment_requests SET status = 'paid' WHERE id = ? AND status = 'pending'", [payment.request_id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.post('/api/payments/cancel', auth, asyncRoute(async (req, res) => {
  const paymentId = req.body && req.body.paymentId;
  if (typeof paymentId !== 'string' || !paymentId || paymentId.length > 255) {
    return res.status(400).json({ error: 'Valid paymentId is required' });
  }
  const [result] = await db.execute(
    "UPDATE payments SET status = 'cancelled' WHERE pi_payment_id = ? AND payer_pi_uid = ? AND status = 'created'",
    [paymentId, req.user.pi_uid],
  );
  if (result.affectedRows === 0) {
    const [rows] = await db.execute('SELECT status FROM payments WHERE pi_payment_id = ? AND payer_pi_uid = ?', [paymentId, req.user.pi_uid]);
    if (!rows[0]) return res.status(404).json({ error: 'Payment not found for this payer' });
    if (rows[0].status !== 'cancelled') return res.status(409).json({ error: 'Only an unapproved payment can be cancelled' });
  }
  res.json({ ok: true });
}));

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN DATE(p.completed_at) = CURDATE() THEN p.amount ELSE 0 END), 0) AS today,
       COALESCE(SUM(CASE WHEN p.completed_at >= NOW() - INTERVAL 7 DAY THEN p.amount ELSE 0 END), 0) AS week,
       COUNT(p.id) AS payments
     FROM payments p JOIN payment_requests pr ON pr.id = p.request_id
     WHERE pr.merchant_id = ? AND p.status = 'completed'`,
    [req.user.id],
  );
  res.json(rows[0]);
}));

app.use((err, req, res, next) => {
  console.error('Request failed:', err.message);
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => console.log(`PiTill API listening on port ${PORT}`));
async function shutdown() {
  server.close(async () => {
    await db.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
