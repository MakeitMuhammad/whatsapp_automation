(function () {
  "use strict";

  /** @type {{ id: string, name: string, phone: string }[]} */
  let contacts = [];
  /** @type {{ id: string, name: string, contactIds: string[] }[]} */
  let groups = [];
  /** @type {{ id: string, name: string, contactIds: string[] } | null} */
  let selectedGroup = null;
  /** @type {string | null} */
  let expandedGroupId = null;
  /** @type {"new" | "edit" | null} */
  let groupModalMode = null;
  /** @type {string | null} */
  let editingGroupId = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let sendProgressTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let sendProgressTimeout = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let waStatusTimer = null;
  let sendUserStopped = false;
  let sendInFlight = false;
  let progressPollGen = 0;
  let lastWaReady = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let toastTimer = null;
  /** @type {Set<string>} */
  let groupModalLastVisibleIds = new Set();
  let groupModalSearchHadQuery = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let groupModalSearchTimer = null;
  let groupModalSearchSeq = 0;

  const els = {
    mainUi: document.getElementById("main-ui"),
    waQrOverlay: document.getElementById("wa-qr-overlay"),
    waQrImg: document.getElementById("wa-qr-img"),
    tabs: document.querySelectorAll(".tab"),
    panelContacts: document.getElementById("panel-contacts"),
    panelGroups: document.getElementById("panel-groups"),
    panelSend: document.getElementById("panel-send"),
    contactSearch: document.getElementById("contact-search"),
    contactList: document.getElementById("contact-list"),
    addContactForm: document.getElementById("add-contact-form"),
    addName: document.getElementById("add-name"),
    addPhone: document.getElementById("add-phone"),
    importCsvBtn: document.getElementById("import-csv-btn"),
    syncWaBtn: document.getElementById("sync-wa-btn"),
    csvInput: document.getElementById("csv-input"),
    groupList: document.getElementById("group-list"),
    newGroupBtn: document.getElementById("new-group-btn"),
    groupModal: document.getElementById("group-modal"),
    groupModalTitle: document.getElementById("group-modal-title"),
    groupModalName: document.getElementById("group-modal-name"),
    groupModalContacts: document.getElementById("group-modal-contacts"),
    groupModalSave: document.getElementById("group-modal-save"),
    groupModalSearch: document.getElementById("group-modal-search"),
    groupModalHint: document.getElementById("group-modal-hint"),
    sendSelection: document.getElementById("send-selection"),
    sendMessage: document.getElementById("send-message"),
    charCount: document.getElementById("char-count"),
    sendBtn: document.getElementById("send-btn"),
    sendDelay: document.getElementById("send-delay"),
    sendProgress: document.getElementById("send-progress"),
    sendProgressText: document.getElementById("send-progress-text"),
    sendProgressFill: document.getElementById("send-progress-fill"),
    sendStopBtn: document.getElementById("send-stop-btn"),
    toast: document.getElementById("toast"),
  };

  function digitsOnly(str) {
    return String(str || "").replace(/\D/g, "");
  }

  function isValidPhoneDigits(d) {
    return d.length >= 7 && d.length <= 15;
  }

  /**
   * @param {string} url
   * @param {RequestInit} [options]
   */
  async function apiJson(url, options = {}) {
    const headers = { Accept: "application/json", ...options.headers };
    if (options.body && typeof options.body === "string") {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!res.ok) {
      const msg =
        data && typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  function showToast(message, kind = "info") {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.remove("hidden", "toast-error");
    if (kind === "error") els.toast.classList.add("toast-error");
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.add("hidden");
      toastTimer = null;
    }, 4200);
  }

  async function runPostConnectSync() {
    showToast("WhatsApp connected — syncing...", "info");
    try {
      const r = await apiJson("/api/sync", { method: "POST" });
      const c = typeof r.contacts === "number" ? r.contacts : 0;
      const g = typeof r.groups === "number" ? r.groups : 0;
      showToast(`Synced ${c} contacts and ${g} groups`, "info");
      await refreshAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Sync failed", "error");
    }
  }

  function clearSendProgressPoll() {
    if (sendProgressTimeout !== null) {
      clearTimeout(sendProgressTimeout);
      sendProgressTimeout = null;
    }
    if (sendProgressTimer !== null) {
      clearInterval(sendProgressTimer);
      sendProgressTimer = null;
    }
  }

  function applyProgressFromServer(p) {
    const total = typeof p.total === "number" ? p.total : 0;
    const current = typeof p.current === "number" ? p.current : 0;
    const name = typeof p.name === "string" ? p.name : "";

    if (p.active && total > 0) {
      els.sendProgressText.textContent = `Sending ${current} of ${total} — ${name}`;
    } else if (p.active && total === 0) {
      els.sendProgressText.textContent = "Preparing…";
    }

    let pct = 0;
    if (p.done) {
      pct = 100;
    } else if (total > 0) {
      pct = Math.min(100, Math.round((current / total) * 100));
    }
    els.sendProgressFill.style.width = pct + "%";
  }

  async function pollProgressOnce(gen) {
    if (gen !== progressPollGen) return;
    try {
      const res = await fetch("/api/progress");
      if (gen !== progressPollGen) return;
      if (!res.ok) return;
      const p = await res.json();
      if (gen !== progressPollGen) return;

      if (p.done) {
        clearSendProgressPoll();
        if (gen !== progressPollGen) return;
        if (!sendUserStopped) {
          const sent = typeof p.sent === "number" ? p.sent : 0;
          els.sendProgressText.textContent = `Done! Sent to ${sent} contact${sent === 1 ? "" : "s"}`;
        }
        els.sendProgressFill.style.width = "100%";
        els.sendStopBtn.hidden = true;
        sendInFlight = false;
        updateSendButton();
        return;
      }

      applyProgressFromServer(p);
      els.sendStopBtn.hidden = false;
    } catch {
      /* ignore transient network errors */
    }
  }

  function startSendProgressPoll() {
    clearSendProgressPoll();
    progressPollGen += 1;
    const gen = progressPollGen;
    sendProgressTimeout = setTimeout(() => {
      sendProgressTimeout = null;
      void pollProgressOnce(gen);
      sendProgressTimer = setInterval(() => {
        void pollProgressOnce(gen);
      }, 1000);
    }, 150);
  }

  /**
   * @returns {Promise<boolean>} true if WhatsApp is ready
   */
  async function syncWaOverlay() {
    const res = await fetch("/api/status");
    if (!res.ok) {
      throw new Error("status");
    }
    const s = await res.json();
    const wasReady = lastWaReady;
    const nowReady = !!s.ready;

    if (nowReady) {
      els.waQrOverlay.classList.add("hidden");
      els.waQrOverlay.setAttribute("aria-hidden", "true");
      els.mainUi.classList.remove("main-ui-hidden");
      if (waStatusTimer !== null) {
        clearInterval(waStatusTimer);
        waStatusTimer = null;
      }
      lastWaReady = true;
      if (!wasReady) {
        void runPostConnectSync();
      }
      return true;
    }

    lastWaReady = false;
    if (s.qr) {
      els.waQrImg.src = s.qr;
      els.waQrOverlay.classList.remove("hidden");
      els.waQrOverlay.setAttribute("aria-hidden", "false");
      els.mainUi.classList.add("main-ui-hidden");
    } else {
      els.waQrOverlay.classList.add("hidden");
      els.waQrOverlay.setAttribute("aria-hidden", "true");
      els.mainUi.classList.remove("main-ui-hidden");
    }
    return false;
  }

  async function initWaConnection() {
    try {
      const ready = await syncWaOverlay();
      if (ready) return;
    } catch {
      els.mainUi.classList.remove("main-ui-hidden");
    }
    if (waStatusTimer === null) {
      waStatusTimer = setInterval(() => {
        void syncWaOverlay().catch(() => {});
      }, 3000);
    }
  }

  function setTab(tabId) {
    els.tabs.forEach((btn) => {
      const on = btn.dataset.tab === tabId;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    els.panelContacts.classList.toggle("active", tabId === "contacts");
    els.panelGroups.classList.toggle("active", tabId === "groups");
    els.panelSend.classList.toggle("active", tabId === "send");
  }

  function contactById(id) {
    return contacts.find((c) => c.id === id);
  }

  function displayParticipantName(participantId) {
    const c = contactById(participantId);
    if (c) return c.name;
    if (typeof participantId === "string" && participantId.includes("@")) {
      return participantId.split("@")[0];
    }
    return "Unknown";
  }

  function getFilteredContacts() {
    const q = els.contactSearch.value.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const name = (c.name || "").toLowerCase();
      const phone = (c.phone || "").toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }

  function renderContacts() {
    const list = getFilteredContacts();
    if (list.length === 0) {
      els.contactList.innerHTML =
        '<p class="empty-hint">' +
        (contacts.length === 0 ? "No contacts yet." : "No matches.") +
        "</p>";
      return;
    }
    els.contactList.innerHTML = list
      .map((c) => {
        const waDot =
          c.fromWhatsApp === true ? '<span class="wa-dot" title="From WhatsApp"></span>' : "";
        return `
        <div class="contact-row" data-contact-id="${escapeAttr(c.id)}">
          <div class="contact-body">
            <div class="contact-name-row">
              ${waDot}
              <div class="contact-name">${escapeHtml(c.name)}</div>
            </div>
            <div class="contact-phone">${escapeHtml(c.phone)}</div>
          </div>
          <button type="button" class="btn btn-danger" data-action="delete-contact">Delete</button>
        </div>`;
      })
      .join("");
  }

  function memberNamesForGroup(group) {
    const ids = group.contactIds || [];
    return ids.map((id) => displayParticipantName(id));
  }

  function renderGroups() {
    const list = groups.filter((g) => g.fromWhatsApp !== true);
    if (expandedGroupId && !list.some((g) => g.id === expandedGroupId)) {
      expandedGroupId = null;
    }
    if (list.length === 0) {
      els.groupList.innerHTML =
        '<p class="empty-hint">No groups yet — tap <strong>Create group</strong>, search your contacts, uncheck anyone to skip, then save.</p>';
      return;
    }
    els.groupList.innerHTML = list
      .map((g) => {
        const count = (g.contactIds || []).length;
        const expanded = expandedGroupId === g.id;
        const names = memberNamesForGroup(g);
        const membersHtml =
          names.length === 0
            ? '<p class="empty-hint group-members-empty">No members.</p>'
            : "<ul>" + names.map((n) => "<li>" + escapeHtml(n) + "</li>").join("") + "</ul>";
        return `
        <div class="group-row${expanded ? " expanded" : ""}" data-group-id="${escapeAttr(g.id)}">
          <button type="button" class="group-row-head" data-action="toggle-group">
            <span class="chevron">▶</span>
            <span class="group-name">${escapeHtml(g.name)}</span>
            <span class="badge">${count}</span>
          </button>
          ${
            expanded
              ? `<div class="group-members">${membersHtml}</div>
            <div class="group-actions">
              <button type="button" class="btn btn-ghost" data-action="select-group">Select</button>
              <button type="button" class="btn btn-ghost" data-action="edit-group">Edit</button>
              <button type="button" class="btn btn-danger" data-action="delete-group">Delete</button>
            </div>`
              : `<div class="group-actions">
              <button type="button" class="btn btn-ghost" data-action="select-group">Select</button>
              <button type="button" class="btn btn-ghost" data-action="edit-group">Edit</button>
              <button type="button" class="btn btn-danger" data-action="delete-group">Delete</button>
            </div>`
          }
        </div>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function renderSendSelection() {
    if (!selectedGroup) {
      els.sendSelection.innerHTML = "<span>No group selected.</span> Go to <strong>Groups</strong> and tap <strong>Select</strong> on a group.";
      return;
    }
    const n = (selectedGroup.contactIds || []).length;
    els.sendSelection.innerHTML = `Sending to <strong>${escapeHtml(selectedGroup.name)}</strong> — <strong>${n}</strong> recipient${n === 1 ? "" : "s"}.`;
  }

  function updateSendButton() {
    const msg = els.sendMessage.value;
    const ok = !!(selectedGroup && msg.trim().length > 0 && !sendInFlight);
    els.sendBtn.disabled = !ok;
  }

  function updateCharCount() {
    const len = els.sendMessage.value.length;
    els.charCount.textContent = String(len);
  }

  async function loadContacts() {
    contacts = await apiJson("/api/contacts");
    renderContacts();
  }

  async function loadGroups() {
    groups = await apiJson("/api/groups");
    if (selectedGroup) {
      const g = groups.find((x) => x.id === selectedGroup.id);
      if (!g || g.fromWhatsApp === true) {
        selectedGroup = null;
        renderSendSelection();
        updateSendButton();
      }
    }
    renderGroups();
  }

  async function refreshAll() {
    await Promise.all([loadContacts(), loadGroups()]);
    renderSendSelection();
    updateSendButton();
  }

  function openGroupModal(mode, group) {
    groupModalSearchSeq += 1;
    groupModalMode = mode;
    editingGroupId = group ? group.id : null;
    els.groupModal.classList.remove("hidden");
    els.groupModalName.value = group ? group.name : "";
    if (els.groupModalSearch) {
      els.groupModalSearch.value = "";
      els.groupModalSearch.disabled = contacts.length === 0;
    }
    if (els.groupModalHint) {
      els.groupModalHint.textContent =
        mode === "new"
          ? "Search matches names from the start only (case-insensitive), e.g. \"spain\" or \"spain bir24\". Matches appear below and are selected automatically — uncheck anyone you do not want, enter a group name, then create."
          : "Search filters by the start of each contact's name only (case-insensitive). Check or uncheck contacts to change who is in this group.";
    }
    groupModalLastVisibleIds = new Set();
    groupModalSearchHadQuery = false;
    if (groupModalSearchTimer !== null) {
      clearTimeout(groupModalSearchTimer);
      groupModalSearchTimer = null;
    }
    if (mode === "new") {
      els.groupModalTitle.textContent = "Create group";
      els.groupModalSave.textContent = "Create group";
    } else {
      els.groupModalTitle.textContent = "Edit group";
      els.groupModalSave.textContent = "Save changes";
    }
    const selected = new Set(group && group.contactIds ? group.contactIds : []);
    if (contacts.length === 0) {
      els.groupModalContacts.innerHTML = '<p class="empty-hint">Add contacts first.</p>';
    } else {
      const rowHidden = mode === "new" ? " hidden" : "";
      els.groupModalContacts.innerHTML = contacts
        .map((c) => {
          const checked = selected.has(c.id) ? " checked" : "";
          return `<div class="modal-contact-row${rowHidden}" data-contact-id="${escapeAttr(c.id)}">
            <label class="check-row">
              <input type="checkbox" data-contact-id="${escapeAttr(c.id)}"${checked} />
              <span>${escapeHtml(c.name)} <span class="muted-inline">(${escapeHtml(c.phone)})</span></span>
            </label>
          </div>`;
        })
        .join("");
    }
    if (mode === "new" && contacts.length > 0) {
      els.groupModalSearch.focus();
    } else {
      els.groupModalName.focus();
    }
  }

  function closeGroupModal() {
    groupModalSearchSeq += 1;
    if (groupModalSearchTimer !== null) {
      clearTimeout(groupModalSearchTimer);
      groupModalSearchTimer = null;
    }
    if (els.groupModalSearch) {
      els.groupModalSearch.value = "";
    }
    groupModalLastVisibleIds = new Set();
    groupModalSearchHadQuery = false;
    els.groupModal.classList.add("hidden");
    if (els.groupModalHint) {
      els.groupModalHint.textContent = "";
    }
    groupModalMode = null;
    editingGroupId = null;
  }

  function getModalSelectedContactIds() {
    const boxes = els.groupModalContacts.querySelectorAll('input[type="checkbox"][data-contact-id]');
    const ids = [];
    boxes.forEach((input) => {
      if (input.checked) ids.push(input.getAttribute("data-contact-id"));
    });
    return ids;
  }

  /** Create Group search: case-insensitive prefix on contact name only (full query must match start of name). */
  function matchesGroupModalNamePrefix(c, qLower) {
    const name = String((c && c.name) || "").trim().toLowerCase();
    return name.startsWith(qLower);
  }

  function applyGroupModalSearch() {
    if (!els.groupModalSearch) return;
    const seq = ++groupModalSearchSeq;
    const qRaw = els.groupModalSearch.value;
    const q = qRaw.trim().toLowerCase();
    const rows = els.groupModalContacts.querySelectorAll(".modal-contact-row");

    if (rows.length === 0) return;

    if (q === "") {
      rows.forEach((row) => {
        if (groupModalMode === "new") {
          row.classList.add("hidden");
          const input = row.querySelector("input[type=checkbox]");
          if (input) input.checked = false;
        } else {
          row.classList.remove("hidden");
          if (groupModalSearchHadQuery) {
            const input = row.querySelector("input[type=checkbox]");
            if (input) input.checked = false;
          }
        }
      });
      groupModalSearchHadQuery = false;
      groupModalLastVisibleIds = new Set();
      return;
    }

    groupModalSearchHadQuery = true;

    const matchedIds = new Set(
      contacts.filter((c) => matchesGroupModalNamePrefix(c, q)).map((c) => c.id)
    );

    if (seq !== groupModalSearchSeq) return;
    if (els.groupModalSearch.value.trim() === "") {
      rows.forEach((row) => {
        if (groupModalMode === "new") {
          row.classList.add("hidden");
          const input = row.querySelector("input[type=checkbox]");
          if (input) input.checked = false;
        } else {
          row.classList.remove("hidden");
          if (groupModalSearchHadQuery) {
            const input = row.querySelector("input[type=checkbox]");
            if (input) input.checked = false;
          }
        }
      });
      groupModalSearchHadQuery = false;
      groupModalLastVisibleIds = new Set();
      return;
    }

    const visibleIds = new Set();
    rows.forEach((row) => {
      const id = row.getAttribute("data-contact-id");
      if (!id) return;
      const show = matchedIds.has(id);
      row.classList.toggle("hidden", !show);
      if (show) visibleIds.add(id);
    });

    visibleIds.forEach((id) => {
      if (groupModalLastVisibleIds.has(id)) return;
      rows.forEach((row) => {
        if (row.getAttribute("data-contact-id") === id) {
          const input = row.querySelector("input[type=checkbox]");
          if (input) input.checked = true;
        }
      });
    });

    groupModalLastVisibleIds = visibleIds;
  }

  function scheduleGroupModalSearch() {
    if (groupModalSearchTimer !== null) clearTimeout(groupModalSearchTimer);
    groupModalSearchTimer = setTimeout(() => {
      groupModalSearchTimer = null;
      applyGroupModalSearch();
    }, 280);
  }

  /** Simple CSV line split respecting quoted fields */
  function parseCsvLine(line) {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if ((ch === "," && !inQuotes) || (ch === "\r" && !inQuotes)) {
        if (ch === "\r") continue;
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function parseContactsCsv(text) {
    const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    if (lines.length < 2) {
      throw new Error("CSV needs a header row and at least one data row.");
    }
    const headerParts = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
    const nameIdx = headerParts.indexOf("name");
    const phoneIdx = headerParts.indexOf("phone");
    if (nameIdx === -1 || phoneIdx === -1) {
      throw new Error('Header must include "Name" and "Phone" columns.');
    }
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const parts = parseCsvLine(lines[i]);
      if (parts.length < 2) continue;
      const name = parts[nameIdx] || "";
      const phoneRaw = parts[phoneIdx] || "";
      const digits = digitsOnly(phoneRaw);
      if (!String(name).trim() || !isValidPhoneDigits(digits)) continue;
      rows.push({ name: String(name).trim(), phone: digits });
    }
    return rows;
  }

  async function importCsvFile(file) {
    const text = await file.text();
    let rows;
    try {
      rows = parseContactsCsv(text);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Invalid CSV.");
      return;
    }
    let imported = 0;
    for (const row of rows) {
      try {
        await apiJson("/api/contacts", {
          method: "POST",
          body: JSON.stringify({ name: row.name, phone: row.phone }),
        });
        imported++;
      } catch (e) {
        alert(e instanceof Error ? e.message : "Import failed.");
        await loadContacts();
        return;
      }
    }
    await loadContacts();
    alert(`Imported ${imported} contacts`);
  }

  els.tabs.forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });

  els.contactSearch.addEventListener("input", () => renderContacts());

  els.contactList.addEventListener("click", async (e) => {
    const del = e.target.closest("[data-action='delete-contact']");
    if (!del) return;
    const row = del.closest("[data-contact-id]");
    const id = row && row.getAttribute("data-contact-id");
    if (!id) return;
    try {
      await apiJson("/api/contacts/" + encodeURIComponent(id), { method: "DELETE" });
      await loadContacts();
      await loadGroups();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    }
  });

  els.addContactForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = els.addName.value.trim();
    const digits = digitsOnly(els.addPhone.value);
    if (!name) {
      alert("Name is required.");
      return;
    }
    if (!isValidPhoneDigits(digits)) {
      alert("Phone must be 7–15 digits (non-digits are ignored).");
      return;
    }
    try {
      await apiJson("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ name, phone: digits }),
      });
      els.addName.value = "";
      els.addPhone.value = "";
      await loadContacts();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed.");
    }
  });

  els.importCsvBtn.addEventListener("click", () => els.csvInput.click());
  els.csvInput.addEventListener("change", async () => {
    const file = els.csvInput.files && els.csvInput.files[0];
    els.csvInput.value = "";
    if (!file) return;
    try {
      await importCsvFile(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Could not read file.");
    }
  });

  async function runManualSync() {
    if (!els.syncWaBtn) return;
    els.syncWaBtn.disabled = true;
    els.syncWaBtn.classList.add("loading");
    try {
      const r = await apiJson("/api/sync", { method: "POST" });
      const c = typeof r.contacts === "number" ? r.contacts : 0;
      const g = typeof r.groups === "number" ? r.groups : 0;
      showToast(`Synced ${c} contacts and ${g} groups`, "info");
      await refreshAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      els.syncWaBtn.disabled = false;
      els.syncWaBtn.classList.remove("loading");
    }
  }

  if (els.syncWaBtn) {
    els.syncWaBtn.addEventListener("click", () => {
      void runManualSync();
    });
  }

  els.newGroupBtn.addEventListener("click", () => openGroupModal("new", null));

  els.groupList.addEventListener("click", async (e) => {
    const toggle = e.target.closest("[data-action='toggle-group']");
    if (toggle) {
      const row = toggle.closest("[data-group-id]");
      const id = row && row.getAttribute("data-group-id");
      if (!id) return;
      expandedGroupId = expandedGroupId === id ? null : id;
      renderGroups();
      return;
    }

    const selectBtn = e.target.closest("[data-action='select-group']");
    if (selectBtn) {
      const row = selectBtn.closest("[data-group-id]");
      const id = row && row.getAttribute("data-group-id");
      const g = groups.find((x) => x.id === id);
      if (g) {
        selectedGroup = {
          id: g.id,
          name: g.name,
          contactIds: [...(g.contactIds || [])],
        };
        renderSendSelection();
        updateSendButton();
        setTab("send");
      }
      return;
    }

    const editBtn = e.target.closest("[data-action='edit-group']");
    if (editBtn) {
      const row = editBtn.closest("[data-group-id]");
      const id = row && row.getAttribute("data-group-id");
      const g = groups.find((x) => x.id === id);
      if (g && g.fromWhatsApp === true) return;
      if (g) openGroupModal("edit", g);
      return;
    }

    const delBtn = e.target.closest("[data-action='delete-group']");
    if (delBtn) {
      const row = delBtn.closest("[data-group-id]");
      const id = row && row.getAttribute("data-group-id");
      if (!id) return;
      try {
        await apiJson("/api/groups/" + encodeURIComponent(id), { method: "DELETE" });
        if (selectedGroup && selectedGroup.id === id) {
          selectedGroup = null;
          renderSendSelection();
          updateSendButton();
        }
        if (expandedGroupId === id) expandedGroupId = null;
        await loadGroups();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Delete failed.");
      }
    }
  });

  if (els.groupModalSearch) {
    els.groupModalSearch.addEventListener("input", scheduleGroupModalSearch);
  }

  els.groupModal.addEventListener("click", (e) => {
    if (e.target.closest("[data-modal-close]")) closeGroupModal();
  });

  els.groupModalSave.addEventListener("click", async () => {
    const name = els.groupModalName.value.trim();
    if (!name) {
      alert("Group name is required.");
      return;
    }
    const contactIds = getModalSelectedContactIds();
    if (groupModalMode === "new" && contactIds.length === 0) {
      alert("Select at least one contact. Use the search box to find people, then create the group.");
      return;
    }
    try {
      if (groupModalMode === "new") {
        await apiJson("/api/groups", {
          method: "POST",
          body: JSON.stringify({ name, contactIds }),
        });
      } else if (groupModalMode === "edit" && editingGroupId) {
        await apiJson("/api/groups/" + encodeURIComponent(editingGroupId), {
          method: "PUT",
          body: JSON.stringify({ name, contactIds }),
        });
        if (selectedGroup && selectedGroup.id === editingGroupId) {
          selectedGroup.name = name;
          selectedGroup.contactIds = [...contactIds];
          renderSendSelection();
          updateSendButton();
        }
      }
      closeGroupModal();
      await loadGroups();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Save failed.");
    }
  });

  els.sendMessage.addEventListener("input", () => {
    updateCharCount();
    updateSendButton();
  });

  els.sendStopBtn.addEventListener("click", async () => {
    sendUserStopped = true;
    progressPollGen += 1;
    clearSendProgressPoll();
    try {
      const res = await fetch("/api/send/stop", { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        const msg = data && data.error ? data.error : "Stop request failed.";
        alert(msg);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Stop request failed.");
    }
    els.sendProgressText.textContent = "Stopped.";
    els.sendProgressFill.style.width = "100%";
    els.sendStopBtn.hidden = true;
    sendInFlight = false;
    updateSendButton();
  });

  els.sendBtn.addEventListener("click", () => {
    if (!selectedGroup || !els.sendMessage.value.trim() || sendInFlight) return;

    const message = els.sendMessage.value.trim();
    const delaySeconds = Number(els.sendDelay.value);
    const body = JSON.stringify({
      groupId: selectedGroup.id,
      message,
      delaySeconds,
    });

    sendUserStopped = false;
    sendInFlight = true;
    updateSendButton();

    els.sendProgress.classList.remove("hidden");
    els.sendProgressText.textContent = "Starting…";
    els.sendProgressFill.style.width = "0%";
    els.sendStopBtn.hidden = false;

    startSendProgressPoll();

    fetch("/api/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    })
      .then(async (res) => {
        const text = await res.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        if (!res.ok) {
          progressPollGen += 1;
          clearSendProgressPoll();
          els.sendProgress.classList.add("hidden");
          sendInFlight = false;
          updateSendButton();
          const msg =
            data && typeof data.error === "string" ? data.error : `Send failed (${res.status})`;
          alert(msg);
        }
      })
      .catch((err) => {
        progressPollGen += 1;
        clearSendProgressPoll();
        els.sendProgress.classList.add("hidden");
        sendInFlight = false;
        updateSendButton();
        alert(err instanceof Error ? err.message : "Network error.");
      });
  });

  async function boot() {
    try {
      await initWaConnection();
    } catch {
      els.mainUi.classList.remove("main-ui-hidden");
    }
    try {
      await refreshAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load data.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void boot();
    });
  } else {
    void boot();
  }
})();
