
// Import React hooků, CSS soubory a Firebase instance
import { useState } from 'react'
import { useEffect } from "react";
import './App.css'
import { firebaseApp } from "./firebaseConfig";
import { motion } from "framer-motion";
import { useRef } from "react";

// Import potřebných funkcí z Firestore a autentizace - přístup k datům a čtení dat
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
  orderBy
} from "firebase/firestore";

import { getAuth, signInAnonymously } from "firebase/auth";

// Inicializace přístupu ke konkrétní instanci Firebase DB a autentizace
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);



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

// Definování stavových dat potřebných pro hru
export default function App() {
  const [userId, setUserId] = useState(null);
  const [players, setPlayers] = useState([]);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(0);
  const [recipient, setRecipient] = useState("");
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

  //autofokus inputu při otevření modalu
  useEffect(() => {
    if (showTransferModal && inputRef.current) {
      setTimeout(() => {
        inputRef.current.focus();
      }, 150); // trochu delay kvůli renderu
    }
  }, [showTransferModal]);

  // Anonymní přihlášení hráče a uložení jeho ID do DB
  useEffect(() => {
    signInAnonymously(auth).then((res) => {
      setUserId(res.user.uid);
    });
  }, []);

  // Jakmile je známé userId a gameId, spustí se poslech změn hráčů a transakcí. Data se synchronizují v reálném čase přes Firestore.
  useEffect(() => {
    signInAnonymously(auth).then(res => setUserId(res.user.uid));
  }, []);

  useEffect(() => {
    if (!userId || !gameId) return;

    const playersRef = collection(db, "games", gameId, "players");
    const unsubP = onSnapshot(playersRef, snapshot => {
      const list = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      setPlayers(list);
      const me = list.find(p => p.id === userId);
      setIsAdmin(me?.isAdmin === true);
    });

    const q = query(collection(db, "games", gameId, "transactions"), orderBy("timestamp", "desc"));
    const unsubT = onSnapshot(q, snapshot => {
      const all = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      const filtered = all.filter(t => isAdmin || t.from === userId || t.to === userId);
      setTransactions(filtered);
    });

    return () => {
      unsubP();
      unsubT();
    };
  }, [userId, gameId, isAdmin, refreshKey]);

  // Vynucení refreshe dat
  const manualRefresh = () => setRefreshKey(prev => prev + 1);

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
      type: "start-bonus"
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

  // Vytvoření hry
  const createGame = async () => {
    if (!name || !gamePassword) return;
    setLoading(true);

    const newGameId = generateGameId();
    const controlRef = doc(db, "games", newGameId, "control", "control");

    await setDoc(controlRef, {
      adminId: userId,
      password: gamePassword,
      startBalance,
      startBonus
    });

    await setDoc(doc(db, "games", newGameId, "players", userId), {
      name,
      balance: startBalance,
      isAdmin: true
    });

    setGameId(newGameId);
    setGameControl({
      adminId: userId,
      password: gamePassword,
      startBalance,
      startBonus
    });

    setLoading(false);
  };

  // Připojení do hry pomocí GameID a hesla
  const joinGame = async () => {
    if (!name || !gameId) return;
    setLoading(true);

    const controlRef = doc(db, "games", gameId, "control", "control");
    const controlSnap = await getDoc(controlRef);
    if (!controlSnap.exists()) {
      alert("Hra neexistuje.");
      setLoading(false);
      return;
    }

    const controlData = controlSnap.data();
    if (controlData.password && controlData.password !== gamePassword) {
      alert("Nesprávné heslo.");
      setLoading(false);
      return;
    }

    setGameControl(controlData);

    const playerRef = doc(db, "games", gameId, "players", userId);
    const playerSnap = await getDoc(playerRef);
    if (!playerSnap.exists()) {
      await setDoc(playerRef, {
        name,
        balance: controlData.startBalance || 1500,
        isAdmin: false
      });
    }

    setLoading(false);
  };

  // Odesílání částky jinému hráči nebo bance. Obsahuje kontrolu zůstatku, aktualizaci zůstatku a záznam transakce
  {/*
  const transferMoney = async () => {
    if (!recipient || amount <= 0) return;

    const senderRef = doc(db, "games", gameId, "players", userId);
    const senderSnap = await getDoc(senderRef);
    if (!senderSnap.exists()) return;
    const senderData = senderSnap.data();

    // 🚫 Kontrola zůstatku – hráč nesmí jít do mínusu
    if (senderData.balance < amount) {
      alert("Nemáš dostatek peněz na účtu.");
      return;
    }

    await updateDoc(senderRef, { balance: senderData.balance - amount });

    if (recipient === "BANK") {
      await addDoc(collection(db, "games", gameId, "transactions"), {
        from: userId,
        to: null,
        amount,
        timestamp: Date.now(),
        type: "to-bank"
      });
      setAmount(0); // 🧼 Vymaž částku po transakci
      setRecipient(""); // 🧼 Resetuj výběr hráče
      return;
    }

    const recipientRef = doc(db, "games", gameId, "players", recipient);
    const recipientSnap = await getDoc(recipientRef);
    if (!recipientSnap.exists()) return;
    const recipientData = recipientSnap.data();

    await updateDoc(recipientRef, { balance: recipientData.balance + amount });

    await addDoc(collection(db, "games", gameId, "transactions"), {
      from: userId,
      to: recipient,
      amount,
      timestamp: Date.now(),
      type: "transfer"
    });
    setAmount(0); // 🧼 Vymaž částku po transakci
    setRecipient(""); // 🧼 Resetuj výběr hráče
  };
  */}

  // Reset hry, smaže celou gaming session z DB
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

    alert("Hra byla resetována.");
    location.reload();
  };



  // Přidání peněz hráči Adminem (BANKOU)
  const addMoneyToPlayer = async () => {
    if (!recipient || amount <= 0) return;

    const ref = doc(db, "games", gameId, "players", recipient);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;

    const data = snap.data();
    await updateDoc(ref, { balance: data.balance + amount });

    await addDoc(collection(db, "games", gameId, "transactions"), {
      from: null,
      to: recipient,
      amount,
      timestamp: Date.now(),
      type: "admin-add"
    });

    alert(`Přidáno $${formatAmount(amount)} hráči ${data.name}`);
    setAmount(0); // 🧼 Vymaž částku i po admin přidání
  };




  // *********************************           
  // ***       User Interface      ***
  // *********************************

  // Loading obrazovka
  if (loading) return <div className="p-4 text-center font-monopoly">Hned to bude ...</div>;

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
        <div className="space-y-4 max-w-max mx-auto text-center font-monopoly">
          <img src="/monobank_logo.png" alt="Logo" className="w-32 mx-auto mb-4" />
          <h1 className='text-5xl'>Vítej v Monobank</h1>
          <h2 className='font-light text-xs text-right'>Zkušební provoz   v2.5</h2>
          <button className="text-white bg-[#0270bf] hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 font-medium text-sm w-full py-2.5 text-center me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800" onClick={() => setJoining("join")}>
            Připojit se do existující hry
          </button>
          <button className="text-white bg-[#1eb35a] hover:bg-green-800 focus:outline-none focus:ring-4 focus:ring-green-300 font-medium text-sm w-full py-2.5 text-center me-2 mb-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800" onClick={() => setJoining("create")}>
            Založit novou hru
          </button>

          <p className='p-10 font-light text-xs text-center'>
            Created by Lukas Bilek in 🇨🇿 Czech Republic, 🌍 Planet Earth <br /> <br /> Project was created and is managed in my free time and is completely FREE TO USE. If you want to support me, you can <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ&ab_channel=RickAstley" className="text-blue-500 underline hover:text-blue-700" target="_blank" rel="noopener noreferrer">Buy me a coffee</a>, thank you! <br /> <br /> Have any issue? Wanna report a bug? Contact me via info@lukasbilek.com

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
            <img src="/monobank_logo.png" alt="Logo" className="w-20 h-20 mr-3" />
            <h2 className="font-bold text-lg">{joining === "join" ? "Připojit se do hry" : "Založit novou hru"}</h2>
          </div>

          <input className="border p-2 w-full" placeholder="Zadej své jméno" value={name} onChange={(e) => setName(e.target.value)} />
          {joining === "join" && (
            <input className="border p-2 w-full" placeholder="Game ID" value={gameId} onChange={(e) => setGameId(e.target.value.toUpperCase())} />
          )}
          <input className="border p-2 w-full" placeholder="Heslo ke hře" value={gamePassword} onChange={(e) => setGamePassword(e.target.value)} />

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

          <button className="text-white bg-[#0270bf] hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-blue-300 font-medium text-sm w-full py-2.5 text-center me-2 mb-2 dark:bg-blue-600 dark:hover:bg-blue-700 dark:focus:ring-blue-800" onClick={joining === "join" ? joinGame : createGame}>
            {joining === "join" ? "Připojit se" : "Založit hru"}
          </button>
          {joining === "create" && (
            <p className="text-xs text-gray-500 text-center">Spolu se hrou bude vytvořen i unikátní identifikátor GameID. Sdělte ho svým spoluhráčům spolu s heslem, aby se mohli připojit do hry.</p>
          )}

          {joining === "join" && (
            <p className="text-xs text-gray-500 text-center"><b>GameID </b>a <b>Heslo ke hře</b> Vám sdělí Váš bankéř / Game master</p>
          )}
        </div>

      </motion.div>

    );

  }


  // *********************************           
  // ***       Herní rozhraní      ***
  // *********************************

  return (
    <div className="max-w-max mx-auto font-sans text-sm font-monopoly">

      <div className="flex items-center justify-center mb-6">
        <img src="/monobank_logo.png" alt="Logo" className="w-20 h-20 mr-3" />
        <h1 className="text-xl font-bold mb-4 text-center font-monopoly">Váš účet Monobank</h1>
      </div>


      <div className="text-right mb-2">
        <button
          onClick={manualRefresh}
          className="text-black bg-[#a7dcf2] hover:bg-blue-800 focus:outline-none focus:ring-4 focus:ring-green-300 font-medium text-xs px-0.5 py-0.5 text-center me-2 mb-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800"
        >
          Aktualizovat 🔄
        </button>
      </div>

      {isAdmin && (
        <div className="text-sm mb-4 bg-[#d2e5d2] shadow-xl/10 p-4 rounded flex justify-between items-start flex-wrap gap-4">
          <div>
            <h3 className="text-red-600 font-bold mb-2">Admin panel</h3>
            <button
              onClick={resetGame}
              className="bg-red-600 text-white text-xs px-3 py-1 rounded hover:bg-red-800"
            >
              Resetovat hru
            </button>
          </div>

          <div className="text-right">
            <p><strong>Game ID:</strong> {gameId}</p>
            <p><strong>Heslo ke hře:</strong> {gameControl?.password || "žádné"}</p>
          </div>
        </div>
      )}


      <h2 className="font-semibold">Hráči:</h2>
      <ul className="mb-4 space-y-2 text-xl font-semibold bg-[#d2e5d2] shadow-xl/20 rounded-b-2xl">
        {[...players, { id: "BANK", name: "🏛️ BANKA", balance: 0 }].map(p => (
          <li
            key={p.id}
            className="flex border-2 justify-between items-center cursor-pointer hover:bg-gray-100 p-2 rounded shadow"
            onClick={() => {
              if (p.id !== userId) {
                setSelectedPlayer(p);
                setTransferAmount("");
                setModalContext("transfer"); // ✅ klasický převod peněz
                setShowTransferModal(true);
              }
            }}
          >
            <span className={p.id === userId ? "text-green-600 font-bold" : ""}>
              {p.name}{p.id !== "BANK" ? `: $${formatAmount(p.balance)}` : ""}
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
              ref={inputRef}
              placeholder="Zadej částku"
              value={transferAmount !== '' ? Number(transferAmount).toLocaleString('cs-CZ') : ''}
              onChange={(e) => {
                const raw = e.target.value.replace(/\s/g, '');
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

                  if (modalContext === "admin-add") {
                    const toRef = doc(db, "games", gameId, "players", selectedPlayer.id);
                    const toSnap = await getDoc(toRef);
                    if (!toSnap.exists()) return;

                    await updateDoc(toRef, {
                      balance: toSnap.data().balance + amountToSend
                    });

                    await addDoc(collection(db, "games", gameId, "transactions"), {
                      from: null,
                      to: selectedPlayer.id,
                      amount: amountToSend,
                      timestamp: Date.now(),
                      type: "admin-add"
                    });

                    alert(`Přidáno $${formatAmount(amountToSend)} hráči ${selectedPlayer.name}`);
                  } else {
                    // klasický převod (přesunuto sem z původního kódu)
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
                        type: "to-bank"
                      });
                    } else {
                      const recipientRef = doc(db, "games", gameId, "players", selectedPlayer.id);
                      const recipientSnap = await getDoc(recipientRef);
                      const recipientData = recipientSnap.data();

                      await updateDoc(recipientRef, {
                        balance: recipientData.balance + amountToSend
                      });

                      await addDoc(collection(db, "games", gameId, "transactions"), {
                        from: userId,
                        to: selectedPlayer.id,
                        amount: amountToSend,
                        timestamp: Date.now(),
                        type: "transfer"
                      });
                    }
                  }

                  setShowTransferModal(false);
                  setTransferAmount("");
                  setSelectedPlayer(null);
                }}
              >
                Odeslat
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
      <div className="mt-4 space-y-2">
        <label className="block mb-2 text-sm font-medium text-gray-900 dark:text-white">Poslat peníze:</label>
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full p-2.5 dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400 dark:text-white dark:focus:ring-blue-500 dark:focus:border-blue-500"
        >
          <option value="">-- Vyber hráče --</option>
          <option value="BANK">BANKA</option>
          {["BANK", ...players.filter((p) => p.id !== userId).map((p) => p.id)].map((id) => {
            if (id === "BANK") {
              return <option key="BANK" value="BANK">BANKA</option>;
            }

            const player = players.find((pl) => pl.id === id);
            if (!player) return null; // bezpečnostní pojistka
            return <option key={player.id} value={player.id}>{player.name}</option>;
          })}
        </select>

        <input
          type="text"
          className="bg-gray-50 border rounded-lg block p-2 w-full dark:bg-gray-700 dark:border-gray-600 dark:placeholder-gray-400"
          placeholder="Částka"
          value={amount === 0 ? "" : formatAmount(amount)}
          onChange={(e) => {
            const raw = e.target.value.replace(/\s/g, "");
            if (raw === "") {
              setAmount(0);
            } else if (/^\d+$/.test(raw)) {
              setAmount(parseInt(raw));
            }
          }}
        />

        <button onClick={transferMoney} className="text-white bg-[#1eb35a] hover:bg-green-800 focus:outline-none focus:ring-4 focus:ring-green-300 font-medium text-sm px-44.5 py-2.5 text-center me-2 mb-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800">
          Odeslat
        </button>
      </div>
      */}

      {/*
      //Admin panel
      {isAdmin && (
        <div className="mt-6  pt-4 bg-[#ffefbb]">
          <h3 className="font-bold mb-2 text-red-600">Admin panel</h3>
          <p className="text-xs mb-2">
            <strong>Game ID:</strong> {gameId} <br />
            <strong>Heslo:</strong> {gameControl?.password || "žádné"}
          </p>

          <div className="space-y-2">
            <h4 className="font-semibold">Přidat peníze hráči:</h4>
            <select
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              className="border p-2 w-full"
            >
              <option value="">-- Vyber hráče --</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="border p-2 w-full"
              placeholder="Částka k přidání"
              value={amount === 0 ? "" : formatAmount(amount)}
              onChange={(e) => {
                const raw = e.target.value.replace(/\s/g, "");
                if (raw === "") {
                  setAmount(0);
                } else if (/^\d+$/.test(raw)) {
                  setAmount(parseInt(raw));
                }
              }}
            />
            <button
              className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-10 py-2 rounded w-full"
              onClick={addMoneyToPlayer}
            >
              Přidat peníze
            </button>

            <div className="text-left ">

              <button
                className="text-white bg-[#e0191c] hover:bg-red-900 focus:outline-none focus:ring-4 focus:ring-green-300 font-medium text-xs px-1 py-0.5 text-center me-2 mb-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800"
                onClick={resetGame}
              >
                Resetovat hru
              </button>

            </div>




          </div>
        </div>
      )}
      */}

      <div className=" pl-2 pb-2 mt-8 pt-4 bg-[#d2e5d2] shadow-xl/20 rounded">
        <h3 className="font-bold mb-2">Historie transakcí</h3>
        <ul className="space-y-1">
          {transactions.map((t) => {
            const fromName = t.from ? players.find((p) => p.id === t.from)?.name || "?" : "BANKA";
            const toName = t.to ? players.find((p) => p.id === t.to)?.name || "?" : "BANKA";
            return (
              <li key={t.id} className="flex justify-between items-center">
                <span>
                  <span className="font-semibold">{fromName}</span> → <span className="font-semibold">{toName}</span>: ${formatAmount(t.amount)}
                  <span className="text-xs text-gray-500 ml-2">
                    ({new Date(t.timestamp).toLocaleTimeString()})
                  </span>
                </span>
                {isAdmin && (
                  <button onClick={() => undoTransaction(t)} className="text-red-500 ml-2 text-sm">❌</button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
