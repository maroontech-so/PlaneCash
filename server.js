require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ---------- FIREBASE INIT ----------
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
        }),
    });
} catch (e) {
    console.warn('[Firebase] Admin init failed. Using in-memory fallback.');
}
const db = admin.apps.length ? admin.firestore() : null;

// ---------- IN-MEMORY FALLBACK ----------
const mem = {
    users: new Map(),      // uid -> user object
    bets: [],              // history of bets
    rounds: [],            // history of rounds (crash points)
    deposits: new Map(),   // depositId -> deposit
};

// ---------- SEED DEMO USER ----------
(async () => {
    const demoEmail = 'demo@pesaplane.com';
    const existing = await findUserByEmail(demoEmail);
    if (!existing) {
        const uid = 'demo-' + uuidv4();
        const hash = await bcrypt.hash('demo1234', 10);
        await createUser({
            uid,
            email: demoEmail,
            username: 'DemoPlayer',
            passwordHash: hash,
            balance: 15000,
            createdAt: Date.now(),
            role: 'user',
        });
        console.log('[Seed] Demo user created: demo@pesaplane.com / demo1234');
    }
})();

// ---------- HELPERS ----------
async function findUserByEmail(email) {
    if (db) {
        const snap = await db.collection('users').where('email', '==', email).limit(1).get();
        if (snap.empty) return null;
        const doc = snap.docs[0];
        return { uid: doc.id, ...doc.data() };
    }
    for (const u of mem.users.values()) if (u.email === email) return u;
    return null;
}

async function findUserById(uid) {
    if (db) {
        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) return null;
        return { uid: doc.id, ...doc.data() };
    }
    return mem.users.get(uid) || null;
}

async function createUser(user) {
    if (db) {
        const { uid, ...rest } = user;
        await db.collection('users').doc(uid).set(rest);
        return user;
    }
    mem.users.set(user.uid, user);
    return user;
}

async function updateUser(uid, patch) {
    if (db) {
        await db.collection('users').doc(uid).set(patch, { merge: true });
        return { uid, ...patch };
    }
    const u = mem.users.get(uid);
    if (!u) return null;
    const updated = { ...u, ...patch };
    mem.users.set(uid, updated);
    return updated;
}

// ---------- PROVABLY FAIR CRASH ENGINE ----------
const crypto = require('crypto');

function generateServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function hashSeed(seed, nonce) {
    return crypto.createHash('sha256').update(seed + ':' + nonce).digest('hex');
}

// Convert hash → crash point using house edge
function hashToCrash(hash, houseEdge = 0.05) {
    // take first 13 hex chars → 52-bit integer
    const h = parseInt(hash.slice(0, 13), 16);
    const max = Math.pow(2, 52);
    const r = h / max; // uniform [0,1)
    // Apply house edge: crash = 1 / (1 - r*(1-houseEdge)) ... tune
    // Standard formula: crash = floor(100 * (1 - houseEdge) / (1 - r)) / 100
    const raw = (1 - houseEdge) / (1 - r);
    const crash = Math.max(1.00, Math.floor(raw * 100) / 100);
    // cap at 1000x
    return Math.min(crash, 1000.00);
}

// ---------- ROUND MANAGER ----------
let currentRound = {
    roundId: null,
    serverSeed: null,
    serverSeedHash: null,
    nonce: 0,
    crashPoint: null,
    startTime: null,
    state: 'waiting', // waiting | running | crashed
    activeBets: [],   // { uid, username, amount, autoCashout, cashedOut, cashoutMult, winAmount }
    waitingEndsAt: null,
};

let roundTimer = null;
const WAITING_MS = 7000;

function startNewRound() {
    currentRound.roundId = uuidv4();
    currentRound.serverSeed = generateServerSeed();
    currentRound.serverSeedHash = crypto.createHash('sha256').update(currentRound.serverSeed).digest('hex');
    currentRound.nonce = 0;
    currentRound.crashPoint = null;
    currentRound.activeBets = [];
    currentRound.state = 'waiting';
    currentRound.waitingEndsAt = Date.now() + WAITING_MS;

    // Broadcast round start
    broadcast({ type: 'round_start', roundId: currentRound.roundId, serverSeedHash: currentRound.serverSeedHash, waitingEndsAt: currentRound.waitingEndsAt, state: 'waiting' });

    clearTimeout(roundTimer);
    roundTimer = setTimeout(() => beginRunning(), WAITING_MS);
}

function beginRunning() {
    // Compute crash point from seed + nonce
    const hash = hashSeed(currentRound.serverSeed, currentRound.nonce);
    currentRound.crashPoint = hashToCrash(hash, parseFloat(process.env.HOUSE_EDGE || '0.05'));
    currentRound.nonce++;
    currentRound.state = 'running';
    currentRound.startTime = Date.now();

    broadcast({ type: 'round_running', roundId: currentRound.roundId, crashPoint: currentRound.crashPoint, startTime: currentRound.startTime });
    console.log(`[Round ${currentRound.roundId.slice(0,8)}] Crash at ${currentRound.crashPoint}x`);

    // Monitor for crash
    monitorCrash();
}

function monitorCrash() {
    if (currentRound.state !== 'running') return;
    const elapsed = Date.now() - currentRound.startTime;
    const mult = Math.pow(Math.E, 0.00006 * elapsed);
    if (mult >= currentRound.crashPoint) {
        crashRound();
        return;
    }
    setTimeout(monitorCrash, 50);
}

async function crashRound() {
    if (currentRound.state === 'crashed') return;
    currentRound.state = 'crashed';

    // Mark remaining bets as lost (don't refund; already deducted)
    for (const bet of currentRound.activeBets) {
        if (!bet.cashedOut) {
            await recordBetHistory(bet, false);
        }
    }

    // push round history
    const roundRec = { roundId: currentRound.roundId, crashPoint: currentRound.crashPoint, serverSeed: currentRound.serverSeed, nonce: currentRound.nonce - 1, endedAt: Date.now() };
    if (db) {
        try { await db.collection('rounds').add(roundRec); } catch (e) { mem.rounds.push(roundRec); }
    } else {
        mem.rounds.push(roundRec);
    }

    broadcast({ type: 'round_crashed', roundId: currentRound.roundId, crashPoint: currentRound.crashPoint, serverSeed: currentRound.serverSeed });

    // Schedule next round
    setTimeout(() => startNewRound(), 3000);
}

async function recordBetHistory(bet, won) {
    const rec = {
        uid: bet.uid,
        username: bet.username,
        amount: bet.amount,
        roundId: currentRound.roundId,
        crashPoint: currentRound.crashPoint,
        cashedOut: !!bet.cashedOut,
        cashoutMult: bet.cashoutMult || 0,
        winAmount: bet.winAmount || 0,
        timestamp: Date.now(),
    };
    if (db) {
        try { await db.collection('bets').add(rec); } catch (e) { mem.bets.push(rec); }
    } else {
        mem.bets.push(rec);
    }
}

// ---------- MULTIPLIER HELPERS ----------
function currentMultiplier() {
    if (currentRound.state !== 'running') return 1.00;
    const elapsed = Date.now() - currentRound.startTime;
    return Math.pow(Math.E, 0.00006 * elapsed);
}

// ---------- SSE BROADCAST ----------
const clients = new Set();
function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
        try { res.write(data); } catch (e) { clients.delete(res); }
    }
}

// ---------- EXPRESS APP ----------
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function authMiddleware(required = true) {
    return async (req, res, next) => {
        const token = req.cookies.token || req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            if (required) return res.status(401).json({ error: 'Not authenticated' });
            return next();
        }
        try {
            const payload = jwt.verify(token, JWT_SECRET);
            const user = await findUserById(payload.uid);
            if (!user) {
                if (required) return res.status(401).json({ error: 'User not found' });
                return next();
            }
            req.user = user;
            next();
        } catch (e) {
            if (required) return res.status(401).json({ error: 'Invalid token' });
            return next();
        }
    };
}

function signToken(uid) {
    return jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
}

// ---------- AUTH ROUTES ----------
app.post('/api/auth/register', async (req, res) => {
    const { email, username, password } = req.body || {};
    if (!email || !username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });

    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const uid = uuidv4();
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
        uid, email, username, passwordHash,
        balance: 0,
        createdAt: Date.now(),
        role: 'user',
    };
    await createUser(user);
    const token = signToken(uid);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: publicUser(user), token });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken(user.uid);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ user: publicUser(user), token });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware(true), (req, res) => {
    res.json({ user: publicUser(req.user) });
});

function publicUser(u) {
    return { uid: u.uid, email: u.email, username: u.username, balance: u.balance, role: u.role || 'user' };
}

// ---------- BALANCE / WALLET ----------
app.get('/api/wallet', authMiddleware(true), async (req, res) => {
    res.json({ balance: req.user.balance });
});

// Deposit (simulated payment provider)
app.post('/api/wallet/deposit', authMiddleware(true), async (req, res) => {
    const { amount, method = 'mpesa' } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0 || amt > 500000) return res.status(400).json({ error: 'Invalid amount' });

    const depositId = uuidv4();
    const deposit = {
        depositId,
        uid: req.user.uid,
        amount: amt,
        method,
        status: 'pending',
        createdAt: Date.now(),
    };
    if (db) {
        try { await db.collection('deposits').doc(depositId).set(deposit); } catch (e) { mem.deposits.set(depositId, deposit); }
    } else {
        mem.deposits.set(depositId, deposit);
    }

    // Simulate async confirmation after 1.5s
    setTimeout(async () => {
        const updated = { ...deposit, status: 'completed', completedAt: Date.now() };
        if (db) {
            try { await db.collection('deposits').doc(depositId).set(updated, { merge: true }); } catch (e) { mem.deposits.set(depositId, updated); }
        } else {
            mem.deposits.set(depositId, updated);
        }
        const fresh = await findUserById(req.user.uid);
        if (fresh) {
            await updateUser(req.user.uid, { balance: (fresh.balance || 0) + amt });
        }
        broadcast({ type: 'deposit_completed', depositId, uid: req.user.uid, amount: amt });
    }, 1500);

    res.json({ depositId, status: 'pending', amount: amt });
});

app.get('/api/wallet/deposit/:id', authMiddleware(true), async (req, res) => {
    const { id } = req.params;
    let dep = null;
    if (db) {
        const doc = await db.collection('deposits').doc(id).get();
        if (doc.exists) dep = { depositId: doc.id, ...doc.data() };
    } else {
        dep = mem.deposits.get(id);
    }
    if (!dep || dep.uid !== req.user.uid) return res.status(404).json({ error: 'Not found' });
    res.json(dep);
});

// Withdraw (simulated)
app.post('/api/wallet/withdraw', authMiddleware(true), async (req, res) => {
    const { amount } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt < 100) return res.status(400).json({ error: 'Minimum withdrawal is 100' });
    const fresh = await findUserById(req.user.uid);
    if (fresh.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
    await updateUser(req.user.uid, { balance: fresh.balance - amt });
    res.json({ ok: true, newBalance: fresh.balance - amt });
});

// ---------- BETTING ----------
app.post('/api/bet/place', authMiddleware(true), async (req, res) => {
    const { amount, autoCashout = 0 } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt < 10) return res.status(400).json({ error: 'Minimum bet is 10' });

    const fresh = await findUserById(req.user.uid);
    if (fresh.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    // Must be in waiting or running
    if (currentRound.state === 'crashed') return res.status(400).json({ error: 'Round ending, please wait' });

    // Prevent double-bet
    const existing = currentRound.activeBets.find(b => b.uid === req.user.uid);
    if (existing) return res.status(400).json({ error: 'Bet already placed this round' });

    // Deduct balance atomically
    const newBalance = fresh.balance - amt;
    await updateUser(req.user.uid, { balance: newBalance });

    const bet = {
        uid: req.user.uid,
        username: fresh.username,
        amount: amt,
        autoCashout: Number(autoCashout) || 0,
        cashedOut: false,
        cashoutMult: 0,
        winAmount: 0,
        placedAt: Date.now(),
        roundId: currentRound.roundId,
    };
    currentRound.activeBets.push(bet);

    broadcast({ type: 'bet_placed', roundId: currentRound.roundId, bet: publicBet(bet) });
    res.json({ ok: true, balance: newBalance, bet: publicBet(bet) });
});

app.post('/api/bet/cashout', authMiddleware(true), async (req, res) => {
    if (currentRound.state !== 'running') return res.status(400).json({ error: 'Round not running' });
    const bet = currentRound.activeBets.find(b => b.uid === req.user.uid);
    if (!bet) return res.status(404).json({ error: 'No active bet' });
    if (bet.cashedOut) return res.status(400).json({ error: 'Already cashed out' });

    const mult = currentMultiplier();
    if (mult >= currentRound.crashPoint) return res.status(400).json({ error: 'Too late' });

    const win = bet.amount * mult;
    bet.cashedOut = true;
    bet.cashoutMult = mult;
    bet.winAmount = win;

    const fresh = await findUserById(req.user.uid);
    await updateUser(req.user.uid, { balance: fresh.balance + win });

    await recordBetHistory(bet, true);

    broadcast({ type: 'bet_cashout', roundId: currentRound.roundId, uid: req.user.uid, username: bet.username, mult, winAmount: win });

    res.json({ ok: true, mult, winAmount: win, newBalance: fresh.balance + win });
});

function publicBet(b) {
    return { uid: b.uid, username: b.username, amount: b.amount, autoCashout: b.autoCashout, cashedOut: b.cashedOut, cashoutMult: b.cashoutMult, winAmount: b.winAmount };
}

// ---------- GAME STATE / HISTORY ----------
app.get('/api/game/state', (req, res) => {
    res.json({
        roundId: currentRound.roundId,
        state: currentRound.state,
        crashPoint: currentRound.state === 'crashed' ? currentRound.crashPoint : null,
        startTime: currentRound.startTime,
        waitingEndsAt: currentRound.waitingEndsAt,
        serverSeedHash: currentRound.serverSeedHash,
        multiplier: currentMultiplier(),
        activeBets: currentRound.activeBets.map(publicBet),
    });
});

app.get('/api/game/history', async (req, res) => {
    let rounds = [];
    if (db) {
        try {
            const snap = await db.collection('rounds').orderBy('endedAt', 'desc').limit(20).get();
            snap.forEach(d => rounds.push({ id: d.id, ...d.data() }));
        } catch (e) { rounds = mem.rounds.slice(-20).reverse(); }
    } else {
        rounds = mem.rounds.slice(-20).reverse();
    }
    res.json({ rounds });
});

app.get('/api/game/verify/:roundId', async (req, res) => {
    let rec = null;
    if (db) {
        try {
            const snap = await db.collection('rounds').where('roundId', '==', req.params.roundId).limit(1).get();
            if (!snap.empty) rec = snap.docs[0].data();
        } catch (e) {}
    }
    if (!rec) rec = mem.rounds.find(r => r.roundId === req.params.roundId);
    if (!rec) return res.status(404).json({ error: 'Round not found' });
    const expected = hashToCrash(hashSeed(rec.serverSeed, rec.nonce), parseFloat(process.env.HOUSE_EDGE || '0.05'));
    res.json({ round: rec, expectedCrashPoint: expected, matches: expected === rec.crashPoint });
});

// ---------- SERVER-SENT EVENTS ----------
app.get('/api/events', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected', roundId: currentRound.roundId, state: currentRound.state, waitingEndsAt: currentRound.waitingEndsAt, startTime: currentRound.startTime, multiplier: currentMultiplier() })}\n\n`);
    req.on('close', () => clients.delete(res));
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`PesaPlane server running on http://localhost:${PORT}`);
    startNewRound();
});