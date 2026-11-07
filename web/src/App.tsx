import { useEffect, useState } from "preact/hooks";
import type { DraftState, MatchFormat } from "../../src/core/types";
import { api, savedRoom, type Difficulty } from "./api";
import { Setup } from "./components/Setup";
import { Briefing } from "./components/Briefing";
import { Draft } from "./components/Draft";
import { Lineup } from "./components/Lineup";
import { Result } from "./components/Result";
import { Toast, useToast } from "./components/Toast";

type Screen = "loading" | "setup" | "briefing" | "room";

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [state, setState] = useState<DraftState | null>(null);
  const [format, setFormat] = useState<MatchFormat>("T20");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  // Resume a draft after a reload
  useEffect(() => {
    const id = savedRoom.get();
    if (!id) return setScreen("setup");
    api
      .state(id)
      .then(({ state }) => {
        setRoomId(id);
        setState(state);
        setFormat(state.challenge.format);
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
      const { roomId } = await api.start(format, difficulty);
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
    body = <Setup format={format} difficulty={difficulty} busy={busy} onFormat={setFormat} onDifficulty={setDifficulty} onNext={newRoom} />;
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
