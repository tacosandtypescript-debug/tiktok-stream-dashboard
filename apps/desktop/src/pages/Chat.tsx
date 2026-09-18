//! Inicio: cuatro paneles con lo que esta pasando ahora mismo.
//!
//! El **chat** se queda con la columna elastica porque es lo que se lee de
//! verdad; a su derecha van los **follows**, la tabla de **seguidores** y la
//! **actividad** (regalos, compartidos, suscripciones y rafagas grandes de likes).
//!
//! Los follows salen de la actividad a proposito y con panel propio: son el suceso
//! mas numeroso de la noche y enterraban los regalos, que es justo lo que se mira
//! de reojo cuando cae uno grande. Y el panel de seguidores ensena el acumulado
//! por persona, que es la misma pregunta que la lista de sucesos pero con otro
//! reloj: quien mas ha traido, no que acaba de pasar.

import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatEntry, FeedItem, RankingEntry } from "../api";
import {
  Card,
  Empty,
  FeedList,
  RankingTable,
  chatText,
  formatClock,
  nickname,
} from "../components";
import { t } from "../i18n/es";

/** Mensajes que se pintan de una vez. El resto sigue en Rust. */
const VISIBLE = 200;
/** Sucesos que se pintan en cada panel. El resto sigue en Rust. */
const SUCESOS = 40;

interface Props {
  chat: ChatEntry[];
  /** Actividad de la sesión, de la más reciente a la más antigua. */
  feed: FeedItem[];
  /** Seguidores nuevos acumulados por persona en la sesion, ya ordenados. */
  followRanking: RankingEntry[];
  /** Abre el perfil de TikTok de una persona. Lo resuelve `App`. */
  onOpenProfile: (uniqueId: string, nickname: string) => void;
  /** Reloj de la interfaz, para el «hace 3 s» de la actividad. */
  now: number;
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
  onClearFeed: () => void;
  /**
   * Si no hay sesión en curso. Es lo que decide si el chat vacío enseña el aviso
   * de cómo empezar: ahora que no hay panel, este es el primer sitio que se ve.
   */
  sinSesion: boolean;
}

export function Chat({
  chat,
  feed,
  followRanking,
  onOpenProfile,
  now,
  deleted,
  muted,
  onToggleMute,
  onClear,
  onClearFeed,
  sinSesion,
}: Props) {
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

  // El feed llega de lo mas reciente a lo mas antiguo y se parte por el tipo. La
  // actividad filtra **por exclusion** (`!== "follow"`) a proposito: si Rust
  // anade un suceso nuevo, cae aqui solo en vez de desaparecer en silencio por no
  // estar en una lista de inclusiones que nadie se acordaria de tocar.
  const follows = useMemo(
    () => feed.filter((item) => item.kind === "follow").slice(0, SUCESOS),
    [feed],
  );
  const actividad = useMemo(
    () => feed.filter((item) => item.kind !== "follow").slice(0, SUCESOS),
    [feed],
  );

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
      <div className="inicio-paneles">
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
            // Sin sesión, el hueco explica cómo empezar; con sesión, solo dice que
            // aún no ha llegado nada.
            <Empty>{sinSesion ? t.session.hint : t.chat.empty}</Empty>
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

        {/* Los tres paneles de la derecha. Van dentro de un contenedor propio
            porque su reparto de alto (1 / 1.2 / 1.4) no tiene nada que ver con el
            de la columna del chat; en ventanas apretadas ese contenedor
            desaparece (`display: contents`) y los cuatro se apilan. */}
        <div className="inicio-columna">
          <Card grow title={t.chat.followTitle}>
            <FeedList items={follows} now={now} empty={t.chat.followEmpty} />
          </Card>

          <Card grow title={t.aportaciones.follows}>
            <RankingTable
              entries={followRanking}
              valueLabel={t.aportaciones.value.follows}
              empty={t.chat.followersEmpty}
              interactive
              onOpenProfile={onOpenProfile}
            />
          </Card>

          <Card
            grow
            title={t.feed.title}
            actions={
              <button type="button" className="ghost" onClick={onClearFeed}>
                {t.feed.clear}
              </button>
            }
          >
            <FeedList items={actividad} now={now} />
          </Card>
        </div>
      </div>
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
