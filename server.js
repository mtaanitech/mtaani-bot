require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { db } = require("./src/db");
const { startSession, stopSession, getSession, restoreSessions, normalizePhone } = require("./src/whatsapp");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "";
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false") === "true";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";
const PAYSTACK_PLAN_CODE = process.env.PAYSTACK_PLAN_CODE || "";
const PAYSTACK_CURRENCY = process.env.PAYSTACK_CURRENCY || "KES";
const SUBSCRIPTION_AMOUNT_KES = Number(process.env.SUBSCRIPTION_AMOUNT_KES || 500);
const MONTHLY_CREDITS = Math.max(0, Math.floor(Number(process.env.MONTHLY_CREDITS || 1000)));

if (JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters. Set it in the environment.");
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
    }
  }
}));
app.use(express.json({
  limit: "32kb",
  verify: (req, _res, buffer) => {
    // Paystack signatures must be checked against the exact raw request bytes.
    if (req.originalUrl === "/api/payments/webhook") req.rawBody = Buffer.from(buffer);
  }
}));
app.use(cookieParser());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const paymentLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

function audit(actorId, targetId, action, detail = "") {
  db.prepare("INSERT INTO audit_logs (actor_user_id, target_user_id, action, detail) VALUES (?, ?, ?, ?)")
    .run(actorId || null, targetId || null, action, String(detail).slice(0, 500));
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: "12h", issuer: "mtaani-bot" });
}
function setAuthCookie(res, token) {
  res.cookie("mb_session", token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
    maxAge: 12 * 60 * 60 * 1000
  });
}
function clearAuthCookie(res) {
  res.clearCookie("mb_session", { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: "/" });
}
function requireAuth(req, res, next) {
  const token = req.cookies.mb_session;
  if (!token) return res.status(401).json({ error: "Please log in" });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: "mtaani-bot" });
    const user = db.prepare("SELECT id, email, role, status FROM users WHERE id = ?").get(payload.sub);
    if (!user || user.status !== "active") {
      clearAuthCookie(res);
      return res.status(401).json({ error: "Account unavailable" });
    }
    req.user = user;
    next();
  } catch {
    clearAuthCookie(res);
    return res.status(401).json({ error: "Session expired; log in again" });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
function requireActiveSubscription(req, res, next) {
  const sub = db.prepare("SELECT status, current_period_end FROM subscriptions WHERE user_id = ?").get(req.user.id);
  if (!sub || sub.status !== "active" || !sub.current_period_end ||
      new Date(sub.current_period_end).getTime() <= Date.now()) {
    return res.status(402).json({ error: "An active subscription is required" });
  }
  next();
}
function getSubscription(userId) {
  return db.prepare("SELECT status, current_period_end, plan_code FROM subscriptions WHERE user_id = ?").get(userId) ||
    { status: "inactive", current_period_end: null, plan_code: null };
}
function getWallet(userId) {
  db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)").run(userId);
  return db.prepare("SELECT balance, updated_at FROM wallets WHERE user_id = ?").get(userId);
}
function grantMonthlyCredits(userId, paymentReference) {
  if (MONTHLY_CREDITS <= 0) return;
  getWallet(userId);
  const reference = `monthly_topup:${paymentReference}`;
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO credit_transactions
      (user_id, reference, amount, kind, description)
    VALUES (?, ?, ?, 'monthly_topup', ?)
  `).run(userId, reference, MONTHLY_CREDITS, "Monthly subscription credit top-up");
  if (inserted.changes > 0) {
    db.prepare("UPDATE wallets SET balance = balance + ?, updated_at=datetime('now') WHERE user_id=?")
      .run(MONTHLY_CREDITS, userId);
  }
}

function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password || password === "replace-this-with-a-strong-password") {
    console.warn("ADMIN_EMAIL/ADMIN_PASSWORD not configured; create an admin manually before production.");
    return;
  }
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!existing) {
    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')").run(email, hash);
    db.prepare("INSERT INTO subscriptions (user_id, status) VALUES (?, 'active')").run(result.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO wallets (user_id, balance) VALUES (?, 0)").run(result.lastInsertRowid);
    console.log("Initial admin created:", email);
  } else {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(existing.id);
  }
}
ensureAdmin();

app.get("/health", (_req, res) => res.json({ ok: true, service: "Mtaani Bot SaaS" }));
app.get("/api/config", (_req, res) => {
  res.json({
    paystackConfigured: Boolean(PAYSTACK_SECRET_KEY && PAYSTACK_PLAN_CODE),
    amountKes: SUBSCRIPTION_AMOUNT_KES,
    currency: PAYSTACK_CURRENCY
  });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Enter a valid email address" });
  }
  if (password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: "Password must be 12–128 characters" });
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const tx = db.transaction(() => {
      const result = db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)").run(email, hash);
      db.prepare("INSERT INTO subscriptions (user_id, status) VALUES (?, 'inactive')").run(result.lastInsertRowid);
      db.prepare("INSERT INTO wallets (user_id, balance) VALUES (?, 0)").run(result.lastInsertRowid);
      db.prepare("INSERT INTO whatsapp_sessions (user_id, status) VALUES (?, 'disconnected')").run(result.lastInsertRowid);
      audit(result.lastInsertRowid, result.lastInsertRowid, "user.registered");
      return db.prepare("SELECT id, email, role, status FROM users WHERE id = ?").get(result.lastInsertRowid);
    });
    const user = tx();
    setAuthCookie(res, signToken(user));
    res.status(201).json({ user, subscription: getSubscription(user.id) });
  } catch (err) {
    if (String(err.code).includes("SQLITE_CONSTRAINT")) return res.status(409).json({ error: "Email already registered" });
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT id, email, password_hash, role, status FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash)) || user.status !== "active") {
    return res.status(401).json({ error: "Invalid credentials or account unavailable" });
  }
  setAuthCookie(res, signToken(user));
  audit(user.id, user.id, "user.login");
  res.json({ user: { id: user.id, email: user.email, role: user.role, status: user.status }, subscription: getSubscription(user.id) });
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const sub = getSubscription(req.user.id);
  res.json({
    user: req.user,
    subscription: sub,
    wallet: getWallet(req.user.id),
    whatsapp: getSession(req.user.id),
    github: db.prepare("SELECT repo_url, branch, updated_at FROM github_repositories WHERE user_id = ?").get(req.user.id) || null
  });
});

app.post("/api/payments/initialize", requireAuth, paymentLimiter, async (req, res) => {
  if (!PAYSTACK_SECRET_KEY || !PAYSTACK_PLAN_CODE) {
    return res.status(503).json({ error: "Paystack monthly plan is not configured" });
  }
  const reference = `mb_${req.user.id}_${crypto.randomBytes(12).toString("hex")}`;
  db.prepare("INSERT INTO payments (user_id, reference, currency, status) VALUES (?, ?, ?, 'pending')")
    .run(req.user.id, reference, PAYSTACK_CURRENCY);

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: req.user.email,
        plan: PAYSTACK_PLAN_CODE,
        reference,
        callback_url: `${PUBLIC_URL}/?payment=callback`,
        metadata: { userId: req.user.id, app: "mtaani-bot-saas" }
      })
    });
    const data = await response.json();
    if (!response.ok || !data.status || !data.data?.authorization_url) {
      console.error("Paystack initialize rejected:", data.message || response.status);
      return res.status(502).json({ error: "Could not initialize payment" });
    }
    res.json({ authorizationUrl: data.data.authorization_url, reference });
  } catch (err) {
    console.error("Paystack initialize error:", err.message);
    res.status(502).json({ error: "Payment provider unavailable" });
  }
});

async function verifyPaystackTransaction(reference) {
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
  });
  const result = await response.json();
  if (!response.ok || !result.status || result.data?.status !== "success") {
    throw new Error("Payment has not been verified as successful");
  }
  return result.data;
}

function activateSubscription(userId, customerCode, subscriptionCode, planCode) {
  const current = db.prepare("SELECT status, current_period_end FROM subscriptions WHERE user_id = ?").get(userId);
  const now = Date.now();
  const existingEnd = current?.current_period_end ? new Date(current.current_period_end).getTime() : 0;
  const startFrom = Math.max(now, Number.isFinite(existingEnd) ? existingEnd : 0);
  const end = new Date(startFrom + 30 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO subscriptions
      (user_id, status, plan_code, paystack_customer_code, paystack_subscription_code, current_period_end, updated_at)
    VALUES (?, 'active', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      status='active',
      plan_code=excluded.plan_code,
      paystack_customer_code=COALESCE(excluded.paystack_customer_code, subscriptions.paystack_customer_code),
      paystack_subscription_code=COALESCE(excluded.paystack_subscription_code, subscriptions.paystack_subscription_code),
      current_period_end=excluded.current_period_end,
      updated_at=datetime('now')
  `).run(userId, planCode || PAYSTACK_PLAN_CODE, customerCode || null, subscriptionCode || null, end);
}

app.get("/api/payments/verify/:reference", requireAuth, async (req, res) => {
  const reference = String(req.params.reference || "");
  const payment = db.prepare("SELECT * FROM payments WHERE reference = ? AND user_id = ?").get(reference, req.user.id);
  if (!payment) return res.status(404).json({ error: "Payment reference not found" });
  try {
    const verified = await verifyPaystackTransaction(reference);
    if (verified.metadata?.userId && Number(verified.metadata.userId) !== req.user.id) {
      return res.status(403).json({ error: "Payment owner mismatch" });
    }
    if (verified.currency !== PAYSTACK_CURRENCY) {
      return res.status(400).json({ error: "Payment currency mismatch" });
    }
    if (verified.plan_object?.plan_code && verified.plan_object.plan_code !== PAYSTACK_PLAN_CODE) {
      return res.status(400).json({ error: "Payment plan mismatch" });
    }
    const expectedAmount = Math.round(SUBSCRIPTION_AMOUNT_KES * 100);
    if (Number(verified.amount || 0) < expectedAmount) {
      return res.status(400).json({ error: "Verified payment amount is below the configured plan price" });
    }
    const tx = db.transaction(() => {
      const fresh = db.prepare("SELECT status FROM payments WHERE reference = ?").get(reference);
      if (fresh.status !== "success") {
        db.prepare(`UPDATE payments SET status='success', paystack_transaction_id=?, amount=?, currency=?, paid_at=datetime('now')
                    WHERE reference=?`)
          .run(String(verified.id), Number(verified.amount || 0), verified.currency, reference);
        activateSubscription(req.user.id, verified.customer?.customer_code, verified.subscription?.subscription_code, verified.plan_object?.plan_code || PAYSTACK_PLAN_CODE);
        grantMonthlyCredits(req.user.id, reference);
        audit(req.user.id, req.user.id, "subscription.activated", reference);
      }
    });
    tx();
    res.json({ ok: true, subscription: getSubscription(req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not verify payment" });
  }
});

app.post("/api/payments/webhook", async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) return res.sendStatus(503);
  if (!Buffer.isBuffer(req.rawBody)) return res.sendStatus(400);
  const signature = req.get("x-paystack-signature") || "";
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY).update(req.rawBody).digest("hex");
  const suppliedBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (suppliedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(suppliedBuf, expectedBuf)) {
    return res.sendStatus(401);
  }

  let event;
  try { event = JSON.parse(req.rawBody.toString("utf8")); }
  catch { return res.sendStatus(400); }

  try {
    if (event.event === "charge.success" && event.data?.reference) {
      const reference = String(event.data.reference);
      const payment = db.prepare("SELECT * FROM payments WHERE reference = ?").get(reference);

      // Only activate subscriptions for references created by this app.
      if (payment) {
        const verified = await verifyPaystackTransaction(reference);
        const expectedAmount = Math.round(SUBSCRIPTION_AMOUNT_KES * 100);
        if (verified.status === "success" &&
            verified.currency === PAYSTACK_CURRENCY &&
            Number(verified.amount || 0) >= expectedAmount &&
            (!verified.plan_object?.plan_code || verified.plan_object.plan_code === PAYSTACK_PLAN_CODE)) {
          const metadataUserId = Number(verified.metadata?.userId || payment.user_id);
          if (metadataUserId === payment.user_id) {
            const tx = db.transaction(() => {
              const current = db.prepare("SELECT status FROM payments WHERE reference = ?").get(reference);
              if (current.status !== "success") {
                db.prepare(`UPDATE payments SET status='success', paystack_transaction_id=?, amount=?, currency=?, event_type=?, paid_at=datetime('now')
                            WHERE reference=?`)
                  .run(String(verified.id), Number(verified.amount || 0), verified.currency, event.event, reference);
                activateSubscription(payment.user_id, verified.customer?.customer_code, verified.subscription?.subscription_code, verified.plan_object?.plan_code || PAYSTACK_PLAN_CODE);
                grantMonthlyCredits(payment.user_id, reference);
                audit(null, payment.user_id, "subscription.activated.webhook", reference);
              }
            });
            tx();
          }
        }
      }
    } else if (event.event === "subscription.disable" || event.event === "subscription.not_renew") {
      const code = event.data?.subscription_code;
      if (code) {
        db.prepare(`UPDATE subscriptions SET status='cancelled', updated_at=datetime('now')
                    WHERE paystack_subscription_code=?`).run(code);
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error("Paystack webhook handling error:", err.message);
    return res.sendStatus(500);
  }
});

// Only the authenticated owner can see or operate their own WhatsApp session.
app.get("/api/wallet", requireAuth, (req, res) => {
  const wallet = getWallet(req.user.id);
  const transactions = db.prepare(`
    SELECT amount, kind, description, created_at
    FROM credit_transactions WHERE user_id=? ORDER BY id DESC LIMIT 50
  `).all(req.user.id);
  res.json({ wallet, transactions });
});

app.post("/api/whatsapp/start", requireAuth, requireActiveSubscription, async (req, res) => {
  const mode = req.body.mode === "phone" ? "phone" : "qr";
  try {
    let phone = "";
    if (mode === "phone") phone = normalizePhone(req.body.phoneNumber);
    const session = await startSession(req.user.id, mode, phone);
    res.json({
      status: session.status,
      qrDataUrl: session.qrDataUrl,
      pairingCode: session.pairingCode
    });
  } catch (err) {
    res.status(400).json({ error: err.message || "Could not start WhatsApp session" });
  }
});

app.get("/api/whatsapp/status", requireAuth, (req, res) => {
  res.json(getSession(req.user.id));
});

app.post("/api/whatsapp/stop", requireAuth, requireActiveSubscription, async (req, res) => {
  await stopSession(req.user.id, false);
  res.json({ status: "disconnected" });
});

app.post("/api/github/link", requireAuth, requireActiveSubscription, (req, res) => {
  const repoUrl = String(req.body.repoUrl || "").trim();
  const branch = String(req.body.branch || "main").trim();
  let parsed;
  try { parsed = new URL(repoUrl); } catch { return res.status(400).json({ error: "Enter a valid GitHub repository URL" }); }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(parsed.pathname) ||
      parsed.username || parsed.password) {
    return res.status(400).json({ error: "Use a public GitHub repository URL like https://github.com/owner/repo" });
  }
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..")) {
    return res.status(400).json({ error: "Invalid branch name" });
  }
  db.prepare(`
    INSERT INTO github_repositories (user_id, repo_url, branch)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET repo_url=excluded.repo_url, branch=excluded.branch, updated_at=datetime('now')
  `).run(req.user.id, repoUrl.replace(/\/$/, ""), branch);
  audit(req.user.id, req.user.id, "github.repository.linked", `${repoUrl}#${branch}`);
  res.json({ ok: true, repoUrl: repoUrl.replace(/\/$/, ""), branch, note: "Repository linked as metadata. Code execution is not enabled in this API server." });
});

app.delete("/api/github/link", requireAuth, (req, res) => {
  db.prepare("DELETE FROM github_repositories WHERE user_id=?").run(req.user.id);
  res.json({ ok: true });
});

app.get("/api/admin/overview", requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.role, u.status, u.created_at,
      s.status AS subscription_status, s.current_period_end,
      COALESCE(ws.status, 'disconnected') AS whatsapp_status,
      gr.repo_url
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id=u.id
    LEFT JOIN whatsapp_sessions ws ON ws.user_id=u.id
    LEFT JOIN github_repositories gr ON gr.user_id=u.id
    ORDER BY u.created_at DESC LIMIT 500
  `).all();
  const totals = {
    users: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='user'").get().n,
    activeSubscriptions: db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status='active' AND datetime(current_period_end) > datetime('now')").get().n,
    connectedBots: db.prepare("SELECT COUNT(*) AS n FROM whatsapp_sessions WHERE status='connected'").get().n,
    successfulPayments: db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status='success'").get().n
  };
  res.json({ users, totals });
});

app.post("/api/admin/users/:id/status", requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!Number.isSafeInteger(id) || id <= 0 || !["active", "suspended"].includes(status)) {
    return res.status(400).json({ error: "Invalid user or status" });
  }
  const target = db.prepare("SELECT id, role FROM users WHERE id=?").get(id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "admin") return res.status(400).json({ error: "Admin accounts cannot be suspended here" });
  db.prepare("UPDATE users SET status=? WHERE id=?").run(status, id);
  if (status === "suspended") stopSession(id, false).catch(() => {});
  audit(req.user.id, id, "admin.user_status_changed", status);
  res.json({ ok: true, id, status });
});

app.get("/api/admin/audit", requireAuth, requireAdmin, (_req, res) => {
  res.json(db.prepare(`
    SELECT a.id, a.action, a.detail, a.created_at,
      actor.email AS actor_email, target.email AS target_email
    FROM audit_logs a
    LEFT JOIN users actor ON actor.id=a.actor_user_id
    LEFT JOIN users target ON target.id=a.target_user_id
    ORDER BY a.id DESC LIMIT 200
  `).all());
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Mtaani Bot SaaS running on port ${PORT}`);
  try { await restoreSessions(); } catch (err) { console.error("Session restore warning:", err.message); }
});
