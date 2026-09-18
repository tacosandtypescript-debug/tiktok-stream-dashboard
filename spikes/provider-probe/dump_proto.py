"""Vuelca los numeros de campo reales del protobuf v3 instalado.

En lugar de leer a mano el codigo generado (miles de lineas), interroga la
metadata de betterproto2 en tiempo de ejecucion y emite un JSON compacto que
sirve para escribir los structs de prost en Rust.

    python dump_proto.py --out proto-fields.json
    python dump_proto.py --only WebcastChatMessage      # Rust-ready por clase
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

MESSAGES = "TikTokLiveProto.v3.webcast.model.message"
SHARED = "TikTokLiveProto.v3.webcast.shared.message"
IM = "TikTokLiveProto.v3.webcast.im"

TARGETS: dict[str, tuple[str, str]] = {
    "ProtoMessageFetchResult": (SHARED, "ProtoMessageFetchResult"),
    "CommonMessageData": (SHARED, "CommonMessageData"),
    "WebcastPushFrame": (IM, "WebcastPushFrame"),
    "PushHeader": (IM, "PushHeader"),
    "User": ("TikTokLiveProto.v3.webcast.model.base.user", "User"),
    "Gift": ("TikTokLiveProto.v3.webcast.model", "Gift"),
    "WebcastChatMessage": (MESSAGES, "WebcastChatMessage"),
    "WebcastGiftMessage": (MESSAGES, "WebcastGiftMessage"),
    "WebcastLikeMessage": (MESSAGES, "WebcastLikeMessage"),
    "WebcastMemberMessage": (MESSAGES, "WebcastMemberMessage"),
    "WebcastRoomUserSeqMessage": (MESSAGES, "WebcastRoomUserSeqMessage"),
    "WebcastSocialMessage": (MESSAGES, "WebcastSocialMessage"),
    "WebcastSubNotifyMessage": (MESSAGES, "WebcastSubNotifyMessage"),
    "WebcastMemberMessage": (MESSAGES, "WebcastMemberMessage"),
    "ImageModel": ("TikTokLiveProto.v3.webcast.model.base", "ImageModel"),
    "ProtoMessageFetchResultMessage": (SHARED, "ProtoMessageFetchResultMessage"),
    "Message": (SHARED, "Message"),
    # Mensajes que el cliente envia por el WebSocket: sin el `im_enter_room` el
    # push server no empieza a empujar nada (ver docs/decisions.md D10).
    "WebcastImEnterRoomMessage": (IM, "WebcastImEnterRoomMessage"),
    "HeartBeatMessage": (IM, "HeartBeatMessage"),
}

# Nombres de proto_type de betterproto2 -> tipo Rust de prost
RUST_SCALARS = {
    "double": "f64", "float": "f32",
    "int32": "i32", "int64": "i64",
    "uint32": "u32", "uint64": "u64",
    "sint32": "i32", "sint64": "i64",
    "fixed32": "u32", "fixed64": "u64",
    "sfixed32": "i32", "sfixed64": "i64",
    "bool": "bool", "string": "String", "bytes": "Vec<u8>",
    "enum": "i32",
}


def load(path: str, name: str) -> Any:
    module = __import__(path, fromlist=[name])
    return getattr(module, name)


def field_info(meta: Any, cls_by_field: dict, name: str) -> dict:
    info: dict[str, Any] = {}
    for attr in dir(meta):
        if attr.startswith("_"):
            continue
        try:
            value = getattr(meta, attr)
        except Exception:  # noqa: BLE001
            continue
        if callable(value):
            continue
        if isinstance(value, (int, float, bool, str, type(None))):
            info[attr] = value
        else:
            info[attr] = getattr(value, "name", None) or repr(value)[:40]

    for key in ("number", "field_number", "num", "tag"):
        if isinstance(info.get(key), int):
            return {
                "number": info[key],
                "proto_type": info.get("proto_type") or info.get("type"),
                "repeated": bool(info.get("repeated", False)),
                "optional": bool(info.get("optional", False)),
                "cls": getattr(cls_by_field.get(name), "__name__", None),
            }
    return {"number": None, "raw": info, "cls": getattr(cls_by_field.get(name), "__name__", None)}


def dump_all() -> dict:
    result: dict[str, Any] = {}
    for label, (path, name) in TARGETS.items():
        try:
            cls = load(path, name)
            meta = getattr(cls, "_betterproto")
            cls_by_field = getattr(meta, "cls_by_field", {})
            fields = {
                fname: field_info(fmeta, cls_by_field, fname)
                for fname, fmeta in (getattr(meta, "meta_by_field_name", {}) or {}).items()
            }
            result[label] = {"module": path, "fields": fields}
        except Exception as exc:  # noqa: BLE001
            result[label] = {"error": f"{type(exc).__name__}: {exc}"}
    return result


def render_rust(label: str, data: dict) -> str:
    lines = [f"// {label}  ({data.get('module')})", f"pub struct {label} {{"]
    for fname, info in data.get("fields", {}).items():
        if info.get("number") is None:
            lines.append(f"    // ??? {fname}: {info}")
            continue
        rust_name = fname if fname not in {"type", "loop", "match", "move", "ref", "box", "self"} else f"{fname}_"
        proto = info.get("proto_type")
        if info.get("cls"):
            base = info["cls"]
        else:
            base = RUST_SCALARS.get(str(proto), f"/*{proto}*/ Vec<u8>")
        if info.get("repeated"):
            base = f"Vec<{base}>"
        elif info.get("cls") or (proto == "message" and not info.get("optional")):
            base = f"Option<{base}>"
        lines.append(f'    #[prost({proto}, tag = "{info["number"]}")]')
        lines.append(f"    pub {rust_name}: {base},")
    lines.append("}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path)
    parser.add_argument("--only")
    parser.add_argument("--filter", help="regex sobre el nombre de campo")
    parser.add_argument("--names", action="store_true", help="lista compacta numero: nombre (tipo)")
    args = parser.parse_args()

    result = dump_all()

    if args.only:
        if args.only not in result:
            print(f"desconocido: {args.only}. Opciones: {', '.join(result)}", file=sys.stderr)
            return 2
        data = result[args.only]
        if "error" in data:
            print(f"{args.only}: {data['error']}", file=sys.stderr)
            return 2

        fields = data.get("fields", {})
        if args.filter:
            import re
            pattern = re.compile(args.filter, re.IGNORECASE)
            fields = {k: v for k, v in fields.items() if pattern.search(k)}

        if args.names:
            print(f"// {args.only} ({data.get('module')})")
            for fname, info in fields.items():
                cls = f"  -> {info['cls']}" if info.get("cls") else ""
                rep = "[]" if info.get("repeated") else ""
                print(f"{info.get('number')}: {fname} ({info.get('proto_type')}){rep}{cls}")
            return 0

        print(render_rust(args.only, {"module": data.get("module"), "fields": fields}))
        return 0

    if args.out:
        args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        summary = {
            label: len(data.get("fields", {})) if "fields" in data else data
            for label, data in result.items()
        }
        print(json.dumps(summary, indent=2))
        print(f"escrito: {args.out}")
        return 0

    # Sin --out: solo el resumen, para no inundar la consola.
    for label, data in result.items():
        count = len(data.get("fields", {})) if "fields" in data else 0
        missing = [f for f, i in data.get("fields", {}).items() if i.get("number") is None]
        print(f"{label}: {count} campos" + (f"  SIN NUMERO: {missing}" if missing else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
