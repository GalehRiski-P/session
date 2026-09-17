// index.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';
import mongoose from 'mongoose';
import pino from 'pino';
import readline from 'readline';

// ============================================================
// KONFIGURASI
// ============================================================
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/wa_bot';
const PHONE_NUMBER = process.env.PHONE_NUMBER; // contoh: "6281234567890"
const SESSION_ID = 'whatsapp_session';          // key identifier sesi
const COLLECTION = 'sessionschemas';            // nama collection di MongoDB
const logger = pino({ level: 'silent' });

// ============================================================
// SCHEMA MONGOOSE (collection: sessionschemas)
// ============================================================
const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    session: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true, collection: COLLECTION }
);

const Session =
  mongoose.models.Session || mongoose.model('Session', sessionSchema);

// ============================================================
// MONGO AUTH STATE ADAPTER
// ============================================================
async function useMongoAuthState() {
  const writeData = async (data, key) => {
    const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
    await Session.findOneAndUpdate(
      { sessionId: SESSION_ID },
      { $set: { [`session.${key}`]: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  };

  const readData = async (key) => {
    try {
      const doc = await Session.findOne({ sessionId: SESSION_ID });
      if (!doc?.session?.[key]) return null;
      return JSON.parse(JSON.stringify(doc.session[key]), BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await Session.updateOne(
        { sessionId: SESSION_ID },
        { $unset: { [`session.${key}`]: '' } }
      );
    } catch {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}

// ============================================================
// HELPER
// ============================================================
function question(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function connectMongo() {
  await mongoose.connect(MONGO_URI);
  console.log('[MongoDB] Connected:', MONGO_URI);
  console.log(`[MongoDB] Collection: ${COLLECTION} | sessionId: ${SESSION_ID}`);
}

// ============================================================
// START WHATSAPP SOCKET
// ============================================================
async function startSock() {
  const { state, saveCreds } = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // pakai pairing code, bukan QR
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: Browsers.ubuntu('Chrome'), // WAJIB untuk pairing code
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ====== Pairing Code (hanya jika belum terdaftar) ======
  if (!sock.authState.creds.registered) {
    let phone = PHONE_NUMBER;
    if (!phone) {
      phone = await question('Masukkan nomor WhatsApp (contoh 6281234567890): ');
    }
    phone = phone.replace(/[^0-9]/g, '').replace(/^0/, '');

    await new Promise((r) => setTimeout(r, 3000));

    try {
      const code = await sock.requestPairingCode(phone);
      console.log('\n========================================');
      console.log('  PAIRING CODE:', code);
      console.log('========================================');
      console.log('Buka WhatsApp > Perangkat Tertaut > Tautkan dengan nomor telepon');
      console.log('Lalu masukkan kode di atas.\n');
    } catch (err) {
      console.error('Gagal meminta pairing code:', err);
    }
  } else {
    console.log(`[WA] Sesi ditemukan di ${COLLECTION} (sessionId: ${SESSION_ID}). Reconnecting...`);
  }

  // ====== Connection Update ======
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `[WA] Koneksi terputus (status: ${statusCode}). ${
          shouldReconnect ? 'Reconnect...' : 'Logged out.'
        }`
      );
      if (shouldReconnect) {
        startSock();
      } else {
        console.log(
          `[WA] Sesi invalid. Hapus dokumen sessionId="${SESSION_ID}" di collection "${COLLECTION}" lalu jalankan ulang.`
        );
      }
    } else if (connection === 'open') {
      console.log('[WA] Berhasil terhubung ke WhatsApp!');
      console.log(`[MongoDB] Sesi tersimpan di collection: ${COLLECTION}`);
    }
  });

  // ====== Handler pesan masuk ======
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      console.log(`[Pesan masuk] ${from}: ${text}`);

      // Contoh auto-reply
      if (text.toLowerCase() === 'ping') {
        await sock.sendMessage(from, { text: 'pong 🏓' }, { quoted: msg });
      }
    }
  });

  return sock;
}

// ============================================================
// BOOTSTRAP
// ============================================================
(async () => {
  try {
    await connectMongo();
    await startSock();
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on('SIGINT', async () => {
  console.log('\nMenutup koneksi...');
  await mongoose.connection.close();
  process.exit(0);
});
