import { useEffect, useState } from "react";
import { firebaseApp } from "./firebaseConfig";
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

const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

const generateGameId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const formatAmount = (amount) => {
  return amount.toLocaleString("cs-CZ").replace(/\u00a0/g, " ");
};

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

  useEffect(() => {
    signInAnonymously(auth).then((res) => {
      setUserId(res.user.uid);
    });
  }, []);

  useEffect(() => {
    if (!userId || !gameId) return;

    const playersRef = collection(db, "games", gameId, "players");
    const unsubscribePlayers = onSnapshot(playersRef, (snapshot) => {
      const playerList = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      setPlayers(playerList);

      const me = playerList.find((p) => p.id === userId);
      setIsAdmin(me?.isAdmin === true);
    });

    const q = query(collection(db, "games", gameId, "transactions"), orderBy("timestamp", "desc"));
    const unsubscribeTransactions = onSnapshot(q, (snapshot) => {
      const all = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const filtered = all.filter((t) => isAdmin || t.from === userId || t.to === userId);
      setTransactions(filtered);
    });

    return () => {
      unsubscribePlayers();
      unsubscribeTransactions();
    };
  }, [userId, gameId, isAdmin]);

  const createGame = async () => {
    if (!name || !gamePassword) return;
    setLoading(true);

    const newGameId = generateGameId();
    const controlRef = doc(db, "games", newGameId, "control", "control");
    await setDoc(controlRef, { adminId: userId, password: gamePassword });
    await setDoc(doc(db, "games", newGameId, "players", userId), {
      name,
      balance: 1500,
      isAdmin: true
    });

    setGameId(newGameId);
    setGameControl({ adminId: userId, password: gamePassword });
    setLoading(false);
  };

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
      await setDoc(playerRef, { name, balance: 1500, isAdmin: false });
    }

    setLoading(false);
  };

  const transferMoney = async () => {
    if (!recipient || amount <= 0) return;

    const senderRef = doc(db, "games", gameId, "players", userId);
    const senderSnap = await getDoc(senderRef);
    if (!senderSnap.exists()) return;
    const senderData = senderSnap.data();

    await updateDoc(senderRef, { balance: senderData.balance - amount });

    if (recipient === "BANK") {
      await addDoc(collection(db, "games", gameId, "transactions"), {
        from: userId,
        to: null,
        amount,
        timestamp: Date.now(),
        type: "to-bank"
      });
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
  };

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
  };

  if (loading) return <div className="p-4 text-center">Načítání...</div>;

  if (!joining) {
    return (
      <div className="p-4 space-y-4 max-w-md mx-auto text-center">
        <h1 className="text-xl font-bold">Vítej v Monobank</h1>
        <button className="bg-blue-500 text-white px-4 py-2 rounded w-full" onClick={() => setJoining("join")}>
          Připojit se do existující hry
        </button>
        <button className="bg-green-500 text-white px-4 py-2 rounded w-full" onClick={() => setJoining("create")}>
          Založit novou hru
        </button>
      </div>
    );
  }

  if (!players.find((p) => p.id === userId)) {
    return (
      <div className="p-4 space-y-4 max-w-md mx-auto">
        <h2 className="font-bold text-lg">{joining === "join" ? "Připojit se do hry" : "Založit novou hru"}</h2>
        <input className="border p-2 w-full" placeholder="Zadej své jméno" value={name} onChange={(e) => setName(e.target.value)} />
        {joining === "join" && (
          <input className="border p-2 w-full" placeholder="Game ID" value={gameId} onChange={(e) => setGameId(e.target.value.toUpperCase())} />
        )}
        <input className="border p-2 w-full" placeholder="Heslo ke hře" value={gamePassword} onChange={(e) => setGamePassword(e.target.value)} />
        <button className="bg-blue-600 text-white px-4 py-2 rounded w-full" onClick={joining === "join" ? joinGame : createGame}>
          {joining === "join" ? "Připojit se" : "Založit hru"}
        </button>
        {joining === "create" && (
          <p className="text-xs text-gray-500 text-center">Game ID bude automaticky vygenerováno.</p>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-4 font-sans text-sm">
      <h1 className="text-xl font-bold mb-4 text-center">Monobank</h1>

      <h2 className="font-semibold">Hráči:</h2>
      <ul className="mb-4 space-y-1">
        {players.map((p) => (
          <li key={p.id}>
            {p.name}: ${formatAmount(p.balance)}
          </li>
        ))}
      </ul>

      <div className="mt-4 space-y-2">
        <label className="block">Komu posíláš peníze:</label>
        <select
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          className="border p-2 w-full"
        >
          <option value="">-- Vyber hráče --</option>
          <option value="BANK">BANKA</option>
          {players.filter((p) => p.id !== userId).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <input
          type="number"
          className="border p-2 w-full"
          placeholder="Částka"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
        />

        <button onClick={transferMoney} className="bg-green-500 text-white px-4 py-2 rounded w-full">
          Odeslat
        </button>
      </div>

      {isAdmin && (
        <div className="mt-6 border-t pt-4">
          <h3 className="font-bold mb-2 text-red-600">Admin panel</h3>
          <p className="text-xs mb-2">
            <strong>Game ID:</strong> {gameId} <br />
            <strong>Heslo:</strong> {gameControl?.password || "žádné"}
          </p>

          <button
            className="bg-red-500 hover:bg-red-600 text-white px-4 py-2 rounded w-full mb-4"
            onClick={resetGame}
          >
            Resetovat hru
          </button>

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
              type="number"
              className="border p-2 w-full"
              placeholder="Částka k přidání"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
            <button
              className="bg-yellow-500 hover:bg-yellow-600 text-black font-semibold px-4 py-2 rounded w-full"
              onClick={addMoneyToPlayer}
            >
              Přidat peníze
            </button>
          </div>
        </div>
      )}

      <div className="mt-8 border-t pt-4">
        <h3 className="font-bold mb-2">Historie transakcí</h3>
        <ul className="space-y-1">
          {transactions.map((t) => {
            const fromName = t.from ? players.find((p) => p.id === t.from)?.name || "?" : "BANKA";
            const toName = t.to ? players.find((p) => p.id === t.to)?.name || "?" : "BANKA";
            return (
              <li key={t.id}>
                <span className="font-semibold">{fromName}</span> → <span className="font-semibold">{toName}</span>: ${formatAmount(t.amount)}
                <span className="text-xs text-gray-500 ml-2">
                  ({new Date(t.timestamp).toLocaleTimeString()})
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
