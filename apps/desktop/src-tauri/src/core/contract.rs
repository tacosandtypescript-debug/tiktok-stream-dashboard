//! Contrato entre Rust y la interfaz.
//!
//! La interfaz reconoce cada evento por el campo `type` y lee campos concretos.
//! Si un cambio en `EventKind` altera esa forma, la interfaz deja de actualizarse
//! **en silencio**: los eventos siguen llegando, pero ningun `case` coincide y
//! nada se repinta. Este test fija esa forma para que no pueda volver a pasar
//! sin que salte una alarma.
//!
//! Es la contrapartida en Rust de un contract test de TypeScript, y evita anadir
//! un runner de pruebas al frontend.

use serde_json::Value;

use crate::core::event::{Event, EventKind, GiftInfo, UserRef};

fn user() -> UserRef {
    UserRef {
        id: "123456".into(),
        unique_id: "carlos123".into(),
        nickname: "Carlos".into(),
    }
}

fn gift() -> GiftInfo {
    GiftInfo {
        id: "5655".into(),
        name: "Rose".into(),
        image_url: "https://cdn.example/rose.png".into(),
        diamond_count: 1,
        streakable: true,
        repeat_count: 25,
        is_final: true,
        group_id: "abc123".into(),
    }
}

fn serialized(kind: EventKind) -> Value {
    let event = Event::new(7, "7686381796992322334".into(), Some("msg-1".into()), kind);
    serde_json::to_value(&event).expect("el evento debe serializar")
}

/// Comprueba que el evento lleva el tipo plano y los campos que la interfaz lee.
#[test]
fn todos_los_eventos_llevan_el_tipo_plano_y_sus_campos() {
    // (tipo esperado, evento, campos que la interfaz lee)
    let casos: Vec<(&str, EventKind, Vec<(&str, &str)>)> = vec![
        (
            "stream.connected",
            EventKind::StreamConnected {
                room_id: "123".into(),
                title: "directo".into(),
            },
            vec![("room_id", "string"), ("title", "string")],
        ),
        (
            "stream.disconnected",
            EventKind::StreamDisconnected {
                reason: "fin".into(),
            },
            vec![("reason", "string")],
        ),
        (
            "stream.waiting",
            EventKind::StreamWaiting {
                handle: "carlos".into(),
                detail: "no esta en directo".into(),
            },
            vec![("handle", "string"), ("detail", "string")],
        ),
        (
            "chat.message",
            EventKind::ChatMessage {
                user: user(),
                content: "hola".into(),
                emote_count: 0,
            },
            vec![
                ("content", "string"),
                ("user", "object"),
                ("emote_count", "number"),
            ],
        ),
        (
            "chat.message.deleted",
            EventKind::ChatMessageDeleted {
                target_source_id: "m1".into(),
            },
            vec![("target_source_id", "string")],
        ),
        (
            "member.joined",
            EventKind::MemberJoined { user: user() },
            vec![("user", "object")],
        ),
        (
            "gift.received",
            EventKind::GiftReceived {
                user: user(),
                gift: gift(),
            },
            vec![("user", "object"), ("gift", "object")],
        ),
        (
            "like.updated",
            EventKind::LikeUpdated {
                user: Some(user()),
                count: 15,
                total: 25547,
            },
            vec![("count", "number"), ("total", "number"), ("user", "object")],
        ),
        (
            "viewer.updated",
            EventKind::ViewerUpdated {
                current: 130,
                cumulative: 9123,
            },
            vec![("current", "number"), ("cumulative", "number")],
        ),
        (
            "follow.received",
            EventKind::FollowReceived { user: user() },
            vec![("user", "object")],
        ),
        (
            "share.received",
            EventKind::ShareReceived { user: user() },
            vec![("user", "object")],
        ),
        (
            "subscribe.received",
            EventKind::SubscribeReceived {
                user: user(),
                months: 3,
            },
            vec![("user", "object"), ("months", "number")],
        ),
        (
            "provider.status",
            EventKind::ProviderStatus {
                status: "connected".into(),
                detail: Some("sala 123".into()),
            },
            vec![("status", "string")],
        ),
        (
            "gifts.updated",
            EventKind::GiftsUpdated {
                total_gifts: 3,
                total_diamonds: 3,
                top_gifters: vec![crate::core::event::GifterEntry {
                    user: user(),
                    diamonds: 3,
                    gifts: 3,
                }],
                gifts_by_type: vec![crate::core::event::GiftTypeSummary {
                    gift_id: "5655".into(),
                    gift_name: "Rose".into(),
                    count: 3,
                    diamonds: 3,
                }],
            },
            vec![
                ("total_gifts", "number"),
                ("total_diamonds", "number"),
                ("top_gifters", "array"),
                ("gifts_by_type", "array"),
            ],
        ),
    ];

    for (esperado, kind, campos) in casos {
        let json = serialized(kind);
        assert_eq!(
            json.get("type").and_then(Value::as_str),
            Some(esperado),
            "el campo `type` debe ir en la raiz y valer {esperado}: {json}"
        );
        // La envoltura del protocolo sigue presente.
        for clave in ["protocol_version", "event_id", "seq", "timestamp_ms", "room_id"] {
            assert!(json.get(clave).is_some(), "falta {clave} en {json}");
        }
        // Y los campos que la interfaz lee, con el tipo JSON correcto.
        for (clave, tipo) in campos {
            let valor = json
                .get(clave)
                .unwrap_or_else(|| panic!("falta {clave} en {esperado}: {json}"));
            let coincide = match tipo {
                "string" => valor.is_string(),
                "number" => valor.is_number(),
                "object" => valor.is_object(),
                "array" => valor.is_array(),
                other => panic!("tipo de comprobacion desconocido: {other}"),
            };
            assert!(coincide, "{clave} no es {tipo} en {esperado}: {json}");
        }
        // El enum no debe quedar anidado: `kind` no existe como campo.
        assert!(
            json.get("kind").is_none(),
            "el enum quedo anidado en {esperado}: {json}"
        );
    }
}

/// Los campos del regalo que el panel muestra deben viajar completos.
#[test]
fn el_regalo_llega_con_usuario_regalo_cantidad_diamantes_y_racha() {
    let json = serialized(EventKind::GiftReceived {
        user: user(),
        gift: gift(),
    });
    let regalo = json.get("gift").expect("regalo");

    assert_eq!(regalo["id"], "5655");
    assert_eq!(regalo["name"], "Rose");
    assert_eq!(regalo["image_url"], "https://cdn.example/rose.png");
    assert_eq!(regalo["diamond_count"], 1);
    assert_eq!(regalo["repeat_count"], 25);
    assert_eq!(regalo["streakable"], true);
    assert_eq!(regalo["is_final"], true);
    assert_eq!(regalo["group_id"], "abc123");

    let usuario = json.get("user").expect("usuario");
    assert_eq!(usuario["id"], "123456");
    assert_eq!(usuario["unique_id"], "carlos123");
    assert_eq!(usuario["nickname"], "Carlos");
}

/// El contrato conserva separados el incremento de una rafaga y el total
/// absoluto del directo: la interfaz muestra el segundo y el feed puede usar el
/// primero para decidir si la rafaga es notable.
#[test]
fn el_contrato_de_likes_separa_incremento_y_total_absoluto() {
    let json = serialized(EventKind::LikeUpdated {
        user: Some(user()),
        count: 8,
        total: 1_008,
    });

    assert_eq!(json["count"], 8);
    assert_eq!(json["total"], 1_008);
    assert_ne!(json["count"], json["total"]);
}

/// Los campos opcionales ausentes no deben aparecer como `null`.
#[test]
fn los_opcionales_ausentes_no_se_serializan() {
    let event = Event::new(
        1,
        "sala".into(),
        None,
        EventKind::ChatMessage {
            user: user(),
            content: "hola".into(),
            emote_count: 0,
        },
    );
    let json = serde_json::to_value(&event).expect("serializa");
    assert!(
        json.get("source_id").is_none(),
        "source_id ausente no debe enviarse: {json}"
    );

    // Y cuando si existe, viaja como cadena.
    let con_id = serialized(EventKind::ChatMessage {
        user: user(),
        content: "hola".into(),
        emote_count: 0,
    });
    assert_eq!(con_id["source_id"], "msg-1");
}
