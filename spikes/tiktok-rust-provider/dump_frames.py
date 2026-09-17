"""Vuelca cabeceras y payload (hex) de los frames de un .jsonl real."""

import base64
import gzip
import json
import sys


def varint(buf, pos):
    result = 0
    shift = 0
    while True:
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7


def campos(buf):
    pos = 0
    out = []
    while pos < len(buf):
        key, pos = varint(buf, pos)
        numero, wire = key >> 3, key & 7
        if wire == 0:
            valor, pos = varint(buf, pos)
        elif wire == 2:
            largo, pos = varint(buf, pos)
            valor = buf[pos:pos + largo]
            pos += largo
        else:
            raise ValueError(f"wire {wire}")
        out.append((numero, wire, valor))
    return out


def hexa(b, n=160):
    return " ".join(f"{x:02x}" for x in b[:n])


def main(path, quiero):
    vistos = 0
    with open(path, encoding="utf8") as fh:
        for linea in fh:
            registro = json.loads(linea)
            raw = base64.b64decode(registro["b64"])
            plano = {}
            for numero, wire, valor in campos(raw):
                plano.setdefault(numero, valor)
            tipo = plano.get(7, b"").decode("utf8", "replace")
            if tipo not in quiero:
                continue
            cabeceras = []
            try:
                for numero, wire, valor in campos(plano.get(5, b"")):
                    if numero == 1:
                        par = {n: v for n, w, v in campos(valor) if w == 2}
                        cabeceras.append(
                            (
                                par.get(1, b"").decode("utf8", "replace"),
                                par.get(2, b"").decode("utf8", "replace"),
                            )
                        )
            except Exception as error:  # noqa: BLE001
                cabeceras = [f"<no interpretables: {error}>"]
            payload = plano.get(8, b"")
            descomprimido = None
            if payload[:2] == b"\x1f\x8b":
                descomprimido = gzip.decompress(payload)
            print(f"--- t={registro.get('t')} payload_type={tipo}")
            print(f"    seq_id={plano.get(1)} log_id={plano.get(2)} service={plano.get(3)} method={plano.get(4)}")
            print(f"    encoding={plano.get(6, b'').decode('utf8', 'replace')!r}")
            print(f"    cabeceras={cabeceras}")
            print(f"    payload {len(payload)} bytes: {hexa(payload, 40)}")
            if descomprimido is not None:
                print(f"    descomprimido {len(descomprimido)} bytes: {hexa(descomprimido)}")
            vistos += 1
            if vistos >= 6:
                break


if __name__ == "__main__":
    main(sys.argv[1], set(sys.argv[2:]) or {"hb", "im_enter_room_resp"})
