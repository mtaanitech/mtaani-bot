const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { db, dataDir } = require("./db");

const logger = pino({ level: "silent" });
const sessionDir = path.join(dataDir, "whatsapp-sessions");
fs.mkdirSync(sessionDir, { recursive: true });

const live = new Map();
const pendingStart = new Map();

function saveStatus(userId, status, lastError = null) {
  db.prepare(`
    INSERT INTO whatsapp_sessions (user_id, status, last_error, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      status=excluded.status,
      last_error=excluded.last_error,
      updated_at=datetime('now')
  `).run(userId, status, lastError);
}

function userSessionDir(userId) {
  return path.join(sessionDir, String(userId));
}

function removeSessionDirectory(userId) {
  fs.rmSync(userSessionDir(userId), { recursive: true, force: true });
}

function normalizePhone(input) {
  const phone = String(input || "").replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(phone)) {
    throw new Error("Enter an international number, e.g. 2547XXXXXXXX");
  }
  return phone;
}

async function startSession(userId, mode = "qr", phoneNumber = "") {
  if (live.has(userId)) {
    const existing = live.get(userId);
    if (mode === "phone" && existing.status !== "connected") {
      if (existing.sock && !existing.pairingCode) {
        const phone = normalizePhone(phoneNumber);
        existing.pairingCode = await existing.sock.requestPairingCode(phone);
        existing.status = "pairing_code";
        saveStatus(userId, "pairing_code");
      }
    }
    return existing;
  }
  if (pendingStart.has(userId)) return pendingStart.get(userId);

  const promise = (async () => {
    const folder = userSessionDir(userId);
    fs.mkdirSync(folder, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(folder);

    const record = {
      userId,
      status: "connecting",
      qrDataUrl: null,
      pairingCode: null,
      sock: null,
      lastError: null,
      startedAt: new Date().toISOString()
    };
    live.set(userId, record);
    saveStatus(userId, "connecting");

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ["Mtaani Bot", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    record.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async (update) => {
      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        try {
          record.qrDataUrl = await QRCode.toDataURL(qr);
          record.status = "qr";
          saveStatus(userId, "qr");
        } catch (err) {
          record.lastError = "Could not generate QR";
        }
      }

      if (connection === "open") {
        record.status = "connected";
        record.qrDataUrl = null;
        record.pairingCode = null;
        record.lastError = null;
        saveStatus(userId, "connected");
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        record.status = loggedOut ? "logged_out" : "disconnected";
        record.qrDataUrl = null;
        record.pairingCode = null;
        record.lastError = loggedOut ? "WhatsApp logged out; link again" : null;
        saveStatus(userId, record.status, record.lastError);
        live.delete(userId);

        // Leave auth files on ordinary disconnect so reconnect is possible.
        // Logged-out credentials are invalid and should be cleared.
        if (loggedOut) removeSessionDirectory(userId);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages || []) {
        if (!msg.message || msg.key.fromMe || !msg.key.remoteJid) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith("@g.us") || jid === "status@broadcast") continue;

        const text = msg.message.conversation ||
          msg.message.extendedTextMessage?.text || "";
        const command = text.trim().toLowerCase();

        // Small opt-in command demo; no unsolicited broadcasts.
        if (command === ".ping") {
          await sock.sendMessage(jid, { text: "Pong! 🏓 Mtaani Bot iko online." });
        } else if (command === ".menu") {
          await sock.sendMessage(jid, {
            text: "🤖 Mtaani Bot\\n\\n.ping — check status\\n.menu — show menu"
          });
        }
      }
    });

    if (mode === "phone") {
      const phone = normalizePhone(phoneNumber);
      // Pairing code is only available before this account has been registered.
      if (state.creds.registered) {
        record.status = "connected";
        saveStatus(userId, "connected");
      } else {
        record.pairingCode = await sock.requestPairingCode(phone);
        record.status = "pairing_code";
        saveStatus(userId, "pairing_code");
      }
    }

    return record;
  })();

  pendingStart.set(userId, promise);
  try {
    return await promise;
  } catch (err) {
    live.delete(userId);
    saveStatus(userId, "error", String(err.message || "Session start failed").slice(0, 300));
    throw err;
  } finally {
    pendingStart.delete(userId);
  }
}

async function stopSession(userId, clearCredentials = false) {
  const record = live.get(userId);
  if (record?.sock) {
    try { record.sock.end(undefined); } catch (_) {}
  }
  live.delete(userId);
  if (clearCredentials) removeSessionDirectory(userId);
  saveStatus(userId, "disconnected");
}

function getSession(userId) {
  const record = live.get(userId);
  const dbRecord = db.prepare(
    "SELECT status, last_error, updated_at FROM whatsapp_sessions WHERE user_id = ?"
  ).get(userId);

  return {
    status: record?.status || dbRecord?.status || "disconnected",
    qrDataUrl: record?.qrDataUrl || null,
    pairingCode: record?.pairingCode || null,
    lastError: record?.lastError || dbRecord?.last_error || null,
    updatedAt: dbRecord?.updated_at || null
  };
}

async function restoreSessions() {
  const rows = db.prepare(`
    SELECT ws.user_id
    FROM whatsapp_sessions ws
    JOIN users u ON u.id = ws.user_id
    JOIN subscriptions s ON s.user_id = u.id
    WHERE u.status = 'active'
      AND s.status = 'active'
      AND s.current_period_end > datetime('now')
      AND ws.status IN ('connected','disconnected','connecting')
  `).all();

  for (const row of rows) {
    const folder = userSessionDir(row.user_id);
    if (!fs.existsSync(path.join(folder, "creds.json"))) continue;
    try {
      await startSession(row.user_id, "qr");
    } catch (err) {
      console.error("Could not restore WhatsApp session for user", row.user_id, err.message);
    }
  }
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  restoreSessions,
  normalizePhone
};
