// =============================================================
// customer.js — Customer storefront
// Dual Storage: reads catalog from Firestore, writes orders to Firestore
// Falls back to localStorage cache when offline
// =============================================================

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, setDoc, onSnapshot,
  query, where, orderBy, serverTimestamp, getDocs, deleteDoc
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

document.addEventListener('DOMContentLoaded', async () => {
  let catalog       = { products: [], shelves: [], settings: {} };
  let cart          = {}; // productId → quantity
  let currentCategory = 'new-arrivals';
  let editingOrderId  = null;

  const $ = id  => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  // ── Toast helper ───────────────────────────────────────────
  function showToast(msg, type = 'info') {
    let container = document.getElementById('cust-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'cust-toast-container';
      container.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(container);
    }
    const colors = { success: '#10b981', error: '#ef4444', info: '#3b82f6', warning: '#f59e0b' };
    const toast = document.createElement('div');
    toast.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:fadeIn .2s;`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  // ── Local cache key for offline fallback ──────────────────
  const CATALOG_CACHE_KEY = 'pos_catalog_cache';

  function saveCatalogCache(data) {
    try { localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(data)); } catch(_) {}
  }

  function loadCatalogCache() {
    try {
      const raw = localStorage.getItem(CATALOG_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch(_) { return null; }
  }

  // ── Load catalog ──────────────────────────────────────────
  async function loadCatalog() {
    // Try Firebase first
    if (navigator.onLine) {
      try {
        await loadFromFirestore();
        return;
      } catch (err) {
        console.warn('[Customer] Firestore load failed, trying cache:', err);
      }
    }

    // Offline fallback: use cached catalog
    const cached = loadCatalogCache();
    if (cached) {
      catalog = cached;
      initApp();
      showToast('أنت غير متصل — يعمل البرنامج من الذاكرة المؤقتة', 'warning');
    } else {
      $('products-container').innerHTML = '<div style="grid-column: span 2; text-align:center; padding: 40px; color: #888;">لا يوجد إنترنت ولا توجد بيانات محفوظة</div>';
    }
  }

  async function loadFromFirestore() {
    // Fetch settings
    let settingsData = {};
    try {
      const settingsSnap = await getDocs(collection(db, 'catalog'));
      settingsSnap.forEach(d => {
        if (d.id === 'settings') settingsData = d.data();
      });
    } catch(_) {}

    // Fetch shelves
    const shelvesSnap = await getDocs(collection(db, 'catalog', 'shelves', 'items'));
    const shelves = shelvesSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    // Fetch products
    const productsSnap = await getDocs(collection(db, 'catalog', 'products', 'items'));
    const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    catalog = { products, shelves, settings: settingsData };
    saveCatalogCache(catalog);
    initApp();
    setupRealtimeListeners();
  }

  function setupRealtimeListeners() {
    onSnapshot(collection(db, 'catalog', 'products', 'items'), (snap) => {
      catalog.products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      saveCatalogCache(catalog);
      renderProducts();
    });

    onSnapshot(collection(db, 'catalog', 'shelves', 'items'), (snap) => {
      catalog.shelves = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.position || 0) - (b.position || 0));
      saveCatalogCache(catalog);
      renderCategories();
      renderProducts();
    });

    onSnapshot(doc(db, 'catalog', 'settings'), (docSnap) => {
      if (docSnap.exists()) {
        catalog.settings = docSnap.data();
        saveCatalogCache(catalog);
        if (catalog.settings.storeName) {
           const nameEl = $('store-name-display');
           if (nameEl) nameEl.textContent = catalog.settings.storeName;
        }
      }
    });
  }

  // ── App Init ──────────────────────────────────────────────
  function initApp() {
    // Set store name
    if (catalog.settings && catalog.settings.storeName) {
      const nameEl = $('store-name-display');
      if (nameEl) nameEl.textContent = catalog.settings.storeName;
    }

    // Render categories
    renderCategories();

    // Load saved customer info
    const savedName  = localStorage.getItem('pos_customer_name');
    const savedPhone = localStorage.getItem('pos_customer_phone');
    if (savedName  && $('customer-name'))  $('customer-name').value  = savedName;
    if (savedPhone && $('customer-phone')) {
      $('customer-phone').value = savedPhone;
      fetchMyOrders(savedPhone);
    }

    // Delegate events for product grid buttons
    const prodContainer = $('products-container');
    if (prodContainer && !prodContainer.dataset.delegated) {
      prodContainer.dataset.delegated = 'true';
      prodContainer.addEventListener('click', (e) => {
        const target = e.target;
        const id = target.dataset.id;
        if (target.classList.contains('add-btn')) {
          // Check if product has variants
          const product = catalog.products.find(p => p.id === id);
          if (product && product.variants && product.variants.length > 0) {
            openVariantPicker(product);
          } else {
            cart[id] = (cart[id] || 0) + 1;
            updateCartUI();
          }
        } else if (target.classList.contains('inc-btn-grid')) {
          cart[id]++;
          updateCartUI();
        } else if (target.classList.contains('dec-btn-grid')) {
          cart[id]--;
          if (cart[id] <= 0) delete cart[id];
          updateCartUI();
        }
      });
    }

    renderProducts();
  }

  // ── My Orders (Firestore query) ───────────────────────────
  async function fetchMyOrders(phone) {
    if (!navigator.onLine) {
      showToast('لا يوجد اتصال بالإنترنت', 'warning');
      return;
    }
    
    // Update UI state
    $('orders-phone-prompt').style.display = 'none';
    $('orders-list').style.display = 'flex';
    if ($('logout-orders-btn')) $('logout-orders-btn').style.display = 'block';
    $('orders-list').innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-muted);">جاري التحميل... ⏳</div>';

    try {
      const q = query(
        collection(db, 'orders'),
        where('customerPhone', '==', phone)
      );
      const snap = await getDocs(q);
      let orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort in memory to avoid Firestore composite index requirement
      orders.sort((a, b) => {
        const tA = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp || 0);
        const tB = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp || 0);
        return tB - tA;
      });
      renderMyOrders(orders);
    } catch (e) {
      console.error('[Customer] Failed to fetch orders', e);
      $('orders-list').innerHTML = '<div style="text-align:center; padding: 20px; color: red;">حدث خطأ أثناء تحميل الطلبات!</div>';
    }
  }

  function renderMyOrders(orders) {
    const list = $('orders-list');
    if (!list) return;

    if (orders.length === 0) {
      list.innerHTML = '<div style="text-align:center; padding: 20px; color: var(--text-muted);">لا توجد طلبات سابقة</div>';
      return;
    }

    const statusMap = {
      'pending':    { label: 'قيد المعالجة ⏳', color: '#f59e0b' },
      'processing': { label: 'جاري التجهيز 🔄',  color: '#3b82f6' },
      'ready':      { label: 'جاهز للاستلام ✅',  color: '#10b981' },
    };

    list.innerHTML = orders.map(o => {
      const st        = statusMap[o.status] || { label: o.status, color: '#888' };
      const itemsList = (o.items || []).map(i => `<div>- ${i.name} (x${i.qty})</div>`).join('');

      const editBtn = o.status === 'pending'
        ? `<button class="btn btn--secondary edit-order-btn" data-id="${o.id}" style="margin-top: 12px; width: 100%; padding: 8px; font-size: 13px; background: var(--bg); border: 1px solid var(--accent); color: var(--accent); border-radius: 6px; cursor: pointer;">✏️ تعديل الطلب</button>`
        : '';

      let actionBtn = '';
      if (o.status === 'ready') {
        actionBtn = `<button class="btn btn--secondary delete-order-btn" data-id="${o.id}" style="margin-top: 8px; width: 100%; padding: 8px; font-size: 13px; color: #ef4444; border: 1px solid #ef4444; background: transparent; cursor: pointer; border-radius: 6px;">🗑️ حذف الطلب المنتهي</button>`;
      } else if (o.status === 'pending') {
        actionBtn = `<button class="btn btn--secondary cancel-order-btn" data-id="${o.id}" style="margin-top: 8px; width: 100%; padding: 8px; font-size: 13px; color: #ef4444; border: 1px solid #ef4444; background: transparent; cursor: pointer; border-radius: 6px;">❌ إلغاء الطلب</button>`;
      }

      return `
        <div style="background: var(--surface); padding: 16px; border-radius: 8px; border: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <div style="display:flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 8px;">
            <strong style="font-size: 14px; color: var(--text-primary);">${o.id}</strong>
            <span style="font-size: 12px; padding: 4px 8px; border-radius: 4px; background: ${st.color}20; color: ${st.color}; font-weight: bold;">${st.label}</span>
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
            ${o.timestamp ? new Date(o.timestamp.toDate ? o.timestamp.toDate() : o.timestamp).toLocaleString('ar-MA') : ''}
          </div>
          <div style="font-size: 13px; color: var(--text-primary); margin-bottom: 12px;">${itemsList}</div>
          <div style="font-size: 14px; font-weight: bold; color: var(--accent); text-align: left;">
            الإجمالي: ${(o.items || []).reduce((sum, i) => sum + (i.price * i.qty), 0).toFixed(2)}DH
          </div>
          <div style="display: flex; flex-direction: column; gap: 4px;">
            ${editBtn}
            ${actionBtn}
          </div>
        </div>
      `;
    }).join('');

    $$('.delete-order-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!confirm('هل أنت متأكد من حذف هذا الطلب المنتهي؟')) return;
        const orderId = e.target.dataset.id;
        try {
          await deleteDoc(doc(db, 'orders', orderId));
          showToast('تم حذف الطلب بنجاح', 'success');
          const phone = $('customer-phone')?.value.trim() || localStorage.getItem('pos_customer_phone');
          if (phone) fetchMyOrders(phone);
        } catch (err) {
          console.error(err);
          showToast('خطأ أثناء الحذف', 'error');
        }
      });
    });

    $$('.cancel-order-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        if (!confirm('هل أنت متأكد من إلغاء هذا الطلب؟')) return;
        const orderId = e.target.dataset.id;
        try {
          await deleteDoc(doc(db, 'orders', orderId));
          showToast('تم إلغاء الطلب بنجاح', 'success');
          const phone = $('customer-phone')?.value.trim() || localStorage.getItem('pos_customer_phone');
          if (phone) fetchMyOrders(phone);
        } catch (err) {
          console.error(err);
          showToast('خطأ أثناء الإلغاء', 'error');
        }
      });
    });

    $$('.edit-order-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const orderId = e.target.dataset.id;
        const order   = orders.find(o => o.id === orderId);
        if (order) {
          cart = {};
          (order.items || []).forEach(i => { cart[i.id] = i.qty; });
          editingOrderId = order.id;
          updateCartUI();
          $('submit-order').textContent = 'تحديث الطلب';
          $('orders-drawer').classList.remove('active');
          $('cart-drawer').classList.add('active');
        }
      });
    });
  }

  function renderCategories() {
    const catContainer = $('categories-container');
    if (catContainer) {
      const shelvesHTML = catalog.shelves.map(s =>
        `<button class="cat-btn ${currentCategory === s.id ? 'active' : ''}" data-id="${s.id}">${s.icon} ${s.name}</button>`
      ).join('');
      catContainer.innerHTML = 
        `<button class="cat-btn ${currentCategory === 'new-arrivals' ? 'active' : ''}" data-id="new-arrivals" style="color:var(--accent); border-color:var(--accent);">🌟 وصل حديثاً</button>` +
        `<button class="cat-btn ${currentCategory === 'all' ? 'active' : ''}" data-id="all">الكل</button>` + 
        shelvesHTML;

      $$('.cat-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          $$('.cat-btn').forEach(b => b.classList.remove('active'));
          e.target.classList.add('active');
          currentCategory = e.target.dataset.id;
          renderProducts();
        });
      });
    }
  }

  // ── Render Products ────────────────────────────────────
  function renderProducts() {
    const container = $('products-container');
    if (!container) return;

    let filtered = catalog.products;
    if (currentCategory === 'new-arrivals') {
      filtered = [...catalog.products].sort((a,b) => b.id.localeCompare(a.id)).slice(0, 20);
    } else if (currentCategory !== 'all') {
      filtered = filtered.filter(p => p.shelfId === currentCategory);
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div style="grid-column: span 2; text-align:center; padding: 20px; color:#888;">لا توجد منتجات في هذا التصنيف</div>';
      return;
    }

    container.innerHTML = filtered.map(p => {
      const imgSrc    = p.imageUrl || p.image;
      const imgBlock  = imgSrc
        ? `<div class="product-img-wrap"><img src="${imgSrc}" loading="lazy" onclick="window.openZoomModal(this.src)" alt="${p.name}"></div>`
        : `<div class="product-img-emoji">${p.emoji || '📦'}</div>`;
      const hasVariants = p.variants && p.variants.length > 0;
      const variantsHint = hasVariants
        ? `<div class="product-variants-hint">🎨 ${p.variants.length} خيارات</div>`
        : '';
      const priceText = hasVariants
        ? `من ${Math.min(...p.variants.map(v => v.price)).toFixed(2)} <span class="currency">DH</span>`
        : `${p.price.toFixed(2)} <span class="currency">DH</span>`;
      return `
        <div class="product-card" data-pid="${p.id}">
          ${imgBlock}
          <div class="product-card-body">
            <div class="product-name">${p.name}</div>
            ${variantsHint}
            <div class="product-price">${priceText}</div>
            <div class="card-action-container" data-id="${p.id}"></div>
          </div>
        </div>
      `;
    }).join('');

    updateCartUI();
  }

  // ── Variant Picker Modal ───────────────────────────────
  function openVariantPicker(product) {
    // Remove any existing picker
    const old = document.getElementById('variant-picker-modal');
    if (old) old.remove();

    const variants = product.variants || [];
    const typeIcon = v => v.type === 'color' ? '🎨' : '📏';
    const unitStr  = v => v.unit ? ` ${v.unit}` : '';

    let variantQs = new Array(variants.length).fill(0);
    // Auto-select 1 for the first variant if there's only one, otherwise keep 0s
    if (variants.length === 1) variantQs[0] = 1;

    const modal = document.createElement('div');
    modal.id = 'variant-picker-modal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(7,9,15,.85);backdrop-filter:blur(10px);display:flex;align-items:flex-end;justify-content:center;';
    
    function renderModalContent() {
      let totalPrice = 0;
      let totalItems = 0;
      variants.forEach((v, i) => {
        totalPrice += v.price * variantQs[i];
        totalItems += variantQs[i];
      });

      modal.innerHTML = `
        <div style="
          background:var(--bg-elevated,#13161f); border-radius:20px 20px 0 0;
          border:1px solid var(--border,#2a2d3a); padding:28px 20px 32px;
          width:100%; max-width:480px; box-shadow:0 -10px 40px rgba(0,0,0,.5);
          animation: slideUp .25s ease;
        ">
          <style>@keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}</style>
          <div style="text-align:center; margin-bottom:20px;">
            <div style="font-size:22px; font-weight:700; color:var(--text-primary,#e2e8f0);">${product.name}</div>
            <div style="font-size:13px; color:var(--text-muted,#64748b); margin-top:4px;">حدد الكميات للأنواع المطلوبة</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:10px; max-height:50vh; overflow-y:auto; margin-bottom: 20px;">
            ${variants.map((v, i) => `
              <div style="
                display:flex; justify-content:space-between; align-items:center;
                background:${variantQs[i] > 0 ? 'rgba(99,102,241,0.1)' : 'var(--bg-glass-lite,#1e2130)'}; 
                border:2px solid ${variantQs[i] > 0 ? 'var(--accent,#6366f1)' : 'var(--border,#2a2d3a)'};
                border-radius:12px; padding:12px 16px; transition:.15s;
                color:var(--text-primary,#e2e8f0); font-size:15px;
              ">
                <div style="display:flex; flex-direction:column;">
                  <span style="font-weight:600;">${typeIcon(v)} ${v.label}${unitStr(v)}</span>
                  <span style="font-weight:700; color:var(--accent,#6366f1); font-size:13px; margin-top:4px;">${v.price.toFixed(2)}DH</span>
                </div>
                
                <div style="display:flex; align-items:center; gap:8px; background: rgba(0,0,0,0.3); border-radius: 8px; padding: 4px;">
                  <button class="var-dec" data-vi="${i}" style="width:32px;height:32px;border-radius:6px;border:none;background:var(--surface);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;">-</button>
                  <span style="width:24px;text-align:center;font-weight:bold;font-size:16px;">${variantQs[i]}</span>
                  <button class="var-inc" data-vi="${i}" style="width:32px;height:32px;border-radius:6px;border:none;background:var(--accent,#6366f1);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;">+</button>
                </div>
              </div>
            `).join('')}
          </div>
          
          <div style="display:flex; gap:10px;">
            <button id="variant-picker-close" style="
              flex:1; padding:14px; background:transparent; border:1px solid var(--border,#2a2d3a);
              border-radius:12px; color:var(--text-muted,#64748b); font-size:15px; cursor:pointer; font-weight:600;
            ">إلغاء</button>
            <button id="variant-picker-add" ${totalItems === 0 ? 'disabled' : ''} style="
              flex:2; padding:14px; background:var(--accent,#6366f1); border:none;
              border-radius:12px; color:#fff; font-size:15px; font-weight:bold; cursor:pointer;
              opacity:${totalItems === 0 ? '0.5' : '1'}; transition: 0.2s;
            ">إضافة للسلة (${totalPrice.toFixed(2)}DH)</button>
          </div>
        </div>
      `;

      // Attach events to the new innerHTML
      modal.querySelectorAll('.var-dec').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const vi = parseInt(btn.dataset.vi);
          if (variantQs[vi] > 0) {
            variantQs[vi]--;
            renderModalContent();
          }
        });
      });

      modal.querySelectorAll('.var-inc').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const vi = parseInt(btn.dataset.vi);
          variantQs[vi]++;
          renderModalContent();
        });
      });

      modal.querySelector('#variant-picker-close').addEventListener('click', () => modal.remove());

      const addBtn = modal.querySelector('#variant-picker-add');
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          if (totalItems === 0) return;
          
          let addedLabels = [];
          variants.forEach((v, i) => {
            const qty = variantQs[i];
            if (qty > 0) {
              const key = `${product.id}:${v.label}`;
              cart[key] = (cart[key] || 0) + qty;
              if (!window._variantPrices) window._variantPrices = {};
              window._variantPrices[key] = { price: v.price, productId: product.id, label: v.label, unitStr: unitStr(v) };
              addedLabels.push(`${v.label} (x${qty})`);
            }
          });
          
          modal.remove();
          updateCartUI();
          showToast(`✅ تمت الإضافة: ${addedLabels.join('، ')}`, 'success');
        });
      }
    }

    renderModalContent();
    document.body.appendChild(modal);

  }

  // ── Cart UI ──────────────────────────────────────────
  function getCartItemPrice(key) {
    if (window._variantPrices && window._variantPrices[key]) return window._variantPrices[key].price;
    const p = catalog.products.find(p => p.id === key);
    return p ? p.price : 0;
  }

  function getCartItemProductId(key) {
    return key.includes(':') ? key.split(':')[0] : key;
  }

  function updateCartUI() {
    let count = 0;
    let total = 0;
    Object.keys(cart).forEach(key => {
      const price = getCartItemPrice(key);
      count += cart[key];
      total += price * cart[key];
    });

    if ($('cart-count'))          $('cart-count').textContent = count;
    if ($('cart-total'))          $('cart-total').textContent = total.toFixed(2) + 'DH';
    if ($('drawer-total-price'))  $('drawer-total-price').textContent = total.toFixed(2) + 'DH';

    const cartBar = $('cart-bar');
    if (cartBar) cartBar.style.display = count > 0 ? 'flex' : 'none';
    if (count === 0) $('cart-drawer')?.classList.remove('active');

    renderDrawerItems();

    $$('.product-card').forEach(card => {
      const container = card.querySelector('.card-action-container');
      if (!container) return;
      const pid = container.dataset.id;
      const product = catalog.products.find(p => p.id === pid);
      const hasVariants = product && product.variants && product.variants.length > 0;

      const totalQty = Object.keys(cart).filter(k => k === pid || k.startsWith(pid + ':')).reduce((s, k) => s + (cart[k] || 0), 0);

      let badge = card.querySelector('.cart-badge');
      if (hasVariants) {
        if (totalQty > 0) {
          card.classList.add('in-cart');
          container.innerHTML = `<button class="add-btn" data-id="${pid}">+ إضافة نوع آخر</button>`;
          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'cart-badge';
            card.prepend(badge);
          }
          badge.textContent = totalQty;
        } else {
          card.classList.remove('in-cart');
          container.innerHTML = `<button class="add-btn" data-id="${pid}">اختر نوع</button>`;
          if (badge) badge.remove();
        }
      } else {
        const qty = cart[pid] || 0;
        if (qty > 0) {
          card.classList.add('in-cart');
          container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; width:100%; background:#f8fafc; border:1.5px solid var(--accent); border-radius:8px; overflow:hidden;">
              <button class="qty-btn dec-btn-grid" data-id="${pid}" style="border:none; padding:8px 14px; background:transparent; color:var(--accent); cursor:pointer; font-size:18px; font-weight:bold;">-</button>
              <div style="font-weight:800; color:var(--accent); font-size:15px;">${qty}</div>
              <button class="qty-btn inc-btn-grid" data-id="${pid}" style="border:none; padding:8px 14px; background:transparent; color:var(--accent); cursor:pointer; font-size:18px; font-weight:bold;">+</button>
            </div>
          `;
          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'cart-badge';
            card.prepend(badge);
          }
          badge.textContent = qty;
        } else {
          card.classList.remove('in-cart');
          container.innerHTML = `<button class="add-btn" data-id="${pid}">أضف للسلة</button>`;
          if (badge) badge.remove();
        }
      }
    });
  }

  function renderDrawerItems() {
    const drawerItems = $('drawer-cart-items');
    if (!drawerItems) return;

    let itemsHTML = Object.keys(cart).map(key => {
      const pid = getCartItemProductId(key);
      const p   = catalog.products.find(p => p.id === pid);
      if (!p) return '';
      const price    = getCartItemPrice(key);
      const varInfo  = window._variantPrices?.[key];
      const varLabel = varInfo ? `<span style="font-size:11px; color:var(--accent);">${varInfo.label}${varInfo.unitStr}</span>` : '';
      return `
        <div class="cart-item">
          <div class="cart-item-info">
            <div class="cart-item-name">${p.name} ${varLabel}</div>
            <div class="cart-item-price">
              ${cart[key] > 1 ? `<span style="color:var(--text-muted); font-size:11px; margin-left:4px;">${price.toFixed(2)}DH &times; ${cart[key]} =</span>` : ''}
              ${(price * cart[key]).toFixed(2)}DH
            </div>
          </div>
          <div class="cart-item-controls">
            <button class="qty-btn dec-btn" data-key="${key}">-</button>
            <div class="qty-display">${cart[key]}</div>
            <button class="qty-btn inc-btn" data-key="${key}">+</button>
          </div>
        </div>
      `;
    }).join('');

    if (!itemsHTML) {
      itemsHTML = '<div style="text-align:center; padding: 20px; color: var(--text-muted);">السلة فارغة</div>';
    }

    drawerItems.innerHTML = itemsHTML;

    $$('.inc-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { const k = e.target.dataset.key; cart[k]++; updateCartUI(); });
    });
    $$('.dec-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const k = e.target.dataset.key;
        if (cart[k] > 1) { cart[k]--; } else { delete cart[k]; }
        updateCartUI();
      });
    });
  }

  // ── Drawer / Cart Bar Events ─────────────────────────────
  $('open-checkout')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('cart-drawer').classList.add('active');
  });

  $('cart-bar')?.addEventListener('click', () => {
    $('cart-drawer').classList.add('active');
  });

  $('close-drawer')?.addEventListener('click', () => {
    $('cart-drawer').classList.remove('active');
    if (editingOrderId) {
      editingOrderId = null;
      cart = {};
      updateCartUI();
      if ($('submit-order')) $('submit-order').textContent = 'تأكيد الطلب وإرسال';
    }
  });

  $('add-more-products-btn')?.addEventListener('click', () => {
    $('cart-drawer').classList.remove('active');
  });

  // ── Orders Drawer ─────────────────────────────────────────
  $('open-my-orders')?.addEventListener('click', () => {
    $('orders-drawer').classList.add('active');
    
    // Check if phone exists
    const phone = $('customer-phone')?.value.trim() || localStorage.getItem('pos_customer_phone');
    if (phone) {
      fetchMyOrders(phone);
    } else {
      $('orders-phone-prompt').style.display = 'block';
      $('orders-list').style.display = 'none';
      if ($('logout-orders-btn')) $('logout-orders-btn').style.display = 'none';
    }
  });

  $('fetch-orders-btn')?.addEventListener('click', () => {
    const phone = $('orders-phone-input')?.value.trim();
    if (phone) {
      localStorage.setItem('pos_customer_phone', phone);
      if ($('customer-phone')) $('customer-phone').value = phone;
      fetchMyOrders(phone);
    } else {
      showToast('يرجى إدخال رقم الهاتف', 'warning');
    }
  });

  // Global Image Zoom handler
  window.openZoomModal = function(src) {
    const zoomModal = document.getElementById('image-zoom-modal');
    const zoomTarget = document.getElementById('image-zoom-target');
    if (zoomModal && zoomTarget) {
      zoomTarget.src = src;
      zoomModal.style.display = 'flex';
    }
  };

  const zoomModal = document.getElementById('image-zoom-modal');
  if (zoomModal) {
    zoomModal.addEventListener('click', () => {
      zoomModal.style.display = 'none';
    });
  }

  $('close-orders-drawer')?.addEventListener('click', () => {
    $('orders-drawer').classList.remove('active');
  });

  $('logout-orders-btn')?.addEventListener('click', () => {
    localStorage.removeItem('pos_customer_phone');
    if ($('customer-phone')) $('customer-phone').value = '';
    if ($('orders-phone-input')) $('orders-phone-input').value = '';
    $('orders-list').style.display = 'none';
    $('orders-phone-prompt').style.display = 'block';
    if ($('logout-orders-btn')) $('logout-orders-btn').style.display = 'none';
  });

  // ── Submit Order (write to Firestore) ────────────────────
  $('submit-order')?.addEventListener('click', async () => {
    const name  = $('customer-name')?.value.trim();
    const phone = $('customer-phone')?.value.trim();

    if (!name || !phone) {
      alert('يرجى إدخال الاسم ورقم الهاتف');
      return;
    }

    const submitBtn = $('submit-order');
    submitBtn.textContent = 'جاري الإرسال...';
    submitBtn.disabled    = true;

    // Build items array (supports plain and variant cart keys)
    const items = [];
    Object.keys(cart).forEach(key => {
      const pid      = getCartItemProductId(key);
      const p        = catalog.products.find(p => p.id === pid);
      if (!p) return;
      const price    = getCartItemPrice(key);
      const varInfo  = window._variantPrices?.[key];
      const varLabel = varInfo ? `${varInfo.label}${varInfo.unitStr}` : null;
      items.push({
        id:      p.id,
        name:    p.name + (varLabel ? ` — ${varLabel}` : ''),
        price,
        qty:     cart[key],
        variant: varLabel || null,
      });
    });

    // Persist customer info locally
    localStorage.setItem('pos_customer_name',  name);
    localStorage.setItem('pos_customer_phone', phone);

    const orderPayload = {
      customerName:  name,
      customerPhone: phone,
      items,
      status:    'pending',
      timestamp: serverTimestamp(),
      updatedAt: Date.now(),
    };

    try {
      if (editingOrderId) {
        // ── Update existing order in Firestore ──
        const orderRef = doc(db, 'orders', editingOrderId);
        await setDoc(orderRef, {
          items,
          customerName:  name,
          customerPhone: phone,
          timestamp:     serverTimestamp(),
          updatedAt:     Date.now(),
        }, { merge: true });
        alert('تم تحديث طلبك بنجاح!');
      } else {
        // ── Create new order in Firestore ──
        await addDoc(collection(db, 'orders'), orderPayload);
        alert('تم إرسال طلبك بنجاح! سيتم التواصل معك قريباً.');
      }

      cart = {};
      editingOrderId = null;
      updateCartUI();
      $('cart-drawer').classList.remove('active');
      fetchMyOrders(phone);

    } catch (e) {
      console.error('[Customer] Order submit error:', e);
      alert('تعذر إرسال الطلب. يرجى التحقق من الاتصال بالإنترنت.');
    } finally {
      submitBtn.textContent = 'تأكيد الطلب وإرسال';
      submitBtn.disabled    = false;
    }
  });

  // ── Start ─────────────────────────────────────────────────
  await loadCatalog();
});
