// app.js - Lógica principal de Pizza Nuova SPA

// --- 1. CONFIGURACION ---

const GOOGLE_SHEET_MENU_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTvX1QMbJq6ZVAQ0aEr_aeJgXVSaz6gxat85FmqmAWX9mTF5pYA6vtAvYMKD6gAsEnq1E2eYSSJGziH/pub?gid=142999305&single=true&output=csv';
const GOOGLE_SHEET_CONFIG_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTvX1QMbJq6ZVAQ0aEr_aeJgXVSaz6gxat85FmqmAWX9mTF5pYA6vtAvYMKD6gAsEnq1E2eYSSJGziH/pub?gid=207553636&single=true&output=csv';

// --- 2. ESTADO DE LA APLICACIÓN ---
const state = {
    menu: [],
    categories: [],
    config: {},
    cart: [],
    currentCategory: null,
    isLocalClosed: false
};

const formatPrice = (price) => {
    return new Intl.NumberFormat('es-AR', {
        style: 'currency',
        currency: 'ARS',
        maximumFractionDigits: 0
    }).format(price);
};

// --- 3. INICIALIZACIÓN ---
async function init() {
    try {
        console.log("Iniciando Pizza Nuova...");
        await loadConfig();
        await loadMenu();

        renderConfigInfo();
        renderCategories();

        if (state.categories.length > 0) {
            selectCategory(state.categories[0]);
        } else {
            document.getElementById('current-category-title').innerHTML = 
              '<span style="color:red;">Error final: Categorías vacías.<br>' + (window.debugGlobalInfo || 'No hay más info') + '</span>';
        }

        setupUIEvents();
        loadCartFromStorage();

    } catch (error) {
        console.error("Falla crítica en la inicialización:", error);
        document.getElementById('current-category-title').innerHTML = '<span style="color:red;">Falla de sintaxis/runtime en init: ' + error.message + '</span>';
    } finally {
        // Ocultar Spinner SIEMPRE
        const spinner = document.getElementById('loading-spinner');
        if (spinner) {
            spinner.classList.add('fade-out');
            setTimeout(() => spinner.classList.add('hidden'), 500);
        }
    }
}// Ejecutar cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// --- 4. CARGA Y PARSEO DE DATOS ---
async function parseCSV(csv) {
    // Eliminar el carácter BOM invisible que Google Sheets a veces inyecta al principio del archivo
    const cleanCsv = csv.replace(/^\uFEFF/, '');
    return new Promise((resolve, reject) => {
        Papa.parse(cleanCsv, {
            header: true,
            skipEmptyLines: true,
            complete: (results) => resolve(results.data),
            error: (err) => reject(err)
        });
    });
}

async function fetchGoogleSheet(url) {
    const freshUrl = url + '&t=' + Date.now();
    try {
        const response = await fetch(freshUrl);
        if (response.ok) return await response.text();
    } catch(err) {
        console.warn('Native fetch failed, attempting CORS proxy...', err);
    }
    
    // Fallback to CORS proxy para permitir uso local file:///
    const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(freshUrl);
    const proxyRes = await fetch(proxyUrl);
    if (proxyRes.ok) return await proxyRes.text();
    
    throw new Error('No se pudo cargar la hoja de Google: ' + proxyRes.statusText);
}

async function loadConfig() {
    try {
        const csvRaw = await fetchGoogleSheet(GOOGLE_SHEET_CONFIG_URL);
        const data = await parseCSV(csvRaw);
        data.forEach(row => {
            const key = row.claves || row.clave || Object.values(row)[0];
            const val = row.valor || row.valores || Object.values(row)[1];
            if (key && val !== undefined) {
                state.config[String(key).trim()] = String(val).trim();
            }
        });

        checkLocalStatus();
    } catch (e) {
        console.error("Error al cargar config", e);
        throw new Error("No pudimos conectar con la configuración de Google Sheets.");
    }
}

function checkLocalStatus() {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 1=Mon... 6=Sat
    const hour = now.getHours();
    const minutes = now.getMinutes();
    const currentTime = hour * 60 + minutes;

    // 1. Check Day (dias_abiertos: "1,2,3,4,5,6")
    const openDaysStr = state.config['dias_abiertos'] || '0,1,2,3,4,5,6';
    const openDays = openDaysStr.split(',').map(d => parseInt(d.trim()));
    const isDayOpen = openDays.includes(day);

    // 2. Check Time (hora_apertura: "9:00", hora_cierre: "23:30")
    const parseTime = (tStr) => {
        if (!tStr) return 0;
        const [h, m] = tStr.split(':').map(n => parseInt(n));
        return h * 60 + (m || 0);
    };
    const openTime = parseTime(state.config['hora_apertura']);
    const closeTime = parseTime(state.config['hora_cierre']);

    let isTimeOpen;
    if (closeTime < openTime) {
        // Caso trasnochada (ej: Abre 20:00, Cierra 03:00)
        // Está abierto si es más tarde que la apertura O más temprano que el cierre
        isTimeOpen = currentTime >= openTime || currentTime <= closeTime;
    } else {
        // Caso normal (ej: Abre 09:00, Cierra 18:00)
        isTimeOpen = currentTime >= openTime && currentTime <= closeTime;
    }

    // 3. Check Manual Override (estado_local: "Abierto/Cerrado")
    const manualStatus = state.config['estado_local'] || 'Abierto';
    const isManualClosed = manualStatus.toLowerCase().includes('cerrado');

    // Combine logic: Must be day open AND time open AND not manually closed
    state.isLocalClosed = !isDayOpen || !isTimeOpen || isManualClosed;
    
    // Debug info for console
    console.log(`Estado: ${state.isLocalClosed ? 'CERRADO' : 'ABIERTO'} (DayOk: ${isDayOpen}, TimeOk: ${isTimeOpen}, ManualClosed: ${isManualClosed})`);
}

async function loadMenu() {
    try {
        window.debugGlobalInfo = 'Iniciando fetch Menu...';
        const csvRaw = await fetchGoogleSheet(GOOGLE_SHEET_MENU_URL);

        const data = await parseCSV(csvRaw);
        window.debugGlobalInfo += '<br>ParseCSV completado. Filas: ' + data.length;
        const mapCategories = new Set();

        state.menu = data.map((row, index) => {
            const cat = row.Categoría || row.Categoria || row['\ufeffCategoria'] || row['\ufeffCategoría'] || Object.values(row)[0] || 'OTROS';
            if (cat && String(cat).trim() !== '') {
                mapCategories.add(String(cat).trim().toUpperCase());
            }

            const p1Val = row.Precio_1 || row.precio_1 || row['Precio 1'] || Object.values(row)[3];
            const p2Val = row.Precio_2 || row.precio_2 || row['Precio 2'] || Object.values(row)[4];

            return {
                id: 'prod_' + index,
                categoria: String(cat).trim().toUpperCase() || 'OTROS',
                nombre: (row.Nombre || Object.values(row)[1] || 'Sin Nombre').trim(),
                descripcion: (row.Descripción || row.Descripcion || Object.values(row)[2] || '').trim(),
                precio1: p1Val ? parseFloat(String(p1Val).replace(/\D/g, '')) : null,
                precio2: p2Val ? parseFloat(String(p2Val).replace(/\D/g, '')) : null,
            };
        }).filter(p => {
            if (p.precio1 === null || isNaN(p.precio1)) {
                p.precio1 = 0;
            }
            return true;
        });

        state.categories = Array.from(mapCategories).filter(c => c !== "UNDEFINED" && c !== "");
        console.log("Categorías cargadas:", state.categories);

        // DEBUG
        if (state.categories.length === 0 && data.length > 0) {
            console.error("Problemas de lectura: ", data[0]);
            throw new Error("La hoja de Google conectada tiene columnas no reconocidas.");
        }
    } catch (e) {
        console.error("Error al cargar menú", e);
        window.debugGlobalInfo = 'Error: ' + e.message;
        throw e;
    }
}

// --- 5. RENDERIZADO UI ---
function renderConfigInfo() {
    const banner = document.getElementById('closed-banner');
    const msg = document.getElementById('closed-message');
    const welcomeSection = document.getElementById('welcome-section');
    const welcomeMsg = document.getElementById('welcome-message');
    const checkoutMsg = document.getElementById('closed-checkout-msg');
    const btn = document.getElementById('checkout-btn');

    // Bienvenida
    const welcomeText = state.config['mensaje_bienvenida'];
    if (welcomeText && welcomeSection && welcomeMsg) {
        welcomeMsg.textContent = welcomeText;
        welcomeSection.classList.remove('hidden');
    } else if (welcomeSection) {
        welcomeSection.classList.add('hidden');
    }

    if (state.isLocalClosed) {
        if (msg) msg.textContent = state.config['mensaje_cierre'] || 'Actualmente estamos cerrados. Revisá nuestros horarios.';
        if (banner) banner.classList.remove('hidden');
        if (checkoutMsg) checkoutMsg.classList.remove('hidden');
        if (btn) btn.disabled = true;
    } else {
        if (banner) banner.classList.add('hidden');
        if (checkoutMsg) checkoutMsg.classList.add('hidden');
    }
}

function renderCategories() {
    const list = document.getElementById('categories-list');
    if (!list) return;
    list.innerHTML = '';

    state.categories.forEach(cat => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'cat-btn';
        btn.textContent = cat;
        btn.onclick = () => selectCategory(cat);

        if (cat === state.currentCategory) {
            btn.classList.add('active');
        }

        li.appendChild(btn);
        list.appendChild(li);
    });
}

function selectCategory(category) {
    state.currentCategory = category;
    renderCategories();

    const titleEl = document.getElementById('current-category-title');
    if (titleEl) titleEl.textContent = category;

    const grid = document.getElementById('products-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const products = state.menu.filter(p => p.categoria === category);

    products.forEach(p => {
        const card = document.createElement('div');
        card.className = 'product-card';

        let hasTwoPrices = p.precio1 && p.precio2;
        let isPizza = category.toLowerCase().includes('pizza');
        let isCalzone = category.toLowerCase().includes('calzone');

        let label1 = hasTwoPrices ? (isPizza ? 'Media' : isCalzone ? 'Chico' : 'Opción 1') : 'Único';
        let label2 = hasTwoPrices ? (isPizza ? 'Grande' : isCalzone ? 'Grande' : 'Opción 2') : '';

        let pricesHTML = '';
        if (hasTwoPrices) {
            pricesHTML = `
                <div class="price-box">
                    <label>
                        <input type="radio" name="price_${p.id}" value="${p.precio1}" data-variant="${label1}" checked>
                        <span>${label1}</span>
                        <span class="price-amount">${formatPrice(p.precio1)}</span>
                    </label>
                </div>
                <div class="price-box">
                    <label>
                        <input type="radio" name="price_${p.id}" value="${p.precio2}" data-variant="${label2}">
                        <span>${label2}</span>
                        <span class="price-amount">${formatPrice(p.precio2)}</span>
                    </label>
                </div>
            `;
        } else {
            pricesHTML = `
                <div class="price-box">
                    <label>
                        <input type="radio" name="price_${p.id}" value="${p.precio1}" data-variant="${label1}" checked style="display:none;">
                        <span style="display:none;">${label1}</span>
                        <span class="price-amount" style="font-size: 1.2rem; margin-left: 0;">${formatPrice(p.precio1)}</span>
                    </label>
                </div>
            `;
        }

        card.innerHTML = `
            <div class="product-name">${p.nombre}</div>
            <div class="product-desc">${p.descripcion}</div>
            <div class="prices-container">
                ${pricesHTML}
            </div>
            <button class="add-to-cart-btn ${state.isLocalClosed ? 'disabled' : ''}" 
                    ${state.isLocalClosed ? 'disabled' : ''}>
                Agregar <i class="fa-solid fa-plus"></i>
            </button>
        `;

        grid.appendChild(card);

        const btn = card.querySelector('.add-to-cart-btn');
        btn.addEventListener('click', () => {
            if (state.isLocalClosed) return;
            const selectedRadio = card.querySelector(`input[name="price_${p.id}"]:checked`);
            const price = parseFloat(selectedRadio.value);
            const variant = selectedRadio.dataset.variant;
            addToCart(p, price, variant);
        });
    });
}

// --- 6. GESTIÓN DEL CARRITO ---
function addToCart(product, price, variant) {
    const cartItemId = `${product.id}_${variant}`;
    const existingIdx = state.cart.findIndex(i => i.cartItemId === cartItemId);

    if (existingIdx >= 0) {
        state.cart[existingIdx].qty += 1;
    } else {
        state.cart.push({
            cartItemId,
            productId: product.id,
            nombre: product.nombre,
            precio: price,
            variante: variant,
            qty: 1,
            notas: ''
        });
    }

    saveCart();
    renderCart();

    const badge = document.getElementById('cart-badge');
    if (badge) {
        badge.style.transform = 'scale(1.5)';
        setTimeout(() => badge.style.transform = 'scale(1)', 200);
    }
}

function updateCartItemQty(cartItemId, delta) {
    const itemIdx = state.cart.findIndex(i => i.cartItemId === cartItemId);
    if (itemIdx < 0) return;

    state.cart[itemIdx].qty += delta;
    if (state.cart[itemIdx].qty <= 0) {
        state.cart.splice(itemIdx, 1);
    }

    saveCart();
    renderCart();
}

function removeCartItem(cartItemId) {
    state.cart = state.cart.filter(i => i.cartItemId !== cartItemId);
    saveCart();
    renderCart();
}

function updateCartItemNotes(cartItemId, notas) {
    const item = state.cart.find(i => i.cartItemId === cartItemId);
    if (item) {
        item.notas = notas;
        saveCart();
    }
}

function renderCart() {
    const container = document.getElementById('cart-items');
    const badge = document.getElementById('cart-badge');
    const totalEl = document.getElementById('cart-total-price');
    const subtotalEl = document.getElementById('cart-subtotal');
    const shippingEl = document.getElementById('cart-shipping');
    const checkoutBtn = document.getElementById('checkout-btn');

    if (!container) return;
    container.innerHTML = '';

    let totalItems = 0;
    let subtotalPrice = 0;

    if (state.cart.length === 0) {
        container.innerHTML = `
            <div class="empty-cart-msg">
                <i class="fa-solid fa-pizza-slice"></i>
                <p>Tu carrito está vacío</p>
            </div>
        `;
        if (checkoutBtn) checkoutBtn.disabled = true;
    } else {
        if (checkoutBtn && !state.isLocalClosed) checkoutBtn.disabled = false;

        state.cart.forEach(item => {
            totalItems += item.qty;
            subtotalPrice += (item.precio * item.qty);

            const div = document.createElement('div');
            div.className = 'cart-item';
            div.innerHTML = `
                <button class="remove-item-btn" onclick="appContext.removeCartItem('${item.cartItemId}')">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
                <div class="cart-item-header">
                    <div>
                        <div class="item-name">${item.nombre}</div>
                        ${item.variante !== 'Único' ? `<span class="item-variant">Tam/Var: ${item.variante}</span>` : ''}
                    </div>
                </div>
                <div class="cart-item-actions">
                    <div class="qty-control">
                        <button class="qty-btn" onclick="appContext.updateCartItemQty('${item.cartItemId}', -1)"><i class="fa-solid fa-minus"></i></button>
                        <span class="qty-val">${item.qty}</span>
                        <button class="qty-btn" onclick="appContext.updateCartItemQty('${item.cartItemId}', 1)"><i class="fa-solid fa-plus"></i></button>
                    </div>
                    <div class="item-price">${formatPrice(item.precio * item.qty)}</div>
                </div>
                <textarea class="item-notes" placeholder="Aclaraciones (ej: Sin cebolla, etc.)" onchange="appContext.updateCartItemNotes('${item.cartItemId}', this.value)">${item.notas}</textarea>
            `;
            container.appendChild(div);
        });
    }

    const shippingCost = parseFloat(state.config['costo_envio']) || 0;
    const finalTotal = subtotalPrice > 0 ? (subtotalPrice + shippingCost) : 0;

    if (badge) badge.textContent = totalItems;
    if (subtotalEl) subtotalEl.textContent = formatPrice(subtotalPrice);
    if (shippingEl) shippingEl.textContent = formatPrice(shippingCost);
    if (totalEl) totalEl.textContent = formatPrice(finalTotal);
}

function saveCart() {
    localStorage.setItem('pizzaNuovaCart', JSON.stringify(state.cart));
}

function loadCartFromStorage() {
    const saved = localStorage.getItem('pizzaNuovaCart');
    if (saved) {
        try {
            state.cart = JSON.parse(saved);
            renderCart();
        } catch (e) { }
    }
}

// --- 7. CHECKOUT Y WHATSAPP ---
function generateWhatsAppOrder() {
    if (state.cart.length === 0 || state.isLocalClosed) return;

    const phone = state.config['telefono_whatsapp'] || '5493816197337';
    const paymentSelect = document.getElementById('payment-select');
    const paymentMethod = paymentSelect ? paymentSelect.value : 'No especificado';
    const shippingCost = parseFloat(state.config['costo_envio']) || 0;

    let text = `*Hola Pizza Nuova, quiero hacer el siguiente pedido:*\n\n`;

    let subtotal = 0;
    state.cart.forEach(item => {
        let itemSub = item.qty * item.precio;
        subtotal += itemSub;
        let varText = item.variante !== 'Único' ? ` (${item.variante})` : '';
        text += `- *${item.qty}x ${item.nombre}${varText}* - $${itemSub.toLocaleString('es-AR')}\n`;
        if (item.notas.trim()) text += `   📌 _Nota: ${item.notas.trim()}_\n`;
    });

    text += `\n*Subtotal:* $${subtotal.toLocaleString('es-AR')}\n`;
    if (shippingCost > 0) text += `*Envío:* $${shippingCost.toLocaleString('es-AR')}\n`;
    text += `*Total a pagar: $${(subtotal + shippingCost).toLocaleString('es-AR')}*\n\n`;
    text += `*Método de pago:* ${paymentMethod}\n\n`;
    text += `Por favor, confirmar recepción del pedido. ¡Muchas gracias!`;

    const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
}

// --- 8. UI EVENTOS ---
function setupUIEvents() {
    const cartTrigger = document.getElementById('cart-trigger');
    const closeCart = document.getElementById('close-cart');
    const cartSidebar = document.getElementById('cart-sidebar');
    const overlay = document.getElementById('cart-overlay');
    const checkoutBtn = document.getElementById('checkout-btn');

    if (cartTrigger) cartTrigger.onclick = () => {
        if (cartSidebar) cartSidebar.classList.add('open');
        if (overlay) overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    };

    const hideCart = () => {
        if (cartSidebar) cartSidebar.classList.remove('open');
        if (overlay) overlay.classList.add('hidden');
        document.body.style.overflow = '';
    };

    if (closeCart) closeCart.onclick = hideCart;
    if (overlay) overlay.onclick = hideCart;
    if (checkoutBtn) checkoutBtn.onclick = generateWhatsAppOrder;
}

window.appContext = {
    updateCartItemQty,
    removeCartItem,
    updateCartItemNotes
};

setTimeout(() => {
    const spinner = document.getElementById('loading-spinner');
    if (spinner && !spinner.classList.contains('hidden')) {
        console.warn('Failsafe activado: El spinner no se ocultó a tiempo. Ocultando forzosamente.');
        spinner.classList.add('fade-out');
        setTimeout(() => spinner.classList.add('hidden'), 500);
        
        // Mostrar mensaje si no hay ninguna categoría cargada
        const titleEl = document.getElementById('current-category-title');
        if (titleEl && titleEl.textContent && titleEl.textContent.trim() === 'Cargando menú...') {
            titleEl.innerHTML = '<span style="color:red;font-size:16px;">Vercel/Red Timeout. Problema conectado a Google Sheets.</span><br>' + (window.debugGlobalInfo || '');
        }
    }
}, 5000);
