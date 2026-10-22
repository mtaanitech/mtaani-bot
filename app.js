const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
let mode = "login";
let currentUser = null;
let config = { amountKes: 500, currency: "KES" };
let pollTimer = null;

function message(target, text, error = false) {
  const el = typeof target === "string" ? $(target) : target;
  el.textContent = text;
  el.classList.remove("hidden", "error");
  if (error) el.classList.add("error");
}
function hide(target) { (typeof target === "string" ? $(target) : target).classList.add("hidden"); }

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function setAuthMode(next) {
  mode = next;
  $("#loginTab").classList.toggle("active", mode === "login");
  $("#registerTab").classList.toggle("active", mode === "register");
  $("#authSubmit").textContent = mode === "login" ? "Log in" : "Create account";
  $("#authForm [name=password]").autocomplete = mode === "login" ? "current-password" : "new-password";
  $("#authForm [name=password]").minLength = mode === "login" ? 1 : 12;
  hide("#authMessage");
}
$("#loginTab").addEventListener("click", () => setAuthMode("login"));
$("#registerTab").addEventListener("click", () => setAuthMode("register"));

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  hide("#authMessage");
  const form = new FormData(event.currentTarget);
  try {
    const data = await api(`/api/auth/${mode === "login" ? "login" : "register"}`, {
      method: "POST",
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
    });
    currentUser = data.user;
    await enterApp();
  } catch (err) { message("#authMessage", err.message, true); }
});

async function loadConfig() {
  try {
    config = await api("/api/config");
    $("#planPrice").textContent = `${config.currency} ${Number(config.amountKes).toLocaleString()}`;
    $("#billingPrice").innerHTML = `<strong>${config.currency} ${Number(config.amountKes).toLocaleString()}</strong> <span>/ month</span>`;
  } catch {}
}

async function enterApp() {
  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");
  await loadConfig();
  await refreshMe();
  if (location.search.includes("payment=callback")) {
    const url = new URL(location.href);
    const reference = url.searchParams.get("reference") || url.searchParams.get("trxref");
    if (reference) {
      try {
        await api(`/api/payments/verify/${encodeURIComponent(reference)}`);
        message("#globalMessage", "Payment verified. Your subscription has been updated.");
        await refreshMe();
      } catch (err) { message("#globalMessage", err.message, true); }
    }
    history.replaceState({}, "", "/");
  }
}

async function refreshMe() {
  const data = await api("/api/me");
  currentUser = data.user;
  const sub = data.subscription || {};
  const wa = data.whatsapp || {};
  const github = data.github;
  const wallet = data.wallet || { balance: 0 };
  $("#walletBalance").textContent = Number(wallet.balance || 0).toLocaleString();
  $("#sidebarEmail").textContent = currentUser.email;
  $("#roleBadge").textContent = currentUser.role.toUpperCase();
  $("#adminNav").classList.toggle("hidden", currentUser.role !== "admin");
  $("#subStatus").textContent = sub.status === "active" ? "Active" : "Inactive";
  $("#subUntil").textContent = sub.current_period_end ? `Until ${new Date(sub.current_period_end).toLocaleDateString()}` : "Choose a monthly plan to connect.";
  $("#botStatus").textContent = wa.status || "Disconnected";
  $("#repoStatus").textContent = github ? "Linked" : "Not linked";
  $("#sessionStatus").textContent = wa.status || "Disconnected";
  $("#statusDot").style.background = wa.status === "connected" ? "var(--green2)" : "var(--muted)";
  $("#connectTitle").textContent = wa.status === "connected" ? "WhatsApp connected" : "Connect WhatsApp";
  $("#connectDescription").textContent = wa.status === "connected" ? "Your session is connected." : "Choose QR or phone pairing code.";
  $("#sessionError").textContent = wa.lastError || "";
  if (wa.qrDataUrl) {
    $("#qrImage").src = wa.qrDataUrl;
    $("#qrWrap").classList.remove("hidden");
  }
  if (wa.pairingCode) {
    $("#pairCode").textContent = wa.pairingCode;
    $("#pairWrap").classList.remove("hidden");
  }
  if (github) message("#githubCurrent", `Linked: ${github.repo_url} (branch: ${github.branch})`);
  else hide("#githubCurrent");
  if (currentUser.role === "admin") await loadAdmin();
}

function showView(name) {
  $$(".view").forEach(el => el.classList.add("hidden"));
  $(`#view-${name}`).classList.remove("hidden");
  $$(".nav[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === name));
  const labels = {
    dashboard: ["Dashboard", "Manage your bot from one place."],
    whatsapp: ["WhatsApp linking", "Connect using QR or phone pairing code."],
    github: ["Link GitHub code", "Save your repository and branch."],
    billing: ["Subscription", "Manage your monthly hosting plan."],
    admin: ["Admin panel", "Manage users and monitor the platform."]
  };
  $("#pageTitle").textContent = labels[name][0];
  $("#pageSubtitle").textContent = labels[name][1];
  if (name === "whatsapp") startPolling();
  else stopPolling();
  if (name === "admin") loadAdmin().catch(err => message("#globalMessage", err.message, true));
}
$$(".nav[data-view]").forEach(el => el.addEventListener("click", () => showView(el.dataset.view)));
$$("[data-go]").forEach(el => el.addEventListener("click", () => showView(el.dataset.go)));

$("#logoutBtn").addEventListener("click", logout);
$("#mobileLogout").addEventListener("click", logout);
async function logout() {
  stopPolling();
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch {}
  $("#appView").classList.add("hidden");
  $("#authView").classList.remove("hidden");
  currentUser = null;
  $("#authForm").reset();
}

async function startWhatsApp(mode, phoneNumber = "") {
  const result = await api("/api/whatsapp/start", {
    method: "POST",
    body: JSON.stringify({ mode, phoneNumber })
  });
  if (result.qrDataUrl) {
    $("#qrImage").src = result.qrDataUrl;
    $("#qrWrap").classList.remove("hidden");
  }
  if (result.pairingCode) {
    $("#pairCode").textContent = result.pairingCode;
    $("#pairWrap").classList.remove("hidden");
  }
  message("#globalMessage", `WhatsApp session status: ${result.status}`);
  await refreshMe();
  startPolling();
}
$("#startQr").addEventListener("click", async () => {
  $("#startQr").disabled = true;
  try { await startWhatsApp("qr"); }
  catch (err) { message("#globalMessage", err.message, true); }
  finally { $("#startQr").disabled = false; }
});
$("#pairForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const phoneNumber = new FormData(event.currentTarget).get("phoneNumber");
  try { await startWhatsApp("phone", phoneNumber); }
  catch (err) { message("#globalMessage", err.message, true); }
});
$("#copyPair").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("#pairCode").textContent); message("#globalMessage", "Pairing code copied."); }
  catch { message("#globalMessage", "Copy is unavailable. Select the code manually.", true); }
});
$("#stopBot").addEventListener("click", async () => {
  try {
    await api("/api/whatsapp/stop", { method: "POST", body: "{}" });
    $("#qrWrap").classList.add("hidden"); $("#pairWrap").classList.add("hidden");
    await refreshMe();
    message("#globalMessage", "Bot session stopped.");
  } catch (err) { message("#globalMessage", err.message, true); }
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const status = await api("/api/whatsapp/status");
      $("#sessionStatus").textContent = status.status;
      $("#botStatus").textContent = status.status;
      $("#sessionError").textContent = status.lastError || "";
      $("#statusDot").style.background = status.status === "connected" ? "var(--green2)" : "var(--muted)";
      if (status.qrDataUrl) {
        $("#qrImage").src = status.qrDataUrl;
        $("#qrWrap").classList.remove("hidden");
      }
      if (status.pairingCode) {
        $("#pairCode").textContent = status.pairingCode;
        $("#pairWrap").classList.remove("hidden");
      }
      if (status.status === "connected") {
        $("#qrWrap").classList.add("hidden"); $("#pairWrap").classList.add("hidden");
      }
    } catch {}
  }, 3000);
}
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

$("#githubForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/api/github/link", {
      method: "POST",
      body: JSON.stringify({ repoUrl: form.get("repoUrl"), branch: form.get("branch") })
    });
    message("#githubCurrent", `Linked ${result.repoUrl} (branch ${result.branch}). ${result.note}`);
    await refreshMe();
  } catch (err) { message("#globalMessage", err.message, true); }
});

$("#payBtn").addEventListener("click", async () => {
  $("#payBtn").disabled = true;
  $("#billingMessage").textContent = "";
  try {
    const result = await api("/api/payments/initialize", { method: "POST", body: "{}" });
    location.href = result.authorizationUrl;
  } catch (err) {
    $("#billingMessage").textContent = err.message;
  } finally { $("#payBtn").disabled = false; }
});

async function loadAdmin() {
  const data = await api("/api/admin/overview");
  $("#adminUsers").textContent = data.totals.users;
  $("#adminSubs").textContent = data.totals.activeSubscriptions;
  $("#adminBots").textContent = data.totals.connectedBots;
  $("#adminPayments").textContent = data.totals.successfulPayments;
  const tbody = $("#adminUsersTable");
  tbody.replaceChildren();
  for (const user of data.users) {
    const tr = document.createElement("tr");
    const cells = [
      `${user.email} (#${user.id})`,
      `${user.status}${user.role === "admin" ? " / admin" : ""}`,
      `${user.subscription_status || "inactive"}${user.current_period_end ? " · " + new Date(user.current_period_end).toLocaleDateString() : ""}`,
      user.whatsapp_status || "disconnected"
    ];
    for (const value of cells) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    const actionTd = document.createElement("td");
    if (user.role !== "admin") {
      const button = document.createElement("button");
      button.className = user.status === "active" ? "danger table-action" : "primary table-action";
      button.textContent = user.status === "active" ? "Suspend" : "Activate";
      button.addEventListener("click", async () => {
        try {
          await api(`/api/admin/users/${user.id}/status`, {
            method: "POST",
            body: JSON.stringify({ status: user.status === "active" ? "suspended" : "active" })
          });
          await loadAdmin();
        } catch (err) { message("#globalMessage", err.message, true); }
      });
      actionTd.appendChild(button);
    } else actionTd.textContent = "Protected";
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}
$("#refreshAdmin").addEventListener("click", () => loadAdmin().catch(err => message("#globalMessage", err.message, true)));

async function boot() {
  await loadConfig();
  try {
    await api("/api/me");
    await enterApp();
  } catch {
    $("#authView").classList.remove("hidden");
    $("#appView").classList.add("hidden");
  }
}
boot();
