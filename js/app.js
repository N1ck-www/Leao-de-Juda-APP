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

  if (!user) {
    currentUser = null;
    loginScreen.hidden = false;
    appShell.hidden = true;
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
  $("user-name").textContent = currentUser.name;

  applyRoleUI();
  startProductsListener();
  startHistoryListener();
  if (currentUser.role === "dono") startTeamListener();
});

function applyRoleUI() {
  const isDono = currentUser.role === "dono";
  $("nav-equipe").hidden = !isDono;
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
  if (!confirm(`Excluir "${name}"? Essa ação não pode ser desfeita.`)) return;
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

// registra o service worker (deixa o app instalável / funcionando offline)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
