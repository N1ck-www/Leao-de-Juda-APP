// ============================================================
// APP.JS — toda a lógica do aplicativo.
// Você não precisa editar este arquivo. Ele lê a configuração
// de firebase-config.js e comanda tudo: login, produtos,
// histórico e equipe.
// ============================================================

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ---------- estado em memória ----------
let currentUser = null;   // { uid, name, role }
let productsCache = [];
let activeFilter = "todos";
let searchTerm = "";
let unsubProducts = null;
let unsubHistory = null;
let unsubTeam = null;

// ---------- atalhos de elementos ----------
const $ = (id) => document.getElementById(id);

const loginScreen = $("login-screen");
const appShell = $("app-shell");
const loginForm = $("login-form");
const loginError = $("login-error");

// ============================================================
// AUTENTICAÇÃO
// ============================================================

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const btn = $("login-submit");
  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    await auth.signInWithEmailAndPassword(email, password);
    // o listener onAuthStateChanged cuida do resto
  } catch (err) {
    loginError.textContent = "E-mail ou senha incorretos.";
    loginError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
});

$("logout-btn").addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(async (user) => {
  if (unsubProducts) { unsubProducts(); unsubProducts = null; }
  if (unsubHistory) { unsubHistory(); unsubHistory = null; }
  if (unsubTeam) { unsubTeam(); unsubTeam = null; }
  if (unsubDebts) { unsubDebts(); unsubDebts = null; }

  if (!user) {
    currentUser = null;
    loginScreen.hidden = false;
    appShell.hidden = true;
    hideLoadingScreen();
    return;
  }

  // busca o "perfil" do usuário (nome + role) salvo no Firestore
  const profileDoc = await db.collection("users").doc(user.uid).get();

  if (!profileDoc.exists) {
    // conta existe no Auth mas ninguém cadastrou o perfil dela ainda
    loginError.textContent = "Sua conta não tem um perfil cadastrado. Fale com o dono da loja.";
    loginError.hidden = false;
    auth.signOut();
    return;
  }

  const profile = profileDoc.data();
  currentUser = { uid: user.uid, name: profile.name || user.email, role: profile.role };

  loginScreen.hidden = true;
  appShell.hidden = false;
  hideLoadingScreen();
  $("user-name").textContent = currentUser.name;

  applyRoleUI();
  startProductsListener();
  startHistoryListener();
  if (currentUser.role === "dono") {
    startTeamListener();
    startDebtsListener();
  }
});

function applyRoleUI() {
  const isDono = currentUser.role === "dono";
  $("nav-equipe").hidden = !isDono;
  $("nav-dividas").hidden = !isDono;
  $("fab-add-product").hidden = !isDono || currentActiveView !== "produtos";
}

// ============================================================
// NAVEGAÇÃO (abas inferiores)
// ============================================================

let currentActiveView = "dashboard";

document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

function switchView(view) {
  currentActiveView = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  $(`view-${view}`).classList.add("active");
  document.querySelector(`.nav-btn[data-view="${view}"]`).classList.add("active");
  $("fab-add-product").hidden = !(view === "produtos" && currentUser?.role === "dono");
  $("fab-add-debt").hidden = !(view === "dividas" && currentUser?.role === "dono");
}
switchView("dashboard");

// ============================================================
// PRODUTOS
// ============================================================

function startProductsListener() {
  unsubProducts = db.collection("products").orderBy("name")
    .onSnapshot((snap) => {
      productsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderProducts();
      renderDashboard();
    });
}

function productStatus(p) {
  if (p.quantity <= 0) return "danger";
  if (p.quantity <= (p.minStock ?? 0)) return "warn";
  return "ok";
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function renderProducts() {
  let list = productsCache.filter((p) =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase())
  );
  if (activeFilter === "baixo") list = list.filter((p) => productStatus(p) === "warn");
  if (activeFilter === "falta") list = list.filter((p) => productStatus(p) === "danger");

  const container = $("products-list");
  container.innerHTML = "";
  $("products-empty").hidden = list.length > 0;

  list.forEach((p) => container.appendChild(productCardEl(p)));
}

function productCardEl(p) {
  const status = productStatus(p);
  const el = document.createElement("div");
  el.className = "product-card";
  el.innerHTML = `
    ${p.image
      ? `<img class="product-thumb" src="${p.image}" alt="">`
      : `<div class="product-thumb placeholder">📦</div>`}
    <div class="product-info">
      <div class="product-name">
        <span class="status-dot status-${status}" style="display:inline-block;margin-right:6px;"></span>${escapeHtml(p.name)}
      </div>
      <div class="product-meta">${escapeHtml(p.category || "Sem categoria")}</div>
    </div>
    <div class="qty-control">
      <button class="qty-btn" data-action="dec">−</button>
      <span class="qty-value">${p.quantity}</span>
      <button class="qty-btn" data-action="inc">+</button>
    </div>
  `;

  el.querySelector('[data-action="inc"]').addEventListener("click", (e) => {
    e.stopPropagation();
    adjustQuantity(p, 1);
  });
  el.querySelector('[data-action="dec"]').addEventListener("click", (e) => {
    e.stopPropagation();
    adjustQuantity(p, -1);
  });

  if (currentUser.role === "dono") {
    el.addEventListener("click", () => openProductModal(p));
  }

  return el;
}

async function adjustQuantity(p, delta) {
  const newQty = Math.max(0, (p.quantity || 0) + delta);
  if (newQty === p.quantity) return;
  await db.collection("products").doc(p.id).update({
    quantity: newQty,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentUser.name,
  });
  await logHistory({
    productName: p.name,
    action: delta > 0 ? "Adicionou 1 unidade" : "Deu baixa de 1 unidade",
    detail: `${p.quantity} → ${newQty}`,
  });
}

$("search-input").addEventListener("input", (e) => {
  searchTerm = e.target.value;
  renderProducts();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    activeFilter = chip.dataset.filter;
    renderProducts();
  });
});

// ---------- modal de produto (somente dono) ----------

const productModal = $("product-modal");
const productForm = $("product-form");
let selectedImageDataURL = null;

// Redimensiona e comprime a foto no navegador e devolve ela já
// pronta como "data URL" (uma string), pra guardar direto no
// Firestore — sem precisar do Firebase Storage (que agora exige
// plano pago). Uma foto de produto fica em ~50-150 KB assim,
// bem abaixo do limite de 1 MB por produto no Firestore.
function compressImage(file, maxDim = 480, quality = 0.65) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Arquivo não é uma imagem válida"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

$("fab-add-product").addEventListener("click", () => openProductModal(null));
$("product-modal-close").addEventListener("click", closeProductModal);

function openProductModal(product) {
  productForm.reset();
  selectedImageDataURL = null;
  $("image-preview").hidden = true;
  $("image-placeholder").hidden = false;
  $("product-error").hidden = true;

  if (product) {
    $("product-modal-title").textContent = "Editar produto";
    $("product-id").value = product.id;
    $("product-name").value = product.name;
    $("product-category").value = product.category || "";
    $("product-quantity").value = product.quantity;
    $("product-minstock").value = product.minStock ?? 3;
    $("product-delete-btn").hidden = false;
    if (product.image) {
      $("image-preview").src = product.image;
      $("image-preview").hidden = false;
      $("image-placeholder").hidden = true;
    }
  } else {
    $("product-modal-title").textContent = "Novo produto";
    $("product-id").value = "";
    $("product-minstock").value = 3;
    $("product-delete-btn").hidden = true;
  }
  productModal.hidden = false;
}

function closeProductModal() {
  productModal.hidden = true;
}

$("image-upload-area").addEventListener("click", () => $("product-image").click());
$("product-image").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    selectedImageDataURL = await compressImage(file);
    $("image-preview").src = selectedImageDataURL;
    $("image-preview").hidden = false;
    $("image-placeholder").hidden = true;
  } catch (err) {
    showToast("Não deu pra carregar essa imagem.");
  }
});

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("product-error");
  errorEl.hidden = true;

  const id = $("product-id").value || db.collection("products").doc().id;
  const data = {
    name: $("product-name").value.trim(),
    category: $("product-category").value.trim(),
    quantity: parseInt($("product-quantity").value, 10),
    minStock: parseInt($("product-minstock").value, 10),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentUser.name,
  };

  try {
    if (selectedImageDataURL) {
      data.image = selectedImageDataURL;
    }

    const isNew = !$("product-id").value;
    await db.collection("products").doc(id).set(data, { merge: true });

    await logHistory({
      productName: data.name,
      action: isNew ? "Cadastrou o produto" : "Editou o produto",
      detail: isNew ? `Quantidade inicial: ${data.quantity}` : "",
    });

    closeProductModal();
    showToast(isNew ? "Produto cadastrado!" : "Produto atualizado!");
  } catch (err) {
    errorEl.textContent = "Não deu pra salvar. Tente de novo.";
    errorEl.hidden = false;
  }
});

$("product-delete-btn").addEventListener("click", async () => {
  const id = $("product-id").value;
  const name = $("product-name").value;
  const ok = await confirmDialog(`Excluir "${name}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  await db.collection("products").doc(id).delete();
  await logHistory({ productName: name, action: "Excluiu o produto", detail: "" });
  closeProductModal();
  showToast("Produto excluído.");
});

// ============================================================
// DASHBOARD
// ============================================================

function renderDashboard() {
  const total = productsCache.length;
  const low = productsCache.filter((p) => productStatus(p) === "warn").length;
  const out = productsCache.filter((p) => productStatus(p) === "danger").length;
  const units = productsCache.reduce((sum, p) => sum + (p.quantity || 0), 0);

  $("stat-total").textContent = total;
  $("stat-low").textContent = low;
  $("stat-out").textContent = out;
  $("stat-units").textContent = units;

  const attention = productsCache
    .filter((p) => productStatus(p) !== "ok")
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, 5);

  const container = $("dashboard-alert-list");
  container.innerHTML = "";
  attention.forEach((p) => container.appendChild(productCardEl(p)));
}

// ============================================================
// HISTÓRICO
// ============================================================

async function logHistory({ productName, action, detail }) {
  await db.collection("history").add({
    productName,
    action,
    detail,
    userName: currentUser.name,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  });
}

function startHistoryListener() {
  unsubHistory = db.collection("history").orderBy("timestamp", "desc").limit(50)
    .onSnapshot((snap) => {
      const items = snap.docs.map((d) => d.data());
      const container = $("history-list");
      $("history-empty").hidden = items.length > 0;
      container.innerHTML = items.map((h) => `
        <div class="history-item">
          <strong>${escapeHtml(h.userName)}</strong> ${escapeHtml(h.action)} <strong>${escapeHtml(h.productName)}</strong>
          ${h.detail ? ` — ${escapeHtml(h.detail)}` : ""}
          <span class="history-time">${formatRelativeTime(h.timestamp)}</span>
        </div>
      `).join("");
    });
}

function formatRelativeTime(ts) {
  if (!ts || !ts.toDate) return "agora";
  const diffMs = Date.now() - ts.toDate().getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

// ============================================================
// EQUIPE (somente dono)
// ============================================================

function startTeamListener() {
  unsubTeam = db.collection("users").onSnapshot((snap) => {
    const container = $("team-list");
    container.innerHTML = "";
    snap.docs.forEach((d) => {
      const u = d.data();
      const el = document.createElement("div");
      el.className = "team-item";
      el.innerHTML = `
        <div>
          <div>${escapeHtml(u.name)}</div>
          <div class="team-role">${u.role === "dono" ? "Dono" : "Funcionário"}</div>
        </div>
      `;
      container.appendChild(el);
    });
  });
}

$("team-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("team-error");
  const successEl = $("team-success");
  errorEl.hidden = true;
  successEl.hidden = true;

  const name = $("team-name").value.trim();
  const email = $("team-email").value.trim();
  const password = $("team-password").value;

  // Truque do "app secundário": cria o login do funcionário sem
  // derrubar a sessão do dono que está logado agora.
  const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary-" + Date.now());
  try {
    const cred = await secondaryApp.auth().createUserWithEmailAndPassword(email, password);
    await db.collection("users").doc(cred.user.uid).set({ name, email, role: "funcionario" });
    await secondaryApp.auth().signOut();
    successEl.textContent = "Funcionário cadastrado!";
    successEl.hidden = false;
    $("team-form").reset();
  } catch (err) {
    errorEl.textContent = "Não deu pra cadastrar. Confira o e-mail e a senha (mínimo 6 caracteres).";
    errorEl.hidden = false;
  } finally {
    secondaryApp.delete();
  }
});

// ============================================================
// UTIL
// ============================================================

function showToast(msg) {
  const toast = $("toast");
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 2400);
}

function hideLoadingScreen() {
  const el = $("loading-screen");
  if (el && !el.hidden) el.hidden = true;
}

function confirmDialog(message, confirmLabel = "Excluir") {
  return new Promise((resolve) => {
    $("confirm-message").textContent = message;
    $("confirm-ok-btn").textContent = confirmLabel;
    $("confirm-modal").hidden = false;

    function cleanup(result) {
      $("confirm-modal").hidden = true;
      $("confirm-ok-btn").removeEventListener("click", onOk);
      $("confirm-cancel-btn").removeEventListener("click", onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    $("confirm-ok-btn").addEventListener("click", onOk);
    $("confirm-cancel-btn").addEventListener("click", onCancel);
  });
}

// registra o service worker (deixa o app instalável / funcionando offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// ============================================================
// DÍVIDAS DE CLIENTES / FIADO — só o dono usa essa parte
// Cada cliente tem uma "conta corrente": itens fiado (charges)
// somam, pagamentos (payments) subtraem. O saldo é sempre a
// diferença entre os dois.
// ============================================================

let debtsCache = [];
let debtSearchTerm = "";
let unsubDebts = null;

function chargesTotal(d) {
  return (d.charges || []).reduce((sum, c) => sum + (c.amount || 0), 0);
}

function paidTotal(d) {
  return (d.payments || []).reduce((sum, p) => sum + (p.amount || 0), 0);
}

function debtRemaining(d) {
  return chargesTotal(d) - paidTotal(d);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function debtStatus(d) {
  const remaining = debtRemaining(d);
  if (remaining <= 0) return "ok";
  if (d.dueDate && d.dueDate < todayStr()) return "danger";
  return "warn";
}

function formatCurrency(v) {
  return (v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function lastActivityDate(d) {
  const dates = [
    ...(d.charges || []).map((c) => c.date),
    ...(d.payments || []).map((p) => p.date),
  ].filter(Boolean);
  return dates.sort().slice(-1)[0] || "";
}

function startDebtsListener() {
  unsubDebts = db.collection("debts").orderBy("customerName")
    .onSnapshot((snap) => {
      debtsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderDebts();
    });
}

function renderDebtStats() {
  const pending = debtsCache.filter((d) => debtRemaining(d) > 0);
  const totalToReceive = pending.reduce((sum, d) => sum + debtRemaining(d), 0);
  const overdue = pending.filter((d) => debtStatus(d) === "danger").length;

  $("stat-divida-total").textContent = formatCurrency(totalToReceive);
  $("stat-divida-clientes").textContent = pending.length;
  $("stat-divida-atrasadas").textContent = overdue;
}

function renderDebts() {
  renderDebtStats();

  const list = debtsCache.filter((d) =>
    d.customerName.toLowerCase().includes(debtSearchTerm.toLowerCase())
  );

  const container = $("debts-list");
  container.innerHTML = "";
  $("debts-empty").hidden = list.length > 0;

  list.forEach((d) => container.appendChild(debtCardEl(d)));
}

function formatPhoneForWhatsapp(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.length <= 11 ? "55" + digits : digits;
}

function buildChargeMessage(d) {
  const remaining = debtRemaining(d);
  const charges = d.charges || [];
  const itemsText = charges
    .map((c) => `- ${formatDateBR(c.date)}: ${c.product || "Item"} — ${formatCurrency(c.amount)}`)
    .join("\n");

  let msg = `Olá, ${d.customerName}! Aqui é da *Leão de Judá Eletrônicos* 🦁\n\n`;
  msg += `Passando pra lembrar do seu fiado:\n\n`;
  msg += `📦 *Itens:*\n${itemsText}\n\n`;
  msg += `💰 *Total das compras:* ${formatCurrency(chargesTotal(d))}\n`;
  msg += `✅ *Já pago:* ${formatCurrency(paidTotal(d))}\n`;
  msg += `📌 *Saldo restante:* ${formatCurrency(remaining)}\n`;

  if (d.dueDate) {
    const overdue = d.dueDate < todayStr();
    msg += `\n📅 ${overdue ? "O pagamento estava previsto para" : "Combinamos o pagamento até"} *${formatDateBR(d.dueDate)}*.\n`;
  }

  msg += `\nQualquer dúvida, só chamar! Obrigado pela confiança 🙏`;
  return msg;
}

function chargeViaWhatsapp(d) {
  const phone = formatPhoneForWhatsapp(d.customerPhone);
  if (!phone) {
    showToast("Esse cliente não tem telefone cadastrado.");
    return;
  }
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(buildChargeMessage(d))}`;
  window.open(url, "_blank");
}

function debtCardEl(d) {
  const status = debtStatus(d);
  const remaining = debtRemaining(d);
  const itemCount = (d.charges || []).length;
  const canCharge = d.customerPhone && remaining > 0;
  const el = document.createElement("div");
  el.className = "product-card";
  el.innerHTML = `
    <div class="product-info">
      <div class="product-name">
        <span class="status-dot status-${status}" style="display:inline-block;margin-right:6px;"></span>${escapeHtml(d.customerName)}
        ${d.installments ? '<span class="badge-installment">Parcelado</span>' : ""}
      </div>
      <div class="product-meta">${itemCount} ${itemCount === 1 ? "item" : "itens"} fiado · ${formatDateBR(lastActivityDate(d))}</div>
    </div>
    <div class="debt-value-col">
      <span class="debt-value">${formatCurrency(remaining)}</span>
      <span class="debt-value-label">${remaining <= 0 ? "quitado" : "restante"}</span>
    </div>
    ${canCharge ? `<button class="whatsapp-btn" data-action="charge" title="Cobrar via WhatsApp"><svg viewBox="0 0 32 32" width="18" height="18" fill="white"><path d="M16.001 3.2c-7.06 0-12.8 5.74-12.8 12.8 0 2.257.594 4.446 1.72 6.376L3.2 28.8l6.63-1.74a12.75 12.75 0 0 0 6.17 1.57h.005c7.06 0 12.8-5.74 12.8-12.8s-5.74-12.8-12.804-12.8zm0 23.36a10.55 10.55 0 0 1-5.38-1.47l-.386-.23-3.996 1.05 1.067-3.897-.252-.4a10.53 10.53 0 0 1-1.614-5.613c0-5.83 4.744-10.573 10.564-10.573 2.823 0 5.476 1.1 7.47 3.096a10.5 10.5 0 0 1 3.093 7.478c0 5.83-4.744 10.56-10.566 10.56zm5.79-7.91c-.317-.159-1.878-.927-2.17-1.033-.29-.106-.502-.159-.714.16-.212.317-.82 1.032-1.005 1.244-.185.212-.37.238-.687.08-.317-.16-1.338-.494-2.548-1.573-.942-.84-1.578-1.878-1.763-2.196-.185-.317-.02-.489.14-.647.144-.143.317-.37.476-.556.16-.185.212-.317.318-.53.106-.212.053-.397-.026-.556-.08-.16-.714-1.72-.978-2.355-.258-.62-.52-.536-.714-.546-.185-.008-.397-.01-.61-.01a1.17 1.17 0 0 0-.846.397c-.29.317-1.11 1.085-1.11 2.646s1.137 3.07 1.296 3.282c.16.212 2.238 3.418 5.42 4.793.757.327 1.348.522 1.809.668.76.242 1.452.208 1.998.126.61-.09 1.878-.768 2.143-1.51.265-.74.265-1.376.185-1.51-.08-.132-.29-.212-.61-.37z"/></svg></button>` : ""}
  `;
  if (canCharge) {
    el.querySelector('[data-action="charge"]').addEventListener("click", (e) => {
      e.stopPropagation();
      chargeViaWhatsapp(d);
    });
  }
  el.addEventListener("click", () => openDebtModal(d));
  return el;
}

$("debt-search-input").addEventListener("input", (e) => {
  debtSearchTerm = e.target.value;
  renderDebts();
});

// ---------- modal de dívida ----------

const debtModal = $("debt-modal");
const debtForm = $("debt-form");

$("fab-add-debt").addEventListener("click", () => openDebtModal(null));
$("debt-modal-close").addEventListener("click", closeDebtModal);

$("debt-installments").addEventListener("change", (e) => {
  $("debt-installment-count-field").hidden = !e.target.checked;
});

$("scan-receipt-btn").addEventListener("click", () => $("receipt-photo-input").click());

$("receipt-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const statusEl = $("scan-status");
  statusEl.hidden = false;
  statusEl.className = "success-text";
  statusEl.textContent = "Lendo notinha...";

  try {
    const imageDataUrl = await compressImage(file, 1024, 0.85);
    const base64 = imageDataUrl.split(",")[1];

    const prompt = `Você vai analisar a foto de uma notinha de venda fiado (compra a prazo), escrita à mão em português, de uma loja de eletrônicos.

Extraia estas informações e responda APENAS com um JSON válido, sem nenhum texto antes ou depois, no formato exato:

{
  "customerName": "nome do cliente, sem títulos como 'funcionário'",
  "product": "descrição do(s) produto(s), resumida",
  "amount": valor numérico total (use ponto decimal, sem R$, sem vírgula),
  "date": "AAAA-MM-DD",
  "dueDate": "AAAA-MM-DD ou null se não houver data prevista de pagamento"
}

Regras importantes:
- Se houver valor circulado, corrigido ou reescrito por cima, use o valor final/mais recente, não o riscado.
- Se a data estiver no formato DD/MM/AA, converta pro formato AAAA-MM-DD (assuma 20AA para o ano).
- Se não conseguir identificar um campo com confiança, use null nesse campo.
- Nunca invente informação que não está na notinha.`;

    // Em vez de chamar o Google diretamente, chama o seu Worker
const response = await fetch("https://lj-ia.nicolaskaka33.workers.dev", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    imageBase64: base64,
    prompt: prompt,
  }),
});

if (!response.ok) throw new Error("Falha na requisição");

const result = await response.json();

let text = result.candidates[0].content.parts[0].text.trim();
text = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
const data = JSON.parse(text);

    if (data.customerName) $("debt-customer-name").value = data.customerName;
    if (data.product) $("debt-product").value = data.product;
    if (data.amount) $("debt-total-amount").value = data.amount;
    if (data.date) $("debt-date").value = data.date;
    if (data.dueDate) $("debt-due-date").value = data.dueDate;

    statusEl.textContent = "Notinha lida! Confere os dados antes de salvar.";
  } catch (err) {
    statusEl.className = "error-text";
    statusEl.textContent = "Não consegui ler essa notinha. Preenche manualmente.";
  } finally {
    $("receipt-photo-input").value = "";
  }
});

function openDebtModal(debt) {
  debtForm.reset();
  $("debt-error").hidden = true;
  $("debt-installment-count-field").hidden = true;

  if (debt) {
    $("debt-modal-title").textContent = "Editar dívida";
    $("debt-id").value = debt.id;
    $("debt-customer-name").value = debt.customerName;
    $("debt-customer-phone").value = debt.customerPhone || "";
    $("debt-installments").checked = !!debt.installments;
    $("debt-installment-count-field").hidden = !debt.installments;
    $("debt-installment-count").value = debt.installmentCount || "";
    $("debt-due-date").value = debt.dueDate || "";
    $("debt-notes").value = debt.notes || "";
    $("debt-delete-btn").hidden = false;
    $("debt-initial-charge-fields").hidden = true;
    $("debt-ledger-section").hidden = false;
    $("debt-charge-date").value = todayStr();
    $("debt-payment-date").value = todayStr();
    refreshDebtLedgerUI(debt);
  } else {
    $("debt-modal-title").textContent = "Nova dívida";
    $("debt-id").value = "";
    $("debt-date").value = todayStr();
    $("debt-delete-btn").hidden = true;
    $("debt-initial-charge-fields").hidden = false;
    $("debt-ledger-section").hidden = true;
  }
  debtModal.hidden = false;
}

function closeDebtModal() {
  debtModal.hidden = true;
}

function refreshDebtLedgerUI(debt) {
  $("debt-remaining-display").textContent = `Saldo restante: ${formatCurrency(debtRemaining(debt))}`;
  renderChargesList(debt);
  renderPaymentsList(debt);
}

function renderChargesList(debt) {
  const charges = debt.charges || [];
  const container = $("debt-charges-list");
  if (charges.length === 0) {
    container.innerHTML = `<p class="empty-state" style="padding:10px 0;">Nenhum item ainda.</p>`;
  } else {
    container.innerHTML = charges.slice().reverse().map((c) => `
      <div class="payment-item">
        <span>${formatDateBR(c.date)} · ${escapeHtml(c.product || "Item")}</span>
        <span>${formatCurrency(c.amount)}</span>
      </div>
    `).join("");
  }
}

function renderPaymentsList(debt) {
  const payments = debt.payments || [];
  const container = $("debt-payments-list");
  if (payments.length === 0) {
    container.innerHTML = `<p class="empty-state" style="padding:10px 0;">Nenhum pagamento ainda.</p>`;
  } else {
    container.innerHTML = payments.slice().reverse().map((p) => `
      <div class="payment-item">
        <span>${formatDateBR(p.date)}</span>
        <span>${formatCurrency(p.amount)}</span>
      </div>
    `).join("");
  }
}

debtForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("debt-error");
  errorEl.hidden = true;

  const isNew = !$("debt-id").value;
  const id = $("debt-id").value || db.collection("debts").doc().id;
  const isInstallments = $("debt-installments").checked;

  const data = {
    customerName: $("debt-customer-name").value.trim(),
    customerPhone: $("debt-customer-phone").value.trim(),
    installments: isInstallments,
    installmentCount: isInstallments ? (parseInt($("debt-installment-count").value, 10) || null) : null,
    dueDate: $("debt-due-date").value || null,
    notes: $("debt-notes").value.trim(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentUser.name,
  };

  if (isNew) {
    const amount = parseFloat($("debt-total-amount").value);
    const date = $("debt-date").value;
    if (!amount || amount <= 0 || !date) {
      errorEl.textContent = "Preenche o valor e a data do item fiado.";
      errorEl.hidden = false;
      return;
    }
    data.charges = [{ product: $("debt-product").value.trim(), amount, date }];
    data.payments = [];
  }

  try {
    await db.collection("debts").doc(id).set(data, { merge: true });
    closeDebtModal();
    showToast(isNew ? "Dívida registrada!" : "Dívida atualizada!");
  } catch (err) {
    errorEl.textContent = "Não deu pra salvar. Tente de novo.";
    errorEl.hidden = false;
  }
});

$("debt-delete-btn").addEventListener("click", async () => {
  const id = $("debt-id").value;
  const name = $("debt-customer-name").value;
  const ok = await confirmDialog(`Excluir a dívida de "${name}"? Essa ação não pode ser desfeita.`);
  if (!ok) return;
  await db.collection("debts").doc(id).delete();
  closeDebtModal();
  showToast("Dívida excluída.");
});

$("debt-add-charge-btn").addEventListener("click", async () => {
  const id = $("debt-id").value;
  if (!id) return;
  const product = $("debt-charge-product").value.trim();
  const amount = parseFloat($("debt-charge-amount").value);
  const date = $("debt-charge-date").value || todayStr();
  if (!amount || amount <= 0) {
    showToast("Coloca um valor válido pro item.");
    return;
  }
  const debt = debtsCache.find((d) => d.id === id);
  const updatedCharges = [...(debt.charges || []), { product, amount, date }];

  await db.collection("debts").doc(id).update({
    charges: updatedCharges,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentUser.name,
  });

  debt.charges = updatedCharges;
  refreshDebtLedgerUI(debt);
  $("debt-charge-product").value = "";
  $("debt-charge-amount").value = "";
  showToast("Item adicionado!");
});

$("debt-add-payment-btn").addEventListener("click", async () => {
  const id = $("debt-id").value;
  if (!id) return;
  const amount = parseFloat($("debt-payment-amount").value);
  const date = $("debt-payment-date").value || todayStr();
  if (!amount || amount <= 0) {
    showToast("Coloca um valor válido pro pagamento.");
    return;
  }
  const debt = debtsCache.find((d) => d.id === id);
  const updatedPayments = [...(debt.payments || []), { amount, date }];

  await db.collection("debts").doc(id).update({
    payments: updatedPayments,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedBy: currentUser.name,
  });

  debt.payments = updatedPayments;
  refreshDebtLedgerUI(debt);
  $("debt-payment-amount").value = "";
  showToast("Pagamento registrado!");
});
