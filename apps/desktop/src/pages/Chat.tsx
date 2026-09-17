//! Chat completo: búsqueda, autoscroll que respeta al usuario y vaciado.

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatEntry } from "../api";
import { Card, Empty, chatText, formatClock, nickname } from "../components";
import { t } from "../i18n/es";

/** Mensajes que se pintan de una vez. El resto sigue en Rust. */
const VISIBLE = 200;

interface Props {
  chat: ChatEntry[];
  /**
   * `source_id` de los comentarios borrados en TikTok. Se reciben aparte (y no
   * dentro de la entrada) porque el chat se fusiona con las fotos del motor:
   * una marca guardada en la entrada se perderia al llegar un snapshot.
   */
  deleted: ReadonlySet<string>;
  /** Ids de usuario silenciados en la voz desde este chat. */
  muted: ReadonlySet<string>;
  /** Silencia o vuelve a leer a un usuario. La orden la manda `App`. */
  onToggleMute: (userId: string, muted: boolean) => void;
  onClear: () => void;
}

export function Chat({ chat, deleted, muted, onToggleMute, onClear }: Props) {
  const [search, setSearch] = useState("");
  const [stick, setStick] = useState(true);
  const listRef = useRef<HTMLUListElement | null>(null);

  const visible = useMemo(() => {
    const needle = normalize(search);
    const filtered = needle
      ? chat.filter(
          (entry) =>
            normalize(entry.content).includes(needle) ||
            normalize(entry.user.nickname).includes(needle) ||
            normalize(entry.user.unique_id).includes(needle),
        )
      : chat;
    return filtered.slice(-VISIBLE);
  }, [chat, search]);

  // Autoscroll solo si el usuario ya estaba abajo: si está leyendo hacia
  // arriba, no se le mueve la vista.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !stick) return;
    list.scrollTop = list.scrollHeight;
  }, [visible, stick]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    setStick(distance < 40);
  };

  return (
    <div className="page-fill">
      <Card
        grow
        title={t.chat.title}
        actions={
          <>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t.chat.search}
              spellCheck={false}
            />
            {!stick ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setStick(true);
                  const list = listRef.current;
                  if (list) list.scrollTop = list.scrollHeight;
                }}
              >
                {t.chat.stick}
              </button>
            ) : null}
            <button type="button" className="ghost" onClick={onClear}>
              {t.chat.clear}
            </button>
          </>
        }
      >
        {visible.length === 0 ? (
          <Empty>{t.chat.empty}</Empty>
        ) : (
          <ul className="chat" ref={listRef} onScroll={onScroll}>
            {visible.map((entry) => {
              // Un mensaje borrado se queda en la lista, atenuado y rotulado: si
              // se quitara, el hilo de la conversacion quedaria cortado.
              const borrado = entry.source_id !== undefined && deleted.has(entry.source_id);
              // El silencio es por usuario (asi lo guarda el motor): se marca
              // todas sus lineas, no solo la que se ha pulsado.
              const silenciado = muted.has(entry.user.id);
              return (
                <li key={entry.seq} className={silenciado ? "muted" : undefined}>
                  <span className="time">{formatClock(entry.timestamp_ms)}</span>
                  <span className="user" title={`@${entry.user.unique_id}`}>
                    {nickname(entry.user.nickname, entry.user.unique_id)}
                  </span>
                  <span
                    className={borrado ? "content deleted" : "content"}
                    title={borrado ? t.chat.deletedHint : undefined}
                  >
                    {chatText(entry, borrado)}
                  </span>
                  <button
                    type="button"
                    className="ghost tiny mute"
                    title={silenciado ? t.chat.unmuteHint : t.chat.muteHint}
                    onClick={() => onToggleMute(entry.user.id, !silenciado)}
                  >
                    {silenciado ? t.chat.unmute : t.chat.mute}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">{t.chat.showing(visible.length, chat.length)}</p>
      </Card>
    </div>
  );
}

/** Minusculas y sin acentos: "maria" encuentra a "María". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
