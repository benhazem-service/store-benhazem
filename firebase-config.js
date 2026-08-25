// =============================================================
// firebase-config.js — Firebase SDK initialization
// Shared by both admin (index.html) and customer (customer.html)
// =============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore }  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getStorage }    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js';

const firebaseConfig = {
  apiKey:            'AIzaSyAQZEsTMSnVfueWxkVilZKW6WoCYI_FlvA',
  authDomain:        'store-managemen.firebaseapp.com',
  databaseURL:       'https://store-managemen-default-rtdb.firebaseio.com',
  projectId:         'store-managemen',
  storageBucket:     'store-managemen.firebasestorage.app',
  messagingSenderId: '975303289163',
  appId:             '1:975303289163:web:d7a414e314cda9c064a0ce',
  measurementId:     'G-62H8V2EV0E',
};

const firebaseApp = initializeApp(firebaseConfig);
const db          = getFirestore(firebaseApp);
const storage     = getStorage(firebaseApp);

export { firebaseApp, db, storage };
