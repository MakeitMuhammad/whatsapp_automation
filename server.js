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
/** @type {'starting'|'qr'|'authenticated'|'ready'|'failed'} */
let waState = "starting";
let waLastError = null;
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
    headless: true,
    args: [
      `--user-agent=${winChromeUserAgent}`,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
    protocolTimeout: 180000,
  },
  waitForInitialPage: false,
  authTimeoutMs: 120000,
});

client.on("qr", async (qr) => {
  waState = "qr";
  waLastError = null;
  try {
    qrDataUrl = await QRCode.toDataURL(qr);
    console.log("WhatsApp QR ready — open http://localhost:3000 to scan");
  } catch (err) {
    console.error(err);
    qrDataUrl = null;
  }
});

client.on("authenticated", () => {
  waState = "authenticated";
  qrDataUrl = null;
  console.log("WhatsApp authenticated — finishing setup…");
});

client.on("ready", () => {
  waReady = true;
  waState = "ready";
  waLastError = null;
  qrDataUrl = null;
  console.log("WhatsApp ready");
  void syncFromWhatsApp().catch((err) => console.error("Sync failed:", err));
});

client.on("auth_failure", (msg) => {
  waReady = false;
  waState = "failed";
  waLastError =
    typeof msg === "string" && msg.trim() ? msg.trim() : "Authentication failed";
  qrDataUrl = null;
  console.error("WhatsApp auth_failure:", waLastError);
});

client.on("disconnected", (reason) => {
  waReady = false;
  waState = "starting";
  qrDataUrl = null;
  console.log("WhatsApp disconnected:", reason || "");
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
  waState = "starting";
  waLastError = null;
  if (process.env.CLEAR_WWEBJS_CACHE === "1") {
    await clearWWebJsCache();
  }
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
  waState = "failed";
  waLastError =
    lastErr && lastErr.message ? lastErr.message : "WhatsApp client failed to start";
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

function parseDelayRangeSeconds(raw) {
  const s = String(raw || "").trim();
  const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    return null;
  }
  return { min, max };
}

function randomDelayMsFromRange(rangeSeconds) {
  const minMs = rangeSeconds.min * 1000;
  const maxMs = rangeSeconds.max * 1000;
  const ms = minMs + Math.random() * (maxMs - minMs);
  return Math.max(2500, Math.round(ms));
}

async function prependHistoryEntry(entry) {
  const history = await readJSON("history.json");
  const next = [entry, ...history].slice(0, 50);
  await writeJSON("history.json", next);
}

function digitsOnly(str) {
  return String(str || "").replace(/\D/g, "");
}

/** Strip @c.us / @s.whatsapp.net suffix; keep digits for matching/storage. */
function phoneFromSerializedOrNumber(serialized, numberField) {
  const s = String(serialized || "");
  const at = s.indexOf("@");
  const base = at >= 0 ? s.slice(0, at) : s;
  const suffix = at >= 0 ? s.slice(at + 1).toLowerCase() : "";
  const fromSerialized = digitsOnly(base);
  const fromNum = digitsOnly(String(numberField || "").replace(/@c\.us$/i, ""));

  // WhatsApp's `number` field can be a LID; prefer the @c.us JID from serialized id.
  if (
    (suffix === "c.us" || suffix === "s.whatsapp.net") &&
    fromSerialized
  ) {
    return fromSerialized;
  }
  return fromNum || fromSerialized || null;
}

/** Phone digits for display/dedupe; prefer @c.us id over a stale LID in `phone`. */
function contactPhoneDigits(contact) {
  if (!contact) return "";
  const id = String(contact.id || "");
  const at = id.indexOf("@");
  if (at > 0) {
    const suffix = id.slice(at + 1).toLowerCase();
    if (suffix === "c.us" || suffix === "s.whatsapp.net") {
      return digitsOnly(id.slice(0, at));
    }
  }
  return digitsOnly(contact.phone);
}

/** JID to pass to sendMessage. */
function sendJidForContact(contact) {
  if (!contact) return null;
  const id = String(contact.id || "").trim();
  if (/@(c\.us|lid|s\.whatsapp\.net)$/i.test(id)) {
    return id;
  }
  const phone = contactPhoneDigits(contact);
  if (!phone) return null;
  return `${phone}@c.us`;
}

function repairContactPhone(row) {
  if (!row || typeof row !== "object") return row;
  const id = String(row.id || "");
  if (!/@c\.us$/i.test(id)) return row;
  const fromId = digitsOnly(id.split("@")[0]);
  if (!fromId) return row;
  if (digitsOnly(row.phone) !== fromId) {
    return { ...row, phone: fromId };
  }
  return row;
}

/** Dedupe group members by normalized phone; keeps first occurrence. */
function dedupeGroupContactIds(contactIds, contacts) {
  if (!Array.isArray(contactIds)) return [];
  const byContactId = new Map((contacts || []).map((c) => [c.id, c]));
  const seenPhones = new Set();
  const seenIds = new Set();
  const out = [];
  for (const raw of contactIds) {
    if (raw == null || raw === "") continue;
    const id = String(raw);
    if (seenIds.has(id)) continue;
    let phoneKey;
    if (id.includes("@")) {
      phoneKey = digitsOnly(id.split("@")[0]);
    } else {
      const c = byContactId.get(id);
      phoneKey = c ? contactPhoneDigits(c) : "";
    }
    if (phoneKey) {
      if (seenPhones.has(phoneKey)) continue;
      seenPhones.add(phoneKey);
    }
    seenIds.add(id);
    out.push(id);
  }
  return out;
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

      const mergedContacts = [...manualOnly, ...waAdds].map(repairContactPhone);
      await writeJSON("contacts.json", mergedContacts);
      console.log(`Synced ${phoneBookContacts.length} contacts from WhatsApp`);
    } catch (err) {
      console.error("WhatsApp contact sync error:", err);
    }

    try {
      const existingGroups = await readJSON("groups.json");
      const manualGroups = existingGroups.filter((g) => g && g.fromWhatsApp !== true);
      if (manualGroups.length !== existingGroups.length) {
        await writeJSON("groups.json", manualGroups);
        console.log(
          `Removed ${existingGroups.length - manualGroups.length} WhatsApp chat groups from storage (tool groups only)`
        );
      }
    } catch (err) {
      console.error("Groups cleanup error:", err);
    }

    try {
      const contactsOut = await readJSON("contacts.json");
      const groupsOut = await readJSON("groups.json");
      const toolGroups = Array.isArray(groupsOut)
        ? groupsOut.filter((g) => g && g.fromWhatsApp !== true)
        : [];
      return {
        contacts: Array.isArray(contactsOut) ? contactsOut.length : 0,
        groups: toolGroups.length,
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
    groupCount = Array.isArray(groups)
      ? groups.filter((g) => g && g.fromWhatsApp !== true).length
      : 0;
  } catch (_) {
    /* use zeros */
  }
  res.json({
    ready: waReady,
    state: waState,
    qr: waReady ? null : qrDataUrl,
    error: waState === "failed" ? waLastError : null,
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

app.post("/api/cache/clear", async (req, res) => {
  try {
    await clearWWebJsCache();
    res.json({
      ok: true,
      message: "WhatsApp Web cache cleared. Restart the server (npm start) before syncing again.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to clear cache" });
  }
});

app.post("/api/contacts/clear-synced", async (req, res) => {
  if (broadcastProgress.active) {
    return res.status(400).json({ error: "Cannot clear contacts while a broadcast is running" });
  }
  try {
    const contacts = await readJSON("contacts.json");
    const list = Array.isArray(contacts) ? contacts : [];
    const removedIds = new Set(
      list.filter((c) => c && c.fromWhatsApp === true).map((c) => String(c.id))
    );
    const remaining = list.filter((c) => !c || c.fromWhatsApp !== true);
    const removed = list.length - remaining.length;

    await writeJSON("contacts.json", remaining);

    let groupsPruned = 0;
    try {
      const groups = await readJSON("groups.json");
      const nextGroups = (Array.isArray(groups) ? groups : []).map((g) => {
        if (!g || !Array.isArray(g.contactIds)) return g;
        const before = g.contactIds.length;
        const contactIds = g.contactIds.filter((id) => !removedIds.has(String(id)));
        if (contactIds.length !== before) groupsPruned += 1;
        return { ...g, contactIds };
      });
      await writeJSON("groups.json", nextGroups);
    } catch (groupsErr) {
      console.error("Groups update after clear-synced:", groupsErr);
    }

    res.json({ ok: true, removed, groupsPruned });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to clear synced contacts" });
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
    res.json(groups.filter((g) => g && g.fromWhatsApp !== true));
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
    const [groups, contacts] = await Promise.all([
      readJSON("groups.json"),
      readJSON("contacts.json"),
    ]);
    const group = {
      id: crypto.randomUUID(),
      name,
      contactIds: dedupeGroupContactIds(
        Array.isArray(contactIds) ? contactIds : [],
        contacts
      ),
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
    const contacts = await readJSON("contacts.json");
    const rawIds =
      contactIds !== undefined
        ? Array.isArray(contactIds)
          ? contactIds
          : []
        : prev.contactIds || [];
    const group = {
      id: req.params.id,
      name: name !== undefined ? name : prev.name,
      contactIds: dedupeGroupContactIds(rawIds, contacts),
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

  const { groupId, message, delayRange } = req.body;

  if (groupId == null || String(groupId).trim() === "") {
    return res.status(400).json({ error: "groupId is required" });
  }

  const text = message == null ? "" : String(message).trim();
  if (text === "") {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  const allowedRanges = new Set(["10-15", "15-20", "20-30", "30-45"]);
  const selectedRange = String(delayRange || "").trim();
  if (!allowedRanges.has(selectedRange)) {
    return res
      .status(400)
      .json({ error: "delayRange must be one of: 10-15, 15-20, 20-30, 30-45" });
  }
  const delayRangeSeconds = parseDelayRangeSeconds(selectedRange);
  if (!delayRangeSeconds) {
    return res.status(400).json({ error: "Invalid delayRange format" });
  }

  let groups;
  let contacts;
  try {
    groups = await readJSON("groups.json");
    const rawContacts = await readJSON("contacts.json");
    let contactsNeedSave = false;
    contacts = rawContacts.map((row) => {
      const fixed = repairContactPhone(row);
      if (fixed !== row) contactsNeedSave = true;
      return fixed;
    });
    if (contactsNeedSave) {
      await writeJSON("contacts.json", contacts);
    }
  } catch (err) {
    return res.status(500).json({ error: "Failed to read data" });
  }

  const group = groups.find((g) => g.id === groupId);
  if (!group) {
    return res.status(400).json({ error: "Group not found" });
  }
  if (group.fromWhatsApp === true) {
    return res.status(400).json({ error: "Only groups created in this tool can be used for sending" });
  }

  if (!waReady) {
    return res.status(400).json({ error: "WhatsApp not connected" });
  }

  const contactIds = Array.isArray(group.contactIds) ? group.contactIds : [];
  /** @type {{ name: string, sendJid: string }[]} */
  let toSend = [];

  const seenSendJids = new Set();
  const byId = new Map(contacts.map((c) => [c.id, c]));
  for (const id of contactIds) {
    const contact = byId.get(id);
    if (!contact) continue;
    const sendJid = sendJidForContact(contact);
    if (!sendJid) continue;
    if (seenSendJids.has(sendJid)) continue;
    seenSendJids.add(sendJid);
    const phone = contactPhoneDigits(contact);
    toSend.push({
      name: contact.name || phone || sendJid,
      sendJid,
    });
  }

  isStopped = false;
  let sent = 0;
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
      if (i + 1 < toSend.length) {
        const interMessageMs = randomDelayMsFromRange(delayRangeSeconds);
        const shownSeconds = (interMessageMs / 1000).toFixed(1);
        console.log(`Waiting ${shownSeconds}s before next message`);
        await sleep(interMessageMs);
      }
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
  if (waState !== "failed") {
    waState = "failed";
    waLastError = err && err.message ? err.message : "WhatsApp client failed to start";
  }
  console.error("WhatsApp client failed to start:", err);
});
