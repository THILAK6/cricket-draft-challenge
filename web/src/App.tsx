import { useEffect, useState } from "preact/hooks";
import type { DraftState } from "../../src/core/types";
import { type Mode } from "./format";
import type { MatchSnapshot } from "../../src/core/match-snapshot";
import { api, savedRoom, type Difficulty } from "./api";
import { Setup } from "./components/Setup";
import { Briefing } from "./components/Briefing";
import { Draft } from "./components/Draft";
import { Lineup } from "./components/Lineup";
import { Result } from "./components/Result";
import { Toast, useToast } from "./components/Toast";
import { themesFor, type ThemeKey } from "../../src/core/themes";

type Screen = "loading" | "setup" | "briefing" | "room" | "match";

/** A saved match dressed as a finished room, so the result screen shows it unchanged. */
function savedAsState(m: MatchSnapshot): DraftState {
  return {
    roomId: "",
    challenge: m.challenge,
    pool: [],
    userPicks: [],
    aiPicks: [],
    currentTurn: "USER",
    round: 11,
    maxRounds: 11,
    status: "COMPLETED",
    lastActionTimestamp: m.playedAt,
    pickLog: m.pickLog,
    simulation: m.simulation,
    results: m.results,
    matchId: m.id,
  };
}

const matchInUrl = () => new URLSearchParams(location.search).get("match");

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [state, setState] = useState<DraftState | null>(null);
  // What to play: a format, or the IPL (T20 with the league's players and rules)
  const [format, setFormat] = useState<Mode>("T20");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [theme, setTheme] = useState<ThemeKey>("mixed");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<MatchSnapshot | null>(null);
  const toast = useToast();

  /** Opens a saved match (from the list or a share link); the address bar gets its link. */
  const openMatch = async (id: string, push = true) => {
    try {
      const { match } = await api.match(id);
      setSaved(match);
      setScreen("match");
      if (push) history.pushState({ match: id }, "", `/?match=${id}`);
      window.scrollTo(0, 0);
      return true;
    } catch (e) {
      toast.show((e as Error).message, "error");
      return false;
    }
  };

  /** Leaves a saved match: back to the draft in progress, or the start. */
  const closeMatch = (push = true) => {
    if (push) history.pushState(null, "", "/");
    setSaved(null);
    setScreen(state && roomId ? "room" : "setup");
  };

  useEffect(() => {
    const onPop = () => {
      const id = matchInUrl();
      if (id) openMatch(id, false);
      else closeMatch(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  });

  // Open a shared match, or resume a draft after a reload
  useEffect(() => {
    const shared = matchInUrl();
    if (shared) {
      openMatch(shared, false).then((ok) => {
        if (!ok) {
          history.replaceState(null, "", "/");
          setScreen("setup");
        }
      });
      return;
    }
    const id = savedRoom.get();
    if (!id) return setScreen("setup");
    api
      .state(id)
      .then(({ state }) => {
        setRoomId(id);
        setState(state);
        setFormat(state.challenge.league ?? state.challenge.format);
        setScreen("room");
      })
      .catch(() => {
        savedRoom.set(null);
        setScreen("setup");
      });
  }, []);

  const newRoom = async () => {
    setBusy(true);
    try {
      const { roomId, theme: used } = await api.start(format === "IPL" ? "T20" : format, difficulty, theme, format === "IPL" ? "IPL" : undefined);
      if (used !== theme) toast.show(`Not enough ${themesFor(format === "IPL" ? "IPL" : undefined).find((t) => t.key === theme)?.label ?? ""} players for that draft, so this one uses the full pool.`);
      const { state } = await api.state(roomId);
      setRoomId(roomId);
      setState(state);
      savedRoom.set(roomId);
      setScreen("briefing");
    } catch (e) {
      toast.show((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    savedRoom.set(null);
    setState(null);
    setRoomId(null);
    setScreen("setup");
  };

  let body;
  if (screen === "loading") body = <div class="loading">Loading…</div>;
  else if (screen === "setup")
    body = (
      <Setup format={format} difficulty={difficulty} theme={theme} busy={busy} onFormat={(m) => { setFormat(m); setTheme(m === "IPL" ? "ipl-all" : "mixed"); }} onDifficulty={setDifficulty} onTheme={setTheme} onNext={newRoom} onOpenMatch={(id) => openMatch(id)} />
    );
  else if (screen === "match" && saved)
    body = <Result state={savedAsState(saved)} toast={toast.show} onNewGame={() => closeMatch()} savedAt={saved.playedAt} />;
  else if (screen === "briefing" && state)
    body = <Briefing state={state} busy={busy} onBack={() => setScreen("setup")} onReroll={newRoom} onStart={() => setScreen("room")} />;
  else if (state && roomId) {
    const props = { state, roomId, onState: setState, toast: toast.show, onNewGame: restart };
    body = state.status === "COMPLETED" ? <Result {...props} /> : state.status === "READY_TO_PLAY" ? <Lineup {...props} /> : <Draft {...props} />;
  }

  return (
    <div class="app">
      {body}
      <Toast toast={toast.current} />
    </div>
  );
}
