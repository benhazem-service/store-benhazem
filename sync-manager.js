// =============================================================
// sync-manager.js — Dual Storage Sync Engine
// Handles: LocalStorage ↔ Firebase Firestore + Storage
// Features: Offline queue, conflict resolution, real-time orders
// =============================================================

import { db, storage } from './firebase-config.js';
import {
  doc, setDoc, deleteDoc, collection, getDocs,
  onSnapshot, writeBatch, serverTimestamp,
  query, orderBy,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  ref as storageRef,
  uploadString,
  getDownloadURL,
  deleteObject,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

// ── Constants ─────────────────────────────────────────────────
const OFFLINE_QUEUE_KEY = 'pos_offline_queue';
const SYNC_STATUS_KEY   = 'pos_last_sync';

// ── SyncManager ───────────────────────────────────────────────
export class SyncManager {
  constructor() {
    this.isOnline       = navigator.onLine;
    this._ordersUnsub   = null;   // Firestore real-time listener unsubscribe fn
    this._statusEl      = null;   // DOM element for sync indicator
    this._syncDebounce  = null;   // debounce timer for catalog sync
    this._processingQ   = false;  // guard for offline queue processing

    this._watchConnectivity();
  }

  // ── Connectivity ─────────────────────────────────────────
  _watchConnectivity() {
    window.addEventListener('online', async () => {
      this.isOnline = true;
      this._updateStatusUI('syncing');
      console.log('[Sync] 🟢 Back online — processing offline queue...');
      await this.processOfflineQueue();
      this._updateStatusUI('synced');
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this._updateStatusUI('offline');
      console.log('[Sync] 🔴 Offline — changes will be queued.');
    });
  }

  // ── Status UI ────────────────────────────────────────────
  setStatusElement(el) {
    this._statusEl = el;
    this._updateStatusUI(this.isOnline ? 'synced' : 'offline');
  }

  _updateStatusUI(state) {
    if (!this._statusEl) return;
    const states = {
      synced:  { text: '☁️ متزامن',      color: '#10b981', title: 'البيانات متزامنة مع Firebase' },
      syncing: { text: '🔄 جاري المزامنة…', color: '#f59e0b', title: 'جاري رفع التغييرات...' },
      offline: { text: '📵 بدون إنترنت',  color: '#ef4444', title: 'لا يوجد إنترنت — يعمل محلياً' },
      error:   { text: '⚠️ خطأ في المزامنة', color: '#f97316', title: 'فشل الرفع — سيُعاد المحاولة' },
    };
    const s = states[state] || states.synced;
    this._statusEl.textContent    = s.text;
    this._statusEl.style.color    = s.color;
    this._statusEl.title          = s.title;
  }

  // ── Catalog Sync (Products + Shelves + Settings) ─────────
  /**
   * Call this after every save(). Debounced to 800ms to batch rapid edits.
   * @param {object} data  — { products, shelves, settings }
   */
  scheduleCatalogSync(data) {
    clearTimeout(this._syncDebounce);
    this._syncDebounce = setTimeout(() => this.syncCatalogToFirebase(data), 800);
  }

  async syncCatalogToFirebase(data) {
    if (!this.isOnline) {
      this._queueOfflineChange({ type: 'catalog', payload: data });
      return;
    }

    this._updateStatusUI('syncing');
    try {
      const batch = writeBatch(db);

      // ── Find and Delete Removed Items ──
      const remoteProductsSnap = await getDocs(collection(db, 'catalog', 'products', 'items'));
      const remoteProducts = remoteProductsSnap.docs.map(d => d.id);
      
      const remoteShelvesSnap = await getDocs(collection(db, 'catalog', 'shelves', 'items'));
      const remoteShelves = remoteShelvesSnap.docs.map(d => d.id);

      const localProductIds = (data.products || []).map(p => String(p.id));
      const localShelfIds = (data.shelves || []).map(s => String(s.id));

      remoteProducts.forEach(id => {
        if (!localProductIds.includes(String(id))) {
          batch.delete(doc(db, 'catalog', 'products', 'items', id));
          this.deleteImageFromStorage(id, 'products').catch(()=>{});
        }
      });

      remoteShelves.forEach(id => {
        if (!localShelfIds.includes(String(id))) {
          batch.delete(doc(db, 'catalog', 'shelves', 'items', id));
        }
      });

      // ── Settings (single doc) ──
      const settingsRef = doc(db, 'catalog', 'settings');
      batch.set(settingsRef, {
        ...data.settings,
        updatedAt: serverTimestamp(),
      });

      // ── Shelves ──
      (data.shelves || []).forEach(shelf => {
        const sRef = doc(db, 'catalog', 'shelves', 'items', String(shelf.id));
        const payload = { ...shelf, updatedAt: serverTimestamp() };
        delete payload.image; // Never upload base64 to Firestore
        batch.set(sRef, payload);
      });

      // ── Products ──
      (data.products || []).forEach(product => {
        const pRef = doc(db, 'catalog', 'products', 'items', String(product.id));
        
        const payload = { ...product, updatedAt: serverTimestamp() };
        
        // Always remove the heavy base64 image from Firestore payload to prevent 1MB limit crash.
        // Images are uploaded to Firebase Storage separately, and then `imageUrl` is used.
        delete payload.image;

        batch.set(pRef, payload);
      });

      await batch.commit();
      localStorage.setItem(SYNC_STATUS_KEY, new Date().toISOString());
      this._updateStatusUI('synced');
      console.log('[Sync] ✅ Catalog synced to Firebase');
    } catch (err) {
      console.error('[Sync] ❌ Catalog sync failed:', err);
      this._updateStatusUI('error');
      // Queue for retry
      this._queueOfflineChange({ type: 'catalog', payload: data });
    }
  }

  async deleteProductFromFirebase(id) {
    if (!this.isOnline) return;
    try {
      await deleteDoc(doc(db, 'catalog', 'products', 'items', String(id)));
      console.log('[Sync] ✅ Deleted product directly from Firestore');
    } catch (err) {
      console.error('[Sync] ❌ Failed to delete product directly:', err);
    }
  }

  async pullCatalogFromFirebase() {
    if (!this.isOnline) {
      alert('لا يوجد اتصال بالإنترنت لاسترجاع البيانات!');
      return false;
    }
    this._updateStatusUI('syncing');
    try {
      console.log('[Sync] ⬇️ Pulling catalog from Firebase...');
      // db is already imported at the top of this file
      
      const productsSnap = await getDocs(collection(db, 'catalog/products/items'));
      const shelvesSnap = await getDocs(query(collection(db, 'catalog/shelves/items'), orderBy('position', 'asc')));
      
      const products = productsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      const shelves = shelvesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      
      // Update local storage
      let posData = { products: [], shelves: [], settings: {} };
      try {
        const raw = localStorage.getItem('pos3d_v1_ar');
        if (raw) posData = JSON.parse(raw);
      } catch (e) {}
      
      posData.products = products;
      posData.shelves = shelves;
      
      localStorage.setItem('pos3d_v1_ar', JSON.stringify(posData));
      console.log('[Sync] ✅ Catalog pulled successfully');
      this._updateStatusUI('synced');
      return true;
    } catch (err) {
      console.error('[Sync] ❌ Pull failed:', err);
      this._updateStatusUI('error');
      alert('فشل استرجاع البيانات: ' + err.message);
      return false;
    }
  }

  // ── Image Upload to Firebase Storage ─────────────────────
  /**
   * Upload a product/shelf image (base64 dataURL) to Firebase Storage.
   * Returns the public download URL, or null on failure.
   * @param {string} dataURL  — base64 data URL (e.g. "data:image/png;base64,...")
   * @param {string} id       — product or shelf id
   * @param {string} folder   — 'products' | 'shelves'
   */
  async uploadImageToStorage(dataURL, id, folder = 'products') {
    if (!dataURL || !this.isOnline) return null;
    try {
      const imgRef = storageRef(storage, `${folder}/${id}`);
      // Detect format from data URL
      const format = dataURL.startsWith('data:image/png') ? 'data_url' : 'data_url';
      await uploadString(imgRef, dataURL, format);
      const url = await getDownloadURL(imgRef);
      console.log(`[Sync] 🖼️ Image uploaded: ${folder}/${id}`);
      return url;
    } catch (err) {
      console.error('[Sync] Image upload failed:', err);
      return null;
    }
  }

  /**
   * Delete an image from Firebase Storage.
   */
  async deleteImageFromStorage(id, folder = 'products') {
    if (!this.isOnline) return;
    try {
      const imgRef = storageRef(storage, `${folder}/${id}`);
      await deleteObject(imgRef);
    } catch (err) {
      // Ignore "object not found" errors
      if (err.code !== 'storage/object-not-found') {
        console.warn('[Sync] Image delete failed:', err);
      }
    }
  }
  // ── Pending Products Listener (Remote Admin) ────────────────
  listenToPendingProducts(dataStore, onAddedCallback) {
    if (!this.isOnline) return;
    const q = query(collection(db, 'pending_products'), orderBy('createdAt', 'asc'));
    onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          const docId = change.doc.id;
          
          // Import product to local store
          const newProduct = {
            name: data.name,
            price: data.price,
            stock: data.stock || 0,
            shelfId: data.shelfId,
            variants: data.variants || null,
            image: data.image || null,
            emoji: data.emoji || '📦',
            cost: data.cost || 0,
            barcode: data.barcode || ''
          };
          
          dataStore.addProduct(newProduct);
          console.log(`[Sync] 📥 Imported pending product: ${data.name}`);
          
          if (onAddedCallback) onAddedCallback();
          if (window.showToast) window.showToast(`تم استقبال منتج جديد: ${data.name} 📥`, 'success');

          
          // Delete from pending queue
          deleteDoc(doc(db, 'pending_products', docId)).catch(e => console.error('[Sync] Failed to delete pending product', e));
        }
      });
    }, (error) => {
      console.error('[Sync] Pending products listener error:', error);
    });
  }

  // ── Orders: Real-time Listener ────────────────────────────
  /**
   * Start listening to new/changed orders in Firestore.
   * @param {function} callback  — called with the full orders array on any change
   */
  listenToOrders(callback) {
    if (this._ordersUnsub) this._ordersUnsub(); // detach old listener

    const q = query(collection(db, 'orders'), orderBy('timestamp', 'desc'));
    this._ordersUnsub = onSnapshot(q, (snapshot) => {
      const orders = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      callback(orders);
    }, (err) => {
      console.error('[Sync] Orders listener error:', err);
    });

    return () => this._ordersUnsub?.();
  }

  /**
   * Stop listening to orders.
   */
  stopListeningToOrders() {
    this._ordersUnsub?.();
    this._ordersUnsub = null;
  }

  // ── Orders: Write Operations ──────────────────────────────
  /**
   * Update an order's status in Firestore.
   * @param {string} orderId
   * @param {object} updates  — e.g. { status: 'processing' }
   */
  async updateOrder(orderId, updates) {
    if (!this.isOnline) {
      this._queueOfflineChange({ type: 'order_update', payload: { orderId, updates } });
      return false;
    }
    try {
      const orderRef = doc(db, 'orders', orderId);
      await setDoc(orderRef, { ...updates, updatedAt: serverTimestamp() }, { merge: true });
      return true;
    } catch (err) {
      console.error('[Sync] Order update failed:', err);
      return false;
    }
  }

  /**
   * Delete (archive) an order from Firestore.
   */
  async deleteOrder(orderId) {
    if (!this.isOnline) {
      this._queueOfflineChange({ type: 'order_delete', payload: { orderId } });
      return false;
    }
    try {
      await deleteDoc(doc(db, 'orders', orderId));
      return true;
    } catch (err) {
      console.error('[Sync] Order delete failed:', err);
      return false;
    }
  }

  // ── Offline Queue ─────────────────────────────────────────
  _queueOfflineChange(change) {
    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    } catch (_) {}

    // Deduplicate: if type is 'catalog', keep only the latest
    if (change.type === 'catalog') {
      queue = queue.filter(c => c.type !== 'catalog');
    }

    queue.push({ ...change, queuedAt: Date.now() });
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
    console.log(`[Sync] 📥 Queued offline change: ${change.type} (total: ${queue.length})`);
  }

  async processOfflineQueue() {
    if (this._processingQ || !this.isOnline) return;
    this._processingQ = true;

    let queue = [];
    try {
      queue = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
    } catch (_) {}

    if (queue.length === 0) {
      this._processingQ = false;
      return;
    }

    console.log(`[Sync] 🔄 Processing ${queue.length} offline changes...`);
    const remaining = [];

    for (const change of queue) {
      try {
        if (change.type === 'catalog') {
          await this.syncCatalogToFirebase(change.payload);
        } else if (change.type === 'order_update') {
          await this.updateOrder(change.payload.orderId, change.payload.updates);
        } else if (change.type === 'order_delete') {
          await this.deleteOrder(change.payload.orderId);
        }
      } catch (_) {
        remaining.push(change); // keep failed ones for next retry
      }
    }

    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    this._processingQ = false;

    if (remaining.length === 0) {
      console.log('[Sync] ✅ All offline changes processed.');
    } else {
      console.warn(`[Sync] ⚠️ ${remaining.length} changes still pending.`);
    }
  }

  // ── Conflict Resolution ───────────────────────────────────
  /**
   * Returns the "winner" record based on updatedAt timestamp.
   * Local wins on tie (optimistic).
   * @param {object} local   — local record with updatedAt (ms)
   * @param {object} remote  — Firestore record with updatedAt (seconds or ms)
   */
  resolveConflict(local, remote) {
    const localTs  = local?.updatedAt  || 0;
    // Firestore Timestamp objects have .toMillis(); plain numbers are ms already
    const remoteTs = typeof remote?.updatedAt?.toMillis === 'function'
      ? remote.updatedAt.toMillis()
      : (remote?.updatedAt || 0);

    return localTs >= remoteTs ? local : remote;
  }

  // ── Pending Queue Count ───────────────────────────────────
  getPendingCount() {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]').length;
    } catch (_) {
      return 0;
    }
  }
}

// Export a singleton
export const syncManager = new SyncManager();
