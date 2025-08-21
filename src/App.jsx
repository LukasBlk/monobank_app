// Import React hooků, CSS soubory a Firebase instance
import { useState, useEffect, useRef } from "react";
import "./App.css";
import { firebaseApp } from "./firebaseConfig";
import monobank_logo_png from "./assets/monobank_logo.png";
import { motion, AnimatePresence } from "framer-motion";

// Firestore & Auth
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  onSnapshot,
  deleteDoc,
  getDocs,
  addDoc,
  query,
  orderBy,
  where,
} from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

// Inicializace Firebase
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

// --- VERZE APLIKACE ---
// --- (měň jen tady) ---
const APP_VERSION = "2.7.0";


// *********************************
// ***       Utility funkce      ***
// *********************************

// Generování náhodného GameID - 5 znaků A-Z a 0-9
const generateGameId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Formátování číselných částek podle české lokalizace
const formatAmount = (amount) => {
  return amount.toLocaleString("cs-CZ").replace(/\u00a0/g, " ");
};

// --- Wake Lock hook ---
// Použití: const { supported, locked, error } = useWakeLock(activeBoolean);
function useWakeLock(active) {
  const wakeLockRef = useRef(null);
  const [supported, setSupported] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setSupported(typeof navigator !== "undefined" && "wakeLock" in navigator);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function requestLock() {
      if (!supported || !active || wakeLockRef.current) return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) return;
        wakeLockRef.current = lock;
        setLocked(true);
        lock.addEventListener("release", () => {
          wakeLockRef.current = null;
          setLocked(false);
        });
      } catch (e) {
        setError(e?.message || String(e));
        setLocked(false);
      }
    }

    requestLock();

    const onVisibility = () => {
      if (document.visibilityState === "visible" && active && !wakeLockRef.current) {
        requestLock();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => { });
        wakeLockRef.current = null;
      }
      setLocked(false);
    };
  }, [active, supported]);

  return { supported, locked, error };
}

// *********************************
// ***      Hlavní komponenta    ***
// *********************************
export default function App() {
  const [userId, setUserId] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  const [players, setPlayers] = useState([]);
  const [name, setName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [transactions, setTransactions] = useState([]);

  const [gameId, setGameId] = useState("");
  const [gamePassword, setGamePassword] = useState("");
  const [gameControl, setGameControl] = useState(null);
  const [joining, setJoining] = useState(null);

  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [startBalance, setStartBalance] = useState("");
  const [startBonus, setStartBonus] = useState("");

  const [showTransferModal, setShowTransferModal] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [transferAmount, setTransferAmount] = useState("");
  const [modalContext, setModalContext] = useState("transfer");

  const inputRef = useRef(null);
  const autoJoinRef = useRef(false); // hlídá, abychom join nespouštěli opakovaně

  const [wakeLockEnabled, setWakeLockEnabled] = useState(true);

  // ⚙️ actions menu
  const [showActions, setShowActions] = useState(false);

  // Vibrace při příchozí platbě
  const [vibrateEnabled, setVibrateEnabled] = useState(true);
  const vibrateSupported =
    typeof navigator !== "undefined" && typeof navigator.vibrate === "function";


  // --- Toast notifikace ---
  const [toasts, setToasts] = useState([]);
  const notifiedTxIdsRef = useRef(new Set());   // které tx už jsme ohlásili
  const adminTxInitRef = useRef(false);         // přeskočit první snapshot admin listeneru
  const toMeInitRef = useRef(false);            // přeskočit první snapshot qToMe

  const showToast = (text, ttl = 5000) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(arr => [...arr, { id, text }]);
    setTimeout(() => {
      setToasts(arr => arr.filter(t => t.id !== id));
    }, ttl);
    return id;
  };

  // --- aktuální jména hráčů dostupná i uvnitř snapshot listenerů ---
  const playersByIdRef = useRef(new Map());

  useEffect(() => {
    playersByIdRef.current = new Map(players.map(p => [p.id, p.name]));
  }, [players]);

  function displayName(uid) {
    if (!uid) return "BANKA";                 // null/undefined => banka
    return playersByIdRef.current.get(uid) ?? "neznámý hráč";
  }

  // --- Zobrazení PopUp Toastup pro příchozí transakce
  const notifyForDoc = (snapDoc) => {
    const t = snapDoc.data();
    // jen příchozí transakce pro mě
    if (!t || t.to !== userId) return;

    // jméno odesílatele (hráč / BANKA)
    const fromName = t.from
      ? (players.find((p) => p.id === t.from)?.name || "neznámý hráč")
      : "BANKA";

    const msg = `${fromName} Vám posílá $${formatAmount(t.amount)}`;

    // neduplikovat notifikaci pro stejnou transakci
    if (notifiedTxIdsRef.current.has(snapDoc.id)) return;
    notifiedTxIdsRef.current.add(snapDoc.id);

    // 📳 vibrace (pokud je podporováno a povoleno)
    if (vibrateSupported && vibrateEnabled) {
      try {
        navigator.vibrate([80, 40, 80]); // bzz–pauza–bzz
      } catch { }
    }

    // toast (zavírá se sám)
    showToast(msg);
  };




  // Autofokus inputu při otevření modalu
  useEffect(() => {
    if (showTransferModal && inputRef.current) {
      setTimeout(() => {
        inputRef.current.focus();
      }, 150);
    }
  }, [showTransferModal]);

  // Přihlášení: počkej, až bude auth ready (onAuthStateChanged)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        if (user) {
          setUserId(user.uid);
        } else {
          const res = await signInAnonymously(auth);
          setUserId(res.user.uid);
        }
      } catch (e) {
        console.error("Auth error:", e);
      } finally {
        setAuthReady(true);
      }
    });
    return () => unsub();
  }, []);

  // Realtime snapshoty hráčů a transakcí (až když je auth + gameId)
  useEffect(() => {
    if (!authReady || !userId || !gameId) return;

    const playersRef = collection(db, "games", gameId, "players");
    const unsubP = onSnapshot(playersRef, (snapshot) => {
      const list = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
      setPlayers(list);
      const me = list.find((p) => p.id === userId);
      setIsAdmin(me?.isAdmin === true);
    });

    let unsubT = () => { };
    const txRef = collection(db, "games", gameId, "transactions");

    if (isAdmin) {
      const qAll = query(txRef, orderBy("timestamp", "desc"));
      unsubT = onSnapshot(qAll, (snapshot) => {
        const all = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setTransactions(all);
        if (!adminTxInitRef.current) {
          adminTxInitRef.current = true;   // první dávka – jen naplnit, neupozorňovat zpětně
          return;
        }
        snapshot.docChanges().forEach((ch) => {
          if (ch.type === "added") notifyForDoc(ch.doc);
        });
      }, (err) => console.error("TX admin listener error:", err));

    } else {
      // jen transakce, které se mě týkají
      const qFromMe = query(txRef, where("from", "==", userId));
      const qToMe = query(txRef, where("to", "==", userId));

      // jednoduchá cache pro sloučení výsledků dvou listenerů
      const cache = { fromMe: [], toMe: [] };

      const mergeAndSet = () => {
        const map = new Map();
        for (const d of [...cache.fromMe, ...cache.toMe]) {
          map.set(d.id, { id: d.id, ...d.data() }); // de-dup
        }
        const rows = Array.from(map.values()).sort(
          (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)
        );
        setTransactions(rows);
      };

      const u1 = onSnapshot(
        qFromMe,
        (snap) => { cache.fromMe = snap.docs; mergeAndSet(); },
        (e) => console.error("qFromMe", e)
      );
      const u2 = onSnapshot(
        qToMe,
        (snap) => {
          cache.toMe = snap.docs; mergeAndSet();
          if (!toMeInitRef.current) {
            toMeInitRef.current = true;   // první dávka – žádné retro notifikace
            return;
          }
          snap.docChanges().forEach((ch) => {
            if (ch.type === "added") notifyForDoc(ch.doc);
          });
        },
        (e) => console.error("qToMe", e)
      );

      unsubT = () => { u1(); u2(); };
    }


    return () => {
      unsubP();
      unsubT();
      notifiedTxIdsRef.current = new Set();
      adminTxInitRef.current = false;
      toMeInitRef.current = false;

    };
  }, [authReady, userId, gameId, isAdmin, refreshKey]);

  // Vytvoření hry
  const createGame = async () => {
    if (!authReady || !auth.currentUser) return;
    if (!name || !gamePassword) return;

    setLoading(true);
    try {
      const newGameId = generateGameId();
      const controlRef = doc(db, "games", newGameId, "control", "control");

      await setDoc(controlRef, {
        adminId: userId,
        password: gamePassword,
        startBalance: Number(startBalance) || 0,
        startBonus: Number(startBonus) || 0,
      });

      await setDoc(doc(db, "games", newGameId, "players", userId), {
        name,
        balance: Number(startBalance) || 0,
        isAdmin: true,
      });

      setGameId(newGameId);
      setGameControl({
        adminId: userId,
        password: gamePassword,
        startBalance: Number(startBalance) || 0,
        startBonus: Number(startBonus) || 0,
      });

      localStorage.setItem(
        "monobankSession",
        JSON.stringify({
          gameId: newGameId,
          name,
          gamePassword, // sjednocený klíč
        })
      );

      setJoining("join");
    } catch (err) {
      console.error(err);
      alert(`Chyba při zakládání hry: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  // Připojení do hry
  async function joinGame() {
    if (!authReady || !auth.currentUser) return;
    if (!name || !gameId) return;

    setLoading(true);
    try {
      const controlRef = doc(db, "games", gameId, "control", "control");
      const controlSnap = await getDoc(controlRef);
      if (!controlSnap.exists()) {
        alert("Hra neexistuje.");
        return;
      }

      const controlData = controlSnap.data();
      if (controlData.password && controlData.password !== gamePassword) {
        alert("Nesprávné heslo.");
        return;
      }

      setGameControl(controlData);

      const playerRef = doc(db, "games", gameId, "players", userId);
      const playerSnap = await getDoc(playerRef);
      if (!playerSnap.exists()) {
        await setDoc(playerRef, {
          name,
          balance: Number(controlData.startBalance ?? 1500),
          isAdmin: false,
        });
      }

      localStorage.setItem(
        "monobankSession",
        JSON.stringify({
          gameId,
          name,
          gamePassword, // sjednocený klíč
        })
      );
    } catch (err) {
      console.error(err);
      alert(`Chyba při připojení do hry: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }

  // Autologin: načti uloženou session a předvyplň landing (pro F5 reload)
  useEffect(() => {
    const raw = localStorage.getItem("monobankSession");
    if (!raw) return;
    try {
      const { gameId: savedId, name: savedName, gamePassword: savedPwd } =
        JSON.parse(raw) || {};
      if (savedId && savedName) {
        setName(savedName);
        setGameId(savedId);
        setGamePassword(savedPwd || "");
        setJoining("join");
      }
    } catch {
      localStorage.removeItem("monobankSession");
    }
  }, []);

  // Autologin trigger: jakmile máme auth + předvyplněné hodnoty, zkus joinGame JEDNOU
  useEffect(() => {
    if (!authReady) return;
    if (!userId) return;
    if (autoJoinRef.current) return;
    if (joining === "join" && gameId && name) {
      autoJoinRef.current = true;
      joinGame();
    }
  }, [authReady, userId, joining, gameId, name]);

  // Vynucení refreshe dat (přes re-subscribe)
  const manualRefresh = () => setRefreshKey((prev) => prev + 1);

  // Udělení startovního bonusu hráči
  const grantStartBonus = async (playerId) => {
    const controlRef = doc(db, "games", gameId, "control", "control");
    const controlSnap = await getDoc(controlRef);
    const bonus = controlSnap.exists() ? controlSnap.data().startBonus ?? 200 : 200;

    const ref = doc(db, "games", gameId, "players", playerId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    await updateDoc(ref, { balance: data.balance + bonus });

    await addDoc(collection(db, "games", gameId, "transactions"), {
      from: null,
      to: playerId,
      amount: bonus,
      timestamp: Date.now(),
      type: "start-bonus",
    });
  };

  // Zrušení transakce
  const undoTransaction = async (tx) => {
    const txRef = doc(db, "games", gameId, "transactions", tx.id);
    await deleteDoc(txRef);

    if (tx.type === "transfer") {
      const senderRef = doc(db, "games", gameId, "players", tx.from);
      const recipientRef = doc(db, "games", gameId, "players", tx.to);

      const senderSnap = await getDoc(senderRef);
      const recipientSnap = await getDoc(recipientRef);

      if (senderSnap.exists() && recipientSnap.exists()) {
        await updateDoc(senderRef, { balance: senderSnap.data().balance + tx.amount });
        await updateDoc(recipientRef, { balance: recipientSnap.data().balance - tx.amount });
      }
    }

    if (tx.type === "admin-add") {
      const toRef = doc(db, "games", gameId, "players", tx.to);
      const toSnap = await getDoc(toRef);
      if (toSnap.exists()) {
        await updateDoc(toRef, { balance: toSnap.data().balance - tx.amount });
      }
    }

    if (tx.type === "to-bank") {
      const fromRef = doc(db, "games", gameId, "players", tx.from);
      const fromSnap = await getDoc(fromRef);
      if (fromSnap.exists()) {
        await updateDoc(fromRef, { balance: fromSnap.data().balance + tx.amount });
      }
    }

    if (tx.type === "start-bonus") {
      const toRef = doc(db, "games", gameId, "players", tx.to);
      const toSnap = await getDoc(toRef);
      if (toSnap.exists()) {
        await updateDoc(toRef, { balance: toSnap.data().balance - tx.amount });
      }
    }
  };

  // Reset hry
  const resetGame = async () => {
    const confirmed = confirm("Opravdu chceš smazat všechny hráče a historii?");
    if (!confirmed) return;

    const playersSnap = await getDocs(collection(db, "games", gameId, "players"));
    playersSnap.forEach(async (docu) => {
      await deleteDoc(docu.ref);
    });

    const transSnap = await getDocs(collection(db, "games", gameId, "transactions"));
    transSnap.forEach(async (docu) => {
      await deleteDoc(docu.ref);
    });

    await deleteDoc(doc(db, "games", gameId, "control", "control"));

    localStorage.removeItem("monobankSession");

    alert("Hra byla resetována.");
    location.reload();
  };

  // Odejít ze hry
  const leaveGame = () => {
    localStorage.removeItem("monobankSession");
    setJoining(null);
    setGameId("");
    setGamePassword("");
    setPlayers([]);
    setTransactions([]);
    setSelectedPlayer(null);
    setShowTransferModal(false);
    setGameControl(null);
    setIsAdmin(false);
    autoJoinRef.current = false;
  };

  // jsem na herní obrazovce, pokud už existuji v players
  const onGameScreen = !!players.find((p) => p.id === userId);

  // zapni wake lock jen když jsem na herní obrazovce a přepínač je zapnutý
  const { supported: wakeSupported, locked: wakeLocked, error: wakeError } =
    useWakeLock(onGameScreen && wakeLockEnabled);

  // *********************************
  // ***       User Interface      ***
  // *********************************

  // Loading obrazovka při auth init (než je authReady)
  if (!authReady) {
    return <div className="p-4 text-center font-monopoly">Přihlašuji hráče…</div>;
  }

  // Loading obrazovka
  if (loading) {
    return <div className="p-4 text-center font-monopoly">Hned to bude ...</div>;
  }

  // Úvodní obrazovka
  if (!joining) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 50 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -50 }}
        transition={{ duration: 0.3 }}
        className=""
      >
        <div className="mx-auto px-4 font-sans text-sm font-monopoly">
          <img className="w-20 h-20 mr-3 justify-center" src={monobank_logo_png} />
          <h1 className="text-5xl">Vítej v Monobank</h1>
          <h2 className="font-light text-xs text-right">Zkušební provoz v{APP_VERSION}</h2>
          <button
            className="text-white bg-[#0270bf] hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 font-medium text-sm w-full py-2.5 text-center me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
            onClick={() => setJoining("join")}
          >
            Připojit se do existující hry
          </button>
          <button
            className="text-white bg-[#1eb35a] hover:bg-green-800 focus:outline-none focus:ring-4 focus:ring-green-300 font-medium text-sm w-full py-2.5 text-center me-2 mb-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800"
            onClick={() => setJoining("create")}
          >
            Založit novou hru
          </button>

          <p className="p-10 font-light text-xs text-center">
            Created by Lukas Bilek in 🇨🇿 Czech Republic, 🌍 Planet Earth <br />
            <br /> Project was created and is managed in my free time and is completely FREE TO USE. If you want to support me, you can{" "}
            <a
              href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&ab_channel=RickAstley"
              className="text-blue-500 underline hover:text-blue-700"
              target="_blank"
              rel="noopener noreferrer"
            >
              Buy me a coffee
            </a>
            , thank you! <br /> <br /> Have any issue? Wanna report a bug? Contact me via info@lukasbilek.com
          </p>
        </div>
      </motion.div>
    );
  }

  // Formulář pro připojení / založení hry
  if (!players.find((p) => p.id === userId)) {
    return (
      <motion.div
        initial={{ opacity: 0, x: 50 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -50 }}
        transition={{ duration: 0.3 }}
        className=""
      >
        <div className="space-y-4 max-w-max mx-auto font-monopoly">
          <div className="flex items-center justify-center mb-6">
            <img className="w-20 h-20 mr-3" src={monobank_logo_png} />
            <h2 className="font-bold text-lg">
              {joining === "join" ? "Připojit se do hry" : "Založit novou hru"}
            </h2>
          </div>

          <input
            className="border p-2 w-full"
            placeholder="Zadej své jméno"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {joining === "join" && (
            <input
              className="border p-2 w-full"
              placeholder="Game ID"
              value={gameId}
              onChange={(e) => setGameId(e.target.value.toUpperCase())}
            />
          )}
          <input
            className="border p-2 w-full"
            placeholder="Heslo ke hře"
            value={gamePassword}
            onChange={(e) => setGamePassword(e.target.value)}
          />

          {joining === "create" && (
            <>
              <input
                type="text"
                className="border p-2 w-full"
                placeholder="Počáteční zůstatek"
                value={startBalance === 0 ? "" : formatAmount(startBalance)}
                onChange={(e) => {
                  const raw = e.target.value.replace(/\s/g, "");
                  setStartBalance(raw === "" ? 0 : parseInt(raw));
                }}
              />
              <input
                type="text"
                className="border p-2 w-full"
                placeholder="Bonus za start"
                value={startBonus === 0 ? "" : formatAmount(startBonus)}
                onChange={(e) => {
                  const raw = e.target.value.replace(/\s/g, "");
                  setStartBonus(raw === "" ? 0 : parseInt(raw));
                }}
              />
            </>
          )}

          <button
            className="text-white bg-[#0270bf] hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 font-medium text-sm w-full py-2.5 text-center me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800"
            onClick={joining === "join" ? joinGame : createGame}
          >
            {joining === "join" ? "Připojit se" : "Založit hru"}
          </button>
          {joining === "create" && (
            <p className="text-xs text-gray-500 text-center">
              Spolu se hrou bude vytvořen i unikátní identifikátor GameID. Sdělte ho svým spoluhráčům spolu s heslem, aby se mohli připojit do hry.
            </p>
          )}

          {joining === "join" && (
            <p className="text-xs text-gray-500 text-center">
              <b>GameID </b>a <b>Heslo ke hře</b> Vám sdělí Váš bankéř / Game master
            </p>
          )}
        </div>
      </motion.div>
    );
  }

  // *********************************
  // ***       Herní rozhraní      ***
  // *********************************
  return (
    <div className="w-full font-sans text-sm font-monopoly">
      {/* Header: logo | title (center) | gear */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 mb-6">
        <img className="w-20 h-20" src={monobank_logo_png} alt="Monobank logo" />
        <h1 className="text-xl font-bold text-center font-monopoly">Váš účet Monobank</h1>
        <button
          onClick={() => setShowActions(true)}
          className="justify-self-end bg-gray-200 hover:bg-gray-300 text-black text-xs px-3 py-2 rounded shadow"
          title="Rychlé akce"
          aria-label="Rychlé akce"
        >
          ⚙️
        </button>
      </div>


      {/* Toasty – globální popupy */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 space-y-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="pointer-events-auto bg-black text-white/90 px-6 py-2 rounded-xl shadow-lg"
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* Menu pro rychlé volby klienta, zhasínání displaye, vibrace atd*/}
      <AnimatePresence>
        {showActions && (
          <motion.div
            key="actions-overlay"
            className="fixed inset-0 z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* backdrop */}
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowActions(false)}
            />

            {/* panel vpravo nahoře */}
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.2 }}
              className="absolute right-4 top-4 bg-white rounded-xl shadow-xl w-[min(90vw,320px)] p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold">Rychlé akce</div>
                <button
                  onClick={() => setShowActions(false)}
                  className="text-gray-500 hover:text-black"
                  aria-label="Zavřít"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2">
                {/* wake lock toggle */}
                <button
                  onClick={() => setWakeLockEnabled(v => !v)}
                  className={`w-full text-left px-3 py-2 rounded ${wakeLockEnabled ? "bg-[#c9f7c2]" : "bg-gray-200"
                    }`}
                  title={wakeLockEnabled ? "Displej nezhasne" : "Displej může zhasnout"}
                >
                  💡 Nezhasínat: {wakeLockEnabled ? "Zapnuto" : "Vypnuto"}
                </button>

                {/* vibrace toggle */}
                <button
                  onClick={() => setVibrateEnabled(v => !v)}
                  disabled={!vibrateSupported}
                  className={`w-full text-left px-3 py-2 rounded ${vibrateEnabled ? "bg-[#ffe199]" : "bg-gray-200"
                    } ${vibrateSupported ? "" : "opacity-60 cursor-not-allowed"}`}
                  title={vibrateSupported ? "" : "Vibrace nejsou podporovány"}
                >
                  📳 Vibrace: {vibrateSupported ? (vibrateEnabled ? "Zapnuto" : "Vypnuto") : "Nepodporováno"}
                </button>

                {/* refresh */}
                <button
                  onClick={() => { setShowActions(false); manualRefresh(); }}
                  className="w-full text-left px-3 py-2 rounded bg-[#a7dcf2]"
                >
                  🔄 Aktualizovat
                </button>

                {/* leave */}
                <button
                  onClick={() => { setShowActions(false); leaveGame(); }}
                  className="w-full text-left px-3 py-2 rounded bg-gray-600 text-white"
                >
                  ❌ Odejít
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>



      <div className="mb-2 flex justify-end gap-2 items-center hidden">
        {wakeSupported ? (
          <button
            onClick={() => setWakeLockEnabled((v) => !v)}
            className={`text-black ${wakeLockEnabled ? "bg-[#c9f7c2]" : "bg-gray-200"} hover:bg-gray-300 focus:outline-none focus:ring-4 focus:ring-green-200 text-xs px-2 py-1 rounded`}
            title={wakeLocked ? "Displej nezhasne (aktivní)" : "Displej může zhasnout"}
          >
            Nezhasínat: {wakeLockEnabled ? (wakeLocked ? "Zapnuto 💡" : "Zapínám…") : "Vypnuto"}
          </button>
        ) : (
          <span className="text-[11px] text-gray-500 mr-2" title={wakeError || ""}>
            Wake Lock není podporováno
          </span>
        )}

        {vibrateSupported ? (
          <button
            onClick={() => setVibrateEnabled((v) => !v)}
            className={`text-black ${vibrateEnabled ? "bg-[#fbe7a1]" : "bg-gray-200"} hover:bg-gray-300 focus:outline-none focus:ring-4 focus:ring-yellow-200 text-xs px-2 py-1 rounded`}
            title={vibrateEnabled ? "Vibrace při příchozí platbě" : "Vibrace vypnuté"}
          >
            Vibrace: {vibrateEnabled ? "Zapnuto 📳" : "Vypnuto"}
          </button>
        ) : (
          <span className="text-[11px] text-gray-500 mr-2">Vibrace nejsou podporovány</span>
        )}


        <button
          onClick={manualRefresh}
          className="text-black bg-[#a7dcf2] hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-green-300 font-medium text-xs px-2 py-1 rounded"
        >
          Aktualizovat 🔄
        </button>

        <button
          onClick={leaveGame}
          className="text-white bg-gray-600 hover:bg-gray-700 focus:outline-none focus:ring-4 focus:ring-gray-300 text-xs px-2 py-1 rounded"
        >
          Odejít ❌
        </button>
      </div>

      {isAdmin && (
        <div className="text-sm mb-4 bg-[#d2e5d2] shadow-xl/10 p-4 rounded flex justify-between items-start flex-wrap gap-4">
          <div>
            <h3 className="text-red-600 font-bold mb-2">Admin panel</h3>
            <button onClick={resetGame} className="bg-red-600 text-white text-xs px-3 py-1 rounded hover:bg-red-800">
              Resetovat hru
            </button>
          </div>

          <div className="text-right">
            <p>
              <strong>Game ID:</strong> {gameId}
            </p>
            <p>
              <strong>Heslo ke hře:</strong> {gameControl?.password || "žádné"}
            </p>
          </div>
        </div>
      )}

      <h2 className="font-semibold">Hráči:</h2>
      <ul className="mb-4 space-y-2 text-xl font-semibold bg-[#d2e5d2] shadow-xl/20 rounded-b-2xl">
        {[...players, { id: "BANK", name: "🏛️ BANKA", balance: 0 }].map((p) => (
          <li
            key={p.id}
            className="flex border-2 justify-between items-center cursor-pointer hover:bg-gray-100 p-2 rounded shadow"
            onClick={() => {
              if (p.id !== userId) {
                setSelectedPlayer(p);
                setTransferAmount("");
                setModalContext("transfer");
                setShowTransferModal(true);
              }
            }}
          >
            <span className={p.id === userId ? "text-green-600 font-bold" : ""}>
              {p.name}
              {p.id !== "BANK" ? `: $${formatAmount(p.balance)}` : ""}
            </span>

            {isAdmin && p.id !== "BANK" && (
              <div className="flex justify-end gap-2 mt-1">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    grantStartBonus(p.id);
                  }}
                  className="ml-2 text-lg bg-[#f59520] px-2 py-2 rounded hover:bg-yellow-300"
                >
                  🔁
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedPlayer(p);
                    setTransferAmount("");
                    setShowTransferModal(true);
                    setModalContext("admin-add");
                  }}
                  className="ml-2 text-lg bg-green-500 px-2 py-2 rounded hover:bg-green-600"
                >
                  💸
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {showTransferModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex justify-center items-center z-50">
          <div className="bg-white p-6 rounded shadow max-w-sm w-full">
            <h2 className="text-lg font-bold mb-4">
              {modalContext === "admin-add"
                ? `BANKA přidá peníze hráči ${selectedPlayer?.name}`
                : `Poslat peníze hráči ${selectedPlayer?.name}`}
            </h2>
            <input
              type="tel"
              inputMode="numeric"
              pattern="[0-9]*"
              ref={inputRef}
              placeholder="Zadej částku"
              value={transferAmount !== "" ? Number(TypedNumber(transferAmount)).toLocaleString("cs-CZ") : ""}
              onChange={(e) => {
                const raw = e.target.value.replace(/\s/g, "");
                if (!/^\d*$/.test(raw)) return;
                setTransferAmount(raw);
              }}
              className="w-full px-4 py-2 border rounded mb-4"
            />
            <div className="flex justify-between">
              <button
                className="bg-gray-300 hover:bg-gray-400 text-black px-4 py-2 rounded"
                onClick={() => setShowTransferModal(false)}
              >
                Zrušit
              </button>

              <button
                className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded"
                onClick={async () => {
                  const amountToSend = parseInt(transferAmount);
                  if (!amountToSend || amountToSend <= 0) return;

                  try {
                    if (modalContext === "admin-add") {
                      const toRef = doc(db, "games", gameId, "players", selectedPlayer.id);
                      const toSnap = await getDoc(toRef);
                      if (!toSnap.exists()) return;

                      await updateDoc(toRef, {
                        balance: toSnap.data().balance + amountToSend,
                      });

                      await addDoc(collection(db, "games", gameId, "transactions"), {
                        from: null,
                        to: selectedPlayer.id,
                        amount: amountToSend,
                        timestamp: Date.now(),
                        type: "admin-add",
                      });

                      alert(`Přidáno $${formatAmount(amountToSend)} hráči ${selectedPlayer.name}`);
                    } else {
                      // klasický převod
                      const senderRef = doc(db, "games", gameId, "players", userId);
                      const senderSnap = await getDoc(senderRef);
                      const senderData = senderSnap.data();

                      if (senderData.balance < amountToSend) {
                        alert("Nedostatek prostředků.");
                        return;
                      }

                      await updateDoc(senderRef, { balance: senderData.balance - amountToSend });

                      if (selectedPlayer.id === "BANK") {
                        await addDoc(collection(db, "games", gameId, "transactions"), {
                          from: userId,
                          to: null,
                          amount: amountToSend,
                          timestamp: Date.now(),
                          type: "to-bank",
                        });
                      } else {
                        const recipientRef = doc(db, "games", gameId, "players", selectedPlayer.id);
                        const recipientSnap = await getDoc(recipientRef);
                        const recipientData = recipientSnap.data();

                        await updateDoc(recipientRef, {
                          balance: recipientData.balance + amountToSend,
                        });

                        await addDoc(collection(db, "games", gameId, "transactions"), {
                          from: userId,
                          to: selectedPlayer.id,
                          amount: amountToSend,
                          timestamp: Date.now(),
                          type: "transfer",
                        });
                      }
                    }

                    setShowTransferModal(false);
                    setTransferAmount("");
                    setSelectedPlayer(null);
                  } catch (e) {
                    console.error(e);
                    alert(`Transakce se nepodařila: ${e?.message || e}`);
                    setShowTransferModal(false);
                  }
                }}
              >
                Odeslat
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="pl-2 pb-2 mt-8 pt-4 bg-[#d2e5d2] shadow-xl/20 rounded">
        <h3 className="font-bold mb-2">Historie transakcí</h3>
        <ul className="space-y-1">
          {transactions.map((t) => {
            const fromName = displayName(t.from);
            const toName = displayName(t.to);
            return (
              <li key={t.id} className="flex justify-between items-center">
                <span>
                  <span className="font-semibold">{fromName}</span> →{" "}
                  <span className="font-semibold">{toName}</span>: ${formatAmount(t.amount)}
                  <span className="text-xs text-gray-500 ml-2">
                    ({new Date(t.timestamp).toLocaleTimeString()})
                  </span>
                </span>
                {isAdmin && (
                  <button onClick={() => undoTransaction(t)} className="text-red-500 ml-2 text-sm">
                    ❌
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* App version footer */}
      <div className="my-4 text-center text-[11px] text-gray-500">
        Monobank • verze v{APP_VERSION}
      </div>

    </div>
  );
}

// Pomocná funkce pro bezpečné parsování číselného vstupu (zajistí number nebo 0)
function TypedNumber(v) {
  const n = Number(String(v).replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}
