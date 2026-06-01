const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const crypto = require("crypto");
const QRCode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
const PORT = 3000;

let qrDataUrl = null;
let waReady = false;
let isStopped = false;

const broadcastProgress = {
  active: false,
  current: 0,
  total: 0,
  name: "",
  done: false,
  sent: 0,
};

function resetBroadcastProgress() {
  broadcastProgress.active = false;
  broadcastProgress.current = 0;
  broadcastProgress.total = 0;
  broadcastProgress.name = "";
  broadcastProgress.done = false;
  broadcastProgress.sent = 0;
}

const winChromeUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: [`--user-agent=${winChromeUserAgent}`],
    protocolTimeout: 120000,
  },
  waitForInitialPage: false,
  authTimeoutMs: 60000,
});

client.on("qr", async (qr) => {
  try {
    qrDataUrl = await QRCode.toDataURL(qr);
  } catch (err) {
    console.error(err);
    qrDataUrl = null;
  }
});

/** Phone has scanned the QR; hide QR in the UI before `ready` (which can take a while). */
client.on("authenticated", () => {
  qrDataUrl = null;
  console.log("WhatsApp authenticated (QR cleared for UI)");
});

client.on("ready", () => {
  waReady = true;
  qrDataUrl = null;
  console.log("WhatsApp ready");
  void syncFromWhatsApp().catch((err) => console.error("Sync failed:", err));
});

client.on("disconnected", () => {
  waReady = false;
  console.log("WhatsApp disconnected");
});

const DATA_DIR = path.join(__dirname, "data");
const WWWEBJS_CACHE_DIR = path.join(__dirname, ".wwebjs_cache");

async function clearWWebJsCache() {
  try {
    await fs.rm(WWWEBJS_CACHE_DIR, { recursive: true, force: true });
    console.log("Cleared .wwebjs_cache");
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn("Could not clear .wwebjs_cache:", err.message || err);
    }
  }
}

/**
 * Deletes the WhatsApp Web version cache, then starts the client with retries.
 * Run before each client.initialize() so each process start gets a fresh web bundle.
 * (Clearing on every `ready` event would require destroy+reinit and can loop; cache is
 * only safe to remove while the browser is not using those files.)
 */
async function startWhatsAppClient() {
  await clearWWebJsCache();
  const maxAttempts = 3;
  const delayMs = 3000;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client.initialize();
      return;
    } catch (err) {
      lastErr = err;
      console.error(
        `WhatsApp client.initialize() failed (attempt ${attempt}/${maxAttempts}):`,
        err && err.message ? err.message : err
      );
      try {
        await client.destroy();
      } catch (destroyErr) {
        console.warn(
          "WhatsApp client.destroy() after failed init:",
          destroyErr && destroyErr.message ? destroyErr.message : destroyErr
        );
      }
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }
  console.error("WhatsApp client failed to start after all retries.");
  throw lastErr;
}

async function readJSON(file) {
  const filePath = path.join(DATA_DIR, file);
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJSON(file, data) {
  const filePath = path.join(DATA_DIR, file);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prependHistoryEntry(entry) {
  const history = await readJSON("history.json");
  const next = [entry, ...history].slice(0, 50);
  await writeJSON("history.json", next);
}

function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

function phoneKeyFromJid(id) {
  const s = String(id || "");
  const base = s.includes("@") ? s.split("@")[0] : s;
  return digitsOnly(base) || null;
}

/** Drop duplicate phone numbers; keeps first occurrence in contactIds. */
function dedupeGroupContactIds(contactIds, { fromWhatsApp, contacts }) {
  const ids = Array.isArray(contactIds) ? contactIds : [];
  const seen = new Set();
  const out = [];

  if (fromWhatsApp) {
    for (const id of ids) {
      if (!id) continue;
      const key = phoneKeyFromJid(id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
    return out;
  }

  const byId = new Map((Array.isArray(contacts) ? contacts : []).map((c) => [c.id, c]));
  for (const id of ids) {
    if (!id) continue;
    const contact = byId.get(id);
    const key = contact ? digitsOnly(contact.phone) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

/** Strip @c.us / @s.whatsapp.net suffix; keep digits for matching/storage. */
function phoneFromSerializedOrNumber(serialized, numberField) {
  const s = String(serialized || "");
  const base = s.includes("@") ? s.split("@")[0] : s;
  const fromNum = String(numberField || "").replace(/@c\.us$/i, "");
  const digits = digitsOnly(fromNum || base);
  return digits || null;
}

function participantSerializedId(p) {
  if (!p || !p.id) return null;
  if (typeof p.id === "string") return p.id;
  if (p.id._serialized) return p.id._serialized;
  return null;
}

/** Single-flight: concurrent callers await the same sync. */
let syncPromise = null;

async function syncFromWhatsApp() {
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    try {
      const rawContacts = await client.getContacts();
      const list = Array.isArray(rawContacts) ? rawContacts : [];

      const phoneBookContacts = list.filter(
        (c) =>
          c &&
          c.isMyContact === true &&
          c.name &&
          String(c.name).trim() !== "" &&
          c.number != null &&
          String(c.number).trim() !== "" &&
          c.id &&
          c.id._serialized
      );

      const existingList = await readJSON("contacts.json");
      const manualOnly = existingList.filter((row) => row.fromWhatsApp !== true);
      const manualPhones = new Set(manualOnly.map((row) => digitsOnly(row.phone)));

      const waAdds = [];
      for (const c of phoneBookContacts) {
        const phone = phoneFromSerializedOrNumber(c.id._serialized, c.number);
        if (!phone || manualPhones.has(phone)) continue;
        manualPhones.add(phone);
        waAdds.push({
          id: c.id._serialized,
          name: String(c.name).trim(),
          phone,
          fromWhatsApp: true,
        });
      }

      const mergedContacts = [...manualOnly, ...waAdds];
      await writeJSON("contacts.json", mergedContacts);
      console.log(`Synced ${phoneBookContacts.length} contacts from WhatsApp`);
    } catch (err) {
      console.error("WhatsApp contact sync error:", err);
    }

    try {
      const chats = await client.getChats();
      const groupChats = (Array.isArray(chats) ? chats : []).filter((ch) => ch && ch.isGroup === true);
      const waGroupRows = groupChats.length;

      const existingGroups = await readJSON("groups.json");
      const manualGroups = existingGroups.filter((g) => g.fromWhatsApp !== true);
      const waById = new Map();

      for (const chat of groupChats) {
        if (!chat.id || !chat.id._serialized || !chat.name) continue;
        const contactIds = [];
        const parts = chat.participants || [];
        for (const p of parts) {
          const sid = participantSerializedId(p);
          if (sid) contactIds.push(sid);
        }
        waById.set(chat.id._serialized, {
          id: chat.id._serialized,
          name: chat.name,
          contactIds: dedupeGroupContactIds(contactIds, {
            fromWhatsApp: true,
            contacts: [],
          }),
          fromWhatsApp: true,
        });
      }

      const mergedGroups = [...manualGroups, ...waById.values()];
      await writeJSON("groups.json", mergedGroups);
      console.log(`Synced ${waGroupRows} groups from WhatsApp`);
    } catch (err) {
      console.error("WhatsApp group sync error:", err);
    }

    try {
      const contactsOut = await readJSON("contacts.json");
      const groupsOut = await readJSON("groups.json");
      return {
        contacts: Array.isArray(contactsOut) ? contactsOut.length : 0,
        groups: Array.isArray(groupsOut) ? groupsOut.length : 0,
      };
    } catch (err) {
      console.error("Sync read-back error:", err);
      return { contacts: 0, groups: 0 };
    }
  })();

  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/ping", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/status", async (req, res) => {
  let contactCount = 0;
  let groupCount = 0;
  try {
    const contacts = await readJSON("contacts.json");
    const groups = await readJSON("groups.json");
    contactCount = Array.isArray(contacts) ? contacts.length : 0;
    groupCount = Array.isArray(groups) ? groups.length : 0;
  } catch (_) {
    /* use zeros */
  }
  res.json({
    ready: waReady,
    qr: waReady ? null : qrDataUrl,
    contactCount,
    groupCount,
  });
});

app.post("/api/sync", async (req, res) => {
  if (!waReady) {
    return res.status(400).json({ error: "WhatsApp not connected" });
  }
  try {
    const result = await syncFromWhatsApp();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sync failed" });
  }
});

app.get("/api/progress", (req, res) => {
  res.json(broadcastProgress);
});

app.get("/api/contacts", async (req, res) => {
  try {
    const contacts = await readJSON("contacts.json");
    const q = String(req.query.q == null ? "" : req.query.q)
      .trim()
      .toLowerCase();
    if (!q) {
      return res.json(contacts);
    }
    const filtered = contacts.filter((c) => {
      const name = (c && c.name) || "";
      const phone = (c && c.phone) || "";
      return name.toLowerCase().includes(q) || phone.toLowerCase().includes(q);
    });
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: "Failed to read contacts" });
  }
});

app.post("/api/contacts", async (req, res) => {
  const { name, phone } = req.body;
  if (name == null || String(name).trim() === "") {
    return res.status(400).json({ error: "Name is required" });
  }
  if (phone == null || String(phone).trim() === "") {
    return res.status(400).json({ error: "Phone is required" });
  }
  try {
    const contacts = await readJSON("contacts.json");
    const contact = { id: crypto.randomUUID(), name, phone };
    contacts.push(contact);
    await writeJSON("contacts.json", contacts);
    res.status(201).json(contact);
  } catch (err) {
    res.status(500).json({ error: "Failed to save contact" });
  }
});

app.delete("/api/contacts/:id", async (req, res) => {
  try {
    const contacts = await readJSON("contacts.json");
    const next = contacts.filter((c) => c.id !== req.params.id);
    if (next.length === contacts.length) {
      return res.status(404).json({ error: "Contact not found" });
    }
    await writeJSON("contacts.json", next);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete contact" });
  }
});

app.get("/api/groups", async (req, res) => {
  try {
    const groups = await readJSON("groups.json");
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: "Failed to read groups" });
  }
});

app.post("/api/groups", async (req, res) => {
  const { name, contactIds } = req.body;
  if (name == null || String(name).trim() === "") {
    return res.status(400).json({ error: "Name is required" });
  }
  try {
    const contacts = await readJSON("contacts.json");
    const groups = await readJSON("groups.json");
    const group = {
      id: crypto.randomUUID(),
      name,
      contactIds: dedupeGroupContactIds(contactIds, {
        fromWhatsApp: false,
        contacts,
      }),
      fromWhatsApp: false,
    };
    groups.push(group);
    await writeJSON("groups.json", groups);
    res.status(201).json(group);
  } catch (err) {
    res.status(500).json({ error: "Failed to save group" });
  }
});

app.put("/api/groups/:id", async (req, res) => {
  try {
    const groups = await readJSON("groups.json");
    const idx = groups.findIndex((g) => g.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ error: "Group not found" });
    }
    const prev = groups[idx];
    if (prev.fromWhatsApp === true) {
      return res.status(400).json({ error: "WhatsApp groups cannot be edited here" });
    }
    const { name, contactIds } = req.body;
    const rawIds =
      contactIds !== undefined
        ? Array.isArray(contactIds)
          ? contactIds
          : []
        : prev.contactIds || [];
    const contacts = await readJSON("contacts.json");
    const group = {
      id: req.params.id,
      name: name !== undefined ? name : prev.name,
      contactIds: dedupeGroupContactIds(rawIds, {
        fromWhatsApp: false,
        contacts,
      }),
      fromWhatsApp: false,
    };
    groups[idx] = group;
    await writeJSON("groups.json", groups);
    res.json(group);
  } catch (err) {
    res.status(500).json({ error: "Failed to update group" });
  }
});

app.delete("/api/groups/:id", async (req, res) => {
  try {
    const groups = await readJSON("groups.json");
    const found = groups.find((g) => g.id === req.params.id);
    if (!found) {
      return res.status(404).json({ error: "Group not found" });
    }
    if (found.fromWhatsApp === true) {
      return res.status(400).json({ error: "WhatsApp groups cannot be deleted here" });
    }
    const next = groups.filter((g) => g.id !== req.params.id);
    await writeJSON("groups.json", next);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete group" });
  }
});

app.post("/api/history", async (req, res) => {
  try {
    const entry = req.body;
    await prependHistoryEntry(entry);
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: "Failed to save history" });
  }
});

app.post("/api/send/stop", (req, res) => {
  isStopped = true;
  res.json({ stopped: true });
});

app.post("/api/send", async (req, res) => {
  resetBroadcastProgress();

  const { groupId, message, delaySeconds } = req.body;

  if (groupId == null || String(groupId).trim() === "") {
    return res.status(400).json({ error: "groupId is required" });
  }

  const text = message == null ? "" : String(message).trim();
  if (text === "") {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  const delay = Number(delaySeconds);
  if (!Number.isFinite(delay) || delay < 2 || delay > 10) {
    return res.status(400).json({ error: "delaySeconds must be between 2 and 10" });
  }

  let groups;
  let contacts;
  try {
    groups = await readJSON("groups.json");
    contacts = await readJSON("contacts.json");
  } catch (err) {
    return res.status(500).json({ error: "Failed to read data" });
  }

  const group = groups.find((g) => g.id === groupId);
  if (!group) {
    return res.status(400).json({ error: "Group not found" });
  }

  if (!waReady) {
    return res.status(400).json({ error: "WhatsApp not connected" });
  }

  const contactIds = dedupeGroupContactIds(group.contactIds, {
    fromWhatsApp: group.fromWhatsApp === true,
    contacts,
  });
  /** @type {{ name: string, sendJid: string }[]} */
  let toSend = [];

  if (group.fromWhatsApp === true) {
    for (const jid of contactIds) {
      if (!jid) continue;
      const j = String(jid);
      const sendJid = /@/.test(j) ? j : `${digitsOnly(j)}@c.us`;
      toSend.push({
        name: j.includes("@") ? j.split("@")[0] : digitsOnly(j) || j,
        sendJid,
      });
    }
  } else {
    const byId = new Map(contacts.map((c) => [c.id, c]));
    for (const id of contactIds) {
      const contact = byId.get(id);
      if (!contact) continue;
      const phone = digitsOnly(contact.phone);
      if (!phone) continue;
      toSend.push({
        name: contact.name || phone,
        sendJid: `${phone}@c.us`,
      });
    }
  }

  isStopped = false;
  let sent = 0;
  const delayMs = delay * 1000;
  /** Never send faster than ~2.5s apart to reduce protocol / WA overload. */
  const interMessageMs = Math.max(2500, delayMs);
  const totalRecipients = toSend.length;

  broadcastProgress.active = true;
  broadcastProgress.total = toSend.length;
  broadcastProgress.current = 0;
  broadcastProgress.name = "";
  broadcastProgress.done = false;
  broadcastProgress.sent = 0;

  try {
    for (let i = 0; i < toSend.length; i++) {
      const recipient = toSend[i];
      broadcastProgress.current = i + 1;
      broadcastProgress.name = recipient.name;
      if (isStopped) {
        break;
      }
      try {
        await client.sendMessage(recipient.sendJid, text);
        sent++;
        broadcastProgress.sent = sent;
        console.log(`Sent ${sent}/${totalRecipients}`);
        if (sent % 20 === 0 && i + 1 < toSend.length && !isStopped) {
          console.log(`Breather: ${sent}/${totalRecipients} sent, pausing 10s`);
          await sleep(10000);
        }
      } catch (sendErr) {
        console.error(
          `Send failed for "${recipient.name}" (${recipient.sendJid}):`,
          sendErr && sendErr.message ? sendErr.message : sendErr
        );
      }
      if (isStopped) {
        break;
      }
      await sleep(interMessageMs);
    }

    await prependHistoryEntry({
      groupName: group.name,
      message: text,
      sentAt: new Date().toISOString(),
      count: sent,
    });

    res.json({ success: true, sent: sent });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send messages" });
    }
  } finally {
    broadcastProgress.active = false;
    broadcastProgress.done = true;
    broadcastProgress.sent = sent;
  }
});

app.listen(PORT, () => {
  console.log("Server running on http://localhost:3000");
});

startWhatsAppClient().catch((err) => {
  console.error("WhatsApp client failed to start:", err);
});
