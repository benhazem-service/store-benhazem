import { db } from './firebase-config.js';
import { collection, addDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// DOM Elements
const $ = id => document.getElementById(id);
const loginBtn = $('login-btn');
const pinInput = $('admin-password');
const loginOverlay = $('login-overlay');
const syncStatus = $('sync-status');
let cachedShelves = [];

document.addEventListener('DOMContentLoaded', () => {
  // Login Logic
  if (localStorage.getItem('remote_admin_logged_in') === 'true') {
    loginOverlay.style.display = 'none';
    initData();
  } else {
    loginBtn.addEventListener('click', () => {
      // Convert Arabic numerals
      let val = pinInput.value.trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
      if (val === '1988') {
        localStorage.setItem('remote_admin_logged_in', 'true');
        loginOverlay.style.display = 'none';
        initData();
      } else {
        $('login-error').style.display = 'block';
        setTimeout(() => $('login-error').style.display = 'none', 2000);
        pinInput.value = '';
      }
    });
    pinInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') loginBtn.click(); });
  }
});

// Toast System
function showToast(message, type = 'success') {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  toast.innerHTML = `<span class="toast__icon">${icons[type] || '✓'}</span><span>${message}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast--visible'));
  setTimeout(() => {
    toast.classList.remove('toast--visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

async function initData() {
  syncStatus.innerHTML = '<span class="loader" style="width:10px;height:10px;border-width:1px;"></span> جاري التحميل...';
  syncStatus.style.color = '#f59e0b';
  
  try {
    // Fetch Shelves
    const shelvesSnap = await getDocs(query(collection(db, 'catalog/shelves/items'), orderBy('position', 'asc')));
    cachedShelves = shelvesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    
    const shelfSelect = $('product-shelf-select');
    shelfSelect.innerHTML = cachedShelves.map(s => `<option value="${s.id}">${s.icon} ${s.name}</option>`).join('');
    
    // Listen to Products (Live updates from POS)
    onSnapshot(collection(db, 'catalog/products/items'), (snapshot) => {
      const products = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      renderProducts(products);
    });

    syncStatus.innerHTML = '🟢 متصل';
    syncStatus.style.color = '#10b981';
  } catch (e) {
    console.error(e);
    syncStatus.innerHTML = '🔴 خطأ اتصال';
    syncStatus.style.color = '#ef4444';
    showToast('فشل في الاتصال بقاعدة البيانات', 'error');
  }
}

function renderProducts(products) {
  $('products-count').textContent = products.length;
  const grid = $('products-grid');
  
  if (products.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 40px;">لا توجد منتجات حالياً. أضف منتجك الأول من الأعلى!</div>';
    return;
  }

  // Sort products alphabetically
  products.sort((a,b) => a.name.localeCompare(b.name));

  grid.innerHTML = products.map(p => {
    const shelf = cachedShelves.find(s => s.id === p.shelfId);
    const shelfBadge = shelf ? `<span style="font-size: 11px; background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 10px;">${shelf.name}</span>` : '';
    
    let media = p.image 
      ? `<img src="${p.image}" style="width: 100%; height: 80px; object-fit: cover; border-radius: var(--radius) var(--radius) 0 0;" loading="lazy">` 
      : `<div style="font-size: 40px; height: 80px; display:flex; align-items:center; justify-content:center; background: rgba(255,255,255,0.02);">${p.emoji || '📦'}</div>`;

    return `
      <div style="background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); display: flex; flex-direction: column;">
        ${media}
        <div style="padding: 10px; display: flex; flex-direction: column; gap: 4px;">
          <strong style="font-size: 13px; line-height: 1.2;">${p.name}</strong>
          <div style="color: var(--accent); font-weight: bold; font-size: 14px;">${p.price.toFixed(2)}DH</div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
            <span style="font-size: 12px; color: var(--text-muted);">مخزون: <span style="color: ${p.stock <= 5 ? 'var(--danger)' : '#fff'};">${p.stock}</span></span>
            ${shelfBadge}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Image Upload & Compression ──
let currentImageBase64 = null;
const imageInput = $('product-image-upload');
const imagePreview = $('image-preview');

function compressImage(file, callback) {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = event => {
    const img = new Image();
    img.src = event.target.result;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_SIZE = 600;
      let width = img.width;
      let height = img.height;

      if (width > height && width > MAX_SIZE) {
        height *= MAX_SIZE / width;
        width = MAX_SIZE;
      } else if (height > MAX_SIZE) {
        width *= MAX_SIZE / height;
        height = MAX_SIZE;
      }
      
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      callback(canvas.toDataURL('image/jpeg', 0.8));
    };
  };
}

imageInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  imagePreview.innerHTML = '<span class="loader" style="width:20px;height:20px;border-width:2px;"></span>';
  compressImage(file, (base64) => {
    currentImageBase64 = base64;
    imagePreview.innerHTML = `<img src="${currentImageBase64}" style="width:100%; height:100%; object-fit:cover; border-radius:inherit;" />`;
  });
});

// ── Variants Logic ──────────────────────────────────────────────
let variants = [];
const varType = $('variant-type-select');
const varUnit = $('variant-unit-select');
const varLabel = $('variant-label-input');
const varPrice = $('variant-price-input');
const varAddBtn = $('variant-add-btn');
const varList = $('variants-list');

varType.addEventListener('change', () => {
  varUnit.style.display = varType.value === 'size' ? 'block' : 'none';
});

varAddBtn.addEventListener('click', () => {
  const label = varLabel.value.trim();
  const price = parseFloat(varPrice.value);
  if (!label || isNaN(price)) {
    showToast('يرجى إدخال التسمية والسعر', 'warning');
    return;
  }
  
  variants.push({
    type: varType.value,
    label: label,
    unit: varType.value === 'size' ? varUnit.value : '',
    price: price
  });
  
  renderVariants();
  varLabel.value = '';
  varPrice.value = '';
});

function renderVariants() {
  varList.innerHTML = variants.map((v, i) => `
    <span class="product-card-tag" style="background: rgba(255,255,255,0.1); display:flex; align-items:center; gap:6px;">
      ${v.type === 'color' ? '🎨' : '📏'} ${v.label} ${v.unit} — ${v.price.toFixed(2)}DH
      <button type="button" onclick="window.removeVariant(${i})" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:16px;">&times;</button>
    </span>
  `).join('');
}

window.removeVariant = (idx) => {
  variants.splice(idx, 1);
  renderVariants();
};

// ── Form Submission ─────────────────────────────────────────────
$('product-form').addEventListener('submit', async e => {
  e.preventDefault();
  
  const name = $('product-name-input').value.trim();
  const priceStr = $('product-price-input').value;
  const stockStr = $('product-stock-input').value;
  const shelfId = $('product-shelf-select').value;
  
  if (!shelfId) {
    showToast('يجب إضافة رف (قسم) من الكاشير أولاً!', 'error');
    return;
  }
  
  if (!name || priceStr === '' || stockStr === '') {
    showToast('يرجى ملء جميع الحقول المطلوبة (الاسم، السعر، الكمية)!', 'error');
    return;
  }

  const submitBtn = $('submit-btn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="loader"></span> جاري التسجيل...';

  const productData = {
    name: $('product-name-input').value.trim(),
    price: parseFloat($('product-price-input').value),
    stock: parseInt($('product-stock-input').value),
    shelfId: $('product-shelf-select').value,
    variants: variants.length > 0 ? variants : null,
    image: currentImageBase64,
    emoji: '📦',
    createdAt: serverTimestamp()
  };

  try {
    await addDoc(collection(db, 'pending_products'), productData);
    showToast('تم الإرسال للكاشير الأساسي بنجاح! 🎉', 'success');
    
    // Reset form
    $('product-form').reset();
    variants = [];
    renderVariants();
    currentImageBase64 = null;
    imagePreview.innerHTML = '📦';
  } catch (error) {
    console.error(error);
    showToast('خطأ أثناء الإرسال! تأكد من الإنترنت.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '💾 إرسال المنتج للكاشير الأساسي';
  }
});
