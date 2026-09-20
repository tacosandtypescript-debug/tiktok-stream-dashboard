//! El saldo de la cuenta de Fish, preguntado a su API.
//!
//! Todo lo demas que enseña la pestaña de Voz se calcula **aqui**, en local: el
//! gasto son bytes por precio y no hace falta salir a la red para saberlo. Lo que
//! **queda** en la cuenta es lo unico que no: eso lo lleva Fish, y hay que
//! preguntarselo.
//!
//! Se pregunta a `GET https://api.fish.audio/wallet/self/package`, contrastado
//! contra el esquema de `https://docs.fish.audio/api-reference/endpoint/wallet`:
//!
//!   * el `{user_id}` de la ruta admite **`self`** (`"default": "self"` en el
//!     esquema), asi que no hace falta conocer el identificador de la cuenta: la
//!     clave ya dice de quien es. Comprobado contra la API real;
//!   * cabecera `Authorization: Bearer <clave>`, la misma que la sintesis;
//!   * respuesta: `total` (lo que trae el plan), `balance` (lo que queda),
//!     `type` (`free`, ...).
//!
//! **Se cachea, y no por gusto.** La interfaz se refresca cada segundo y el saldo
//! no cambia a ese ritmo: preguntarlo a esa frecuencia seria abusar de una API
//! ajena —y la cuenta gratuita tiene tope—. Se pregunta como mucho una vez cada
//! [`CADA`], y si falla se espera menos antes de reintentar, porque un fallo suele
//! ser un corte de red pasajero.
//!
//! Un fallo **no se calla**: un saldo que no se ha podido consultar no es lo mismo
//! que un saldo a cero, y la interfaz tiene que poder distinguirlo.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::providers::BoxFuture;
use crate::secreto::Secreto;

/// El endpoint. `self` donde iria el identificador de usuario.
pub const ENDPOINT: &str = "https://api.fish.audio/wallet/self/package";

/// Cada cuanto se vuelve a preguntar, como mucho.
pub const CADA: Duration = Duration::from_secs(300);

/// Lo que se espera tras un fallo antes de reintentar.
pub const TRAS_FALLO: Duration = Duration::from_secs(45);

/// Tope de la respuesta que se lee. El saldo son unos cientos de bytes; con un
/// tope, una respuesta que se desmadre no se traga la memoria.
const MAX_RESPUESTA: usize = 8 * 1024;

/// El saldo de la cuenta, en crudo.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Cuota {
    /// Lo que trae el plan. `None` si la API no manda el campo.
    pub total: Option<i64>,
    /// Lo que queda.
    pub restante: Option<i64>,
    /// `free`, `pro`... Lo que diga la API, sin traducir.
    pub tipo: String,
}

impl Cuota {
    /// El porcentaje que queda, de 0 a 100.
    ///
    /// Devuelve `None` cuando no se puede calcular —falta un dato o el total es
    /// cero—, y eso es a proposito: inventarse un 0 % o un 100 % seria pintar una
    /// barra que miente. Quien la pinte tiene que saber que no hay numero.
    pub fn porcentaje(&self) -> Option<f64> {
        let total = self.total?;
        let restante = self.restante?;
        if total <= 0 {
            return None;
        }
        let proporcion = restante as f64 / total as f64;
        Some((proporcion * 100.0).clamp(0.0, 100.0))
    }
}

/// El saldo ya listo para pintar, con cuando se pregunto.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CuotaStatus {
    #[serde(flatten)]
    pub cuota: Cuota,
    /// Lo que queda, de 0 a 100. `None` si no se puede calcular.
    ///
    /// Se resuelve **aqui** y no en la interfaz: es el numero que mueve el anillo,
    /// y con dos sitios donde calcularlo acabarian enseñando cosas distintas.
    pub porcentaje: Option<f64>,
    /// Hace cuanto se pregunto, en segundos. La interfaz lo usa para decir si el
    /// dato es de hace un rato en vez de hacerlo pasar por recien leido.
    pub hace_segs: u64,
    /// El motivo del ultimo fallo, si lo hubo. Se enseña.
    pub error: Option<String>,
}

/// Lee la respuesta de la API.
///
/// Es una funcion **pura** y por eso es la que se prueba: aqui esta lo unico que
/// puede equivocarse de verdad —que el campo se llame de otra forma o que venga
/// como texto en vez de numero—, y no hace falta red para comprobarlo.
pub fn parsear(cuerpo: &str) -> Result<Cuota, String> {
    let valor: serde_json::Value =
        serde_json::from_str(cuerpo).map_err(|e| format!("respuesta ilegible: {e}"))?;

    // Los numeros pueden venir como numero o como texto. La API manda enteros,
    // pero `credit` en el endpoint hermano viene entre comillas: se aceptan las
    // dos formas en vez de dar por hecho cual va a llegar.
    let entero = |clave: &str| -> Option<i64> {
        let v = valor.get(clave)?;
        v.as_i64().or_else(|| v.as_str()?.trim().parse().ok())
    };

    let cuota = Cuota {
        total: entero("total"),
        restante: entero("balance"),
        tipo: valor
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    };

    // Una respuesta sin ninguno de los dos numeros no es un saldo: se trata como
    // fallo para que la interfaz lo diga, en vez de pintar una cuota vacia.
    if cuota.total.is_none() && cuota.restante.is_none() {
        return Err("la respuesta no trae saldo".to_string());
    }
    Ok(cuota)
}

/// Lo que se ha preguntado y cuando, para no repetirlo.
///
/// Se guarda tambien el **fallo**: si la ultima consulta fue mal, no se vuelve a
/// intentar en cada refresco de la interfaz, pero tampoco se olvida el motivo.
#[derive(Debug, Default)]
pub struct Saldo {
    ultima: Option<(Instant, Result<Cuota, String>)>,
}

impl Saldo {
    /// Si toca preguntar a esta hora.
    pub fn toca(&self, ahora: Instant) -> bool {
        match &self.ultima {
            None => true,
            Some((cuando, Ok(_))) => ahora.duration_since(*cuando) >= CADA,
            Some((cuando, Err(_))) => ahora.duration_since(*cuando) >= TRAS_FALLO,
        }
    }

    /// Apunta lo que se pregunto.
    pub fn apuntar(&mut self, cuando: Instant, resultado: Result<Cuota, String>) {
        self.ultima = Some((cuando, resultado));
    }

    /// Lo que hay que enseñar, con la antiguedad puesta al dia.
    ///
    /// `None` solo si nunca se ha preguntado: mientras haya un resultado —bueno o
    /// malo— siempre hay algo que decir.
    pub fn status(&self, ahora: Instant) -> Option<CuotaStatus> {
        let (cuando, resultado) = self.ultima.as_ref()?;
        let hace = ahora.duration_since(*cuando).as_secs();
        Some(match resultado {
            Ok(cuota) => CuotaStatus {
                porcentaje: cuota.porcentaje(),
                cuota: cuota.clone(),
                hace_segs: hace,
                error: None,
            },
            Err(motivo) => CuotaStatus {
                cuota: Cuota::default(),
                porcentaje: None,
                hace_segs: hace,
                error: Some(motivo.clone()),
            },
        })
    }

    /// Olvida lo preguntado, para forzar una consulta en el siguiente turno.
    ///
    /// Se usa cuando cambian las claves: el saldo de la clave nueva puede no tener
    /// nada que ver con el de la anterior, asi que el dato guardado deja de valer.
    pub fn invalidar(&mut self) {
        self.ultima = None;
    }
}

/// Quien pregunta el saldo.
///
/// Es un trait por el mismo motivo que [`super::fish::ClienteTts`]: poder probar
/// el proveedor **sin red**. El de verdad es [`ClienteHttpCuota`].
pub trait ClienteCuota: Send + Sync {
    fn pedir<'a>(&'a self, clave: &'a Secreto) -> BoxFuture<'a, Result<Cuota, String>>;
}

/// Cliente real: `reqwest` con rustls, como el de la sintesis.
pub struct ClienteHttpCuota {
    cliente: OnceLock<reqwest::Client>,
}

impl ClienteHttpCuota {
    pub fn nuevo() -> Self {
        Self {
            cliente: OnceLock::new(),
        }
    }

    fn cliente(&self) -> Result<reqwest::Client, String> {
        if let Some(c) = self.cliente.get() {
            return Ok(c.clone());
        }
        let c = reqwest::Client::builder()
            // Es una consulta de adorno: si tarda, estorba. Mas vale decir «no se
            // pudo» que dejar la interfaz esperando un saldo.
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(8))
            .user_agent(concat!(
                "tiktok-stream-dashboard/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|e| format!("cliente HTTPS: {e}"))?;
        let _ = self.cliente.set(c.clone());
        Ok(c)
    }
}

impl ClienteCuota for ClienteHttpCuota {
    fn pedir<'a>(&'a self, clave: &'a Secreto) -> BoxFuture<'a, Result<Cuota, String>> {
        Box::pin(async move {
            let cliente = self.cliente()?;
            let respuesta = cliente
                .get(ENDPOINT)
                // `bearer_auth` escribe `Authorization: Bearer <clave>`. La clave
                // sale por aqui y por ningun sitio mas.
                .bearer_auth(clave.exponer())
                .send()
                .await
                .map_err(|e| format!("no se pudo preguntar el saldo: {e}"))?;

            let status = respuesta.status();
            if !status.is_success() {
                // 401 es la clave; 429, el ritmo. Se distingue porque el arreglo es
                // distinto: una se cambia y la otra se espera.
                let pista = match status.as_u16() {
                    401 | 403 => "la clave no vale para consultar el saldo",
                    429 => "demasiadas consultas seguidas: se espera",
                    _ => "la API respondio con un error",
                };
                return Err(format!("{pista} (HTTP {})", status.as_u16()));
            }

            let cuerpo = respuesta
                .text()
                .await
                .map_err(|e| format!("no se pudo leer la respuesta: {e}"))?;
            if cuerpo.len() > MAX_RESPUESTA {
                return Err("la respuesta del saldo es demasiado grande".to_string());
            }
            parsear(&cuerpo)
        })
    }
}

/// Un cliente que se inventa la respuesta. Para las pruebas.
#[cfg(test)]
pub struct ClienteFalso {
    respuestas: std::sync::Mutex<Vec<Result<Cuota, String>>>,
    claves: std::sync::Mutex<Vec<String>>,
}

#[cfg(test)]
impl ClienteFalso {
    pub fn nuevo(respuestas: Vec<Result<Cuota, String>>) -> Self {
        Self {
            respuestas: std::sync::Mutex::new(respuestas),
            claves: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Con que claves se llamo, en orden. La pista, nunca la clave entera.
    pub fn pistas(&self) -> Vec<String> {
        self.claves
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

#[cfg(test)]
impl ClienteCuota for ClienteFalso {
    fn pedir<'a>(&'a self, clave: &'a Secreto) -> BoxFuture<'a, Result<Cuota, String>> {
        Box::pin(async move {
            self.claves
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(clave.pista().unwrap_or_default());
            let mut respuestas = self.respuestas.lock().unwrap_or_else(|e| e.into_inner());
            if respuestas.is_empty() {
                return Err("el doble no tiene mas respuestas".to_string());
            }
            respuestas.remove(0)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La respuesta real de la API, recortada a lo que se usa. Es la que devolvio
    /// `GET /wallet/self/package` el 2026-09-19 con una cuenta gratuita.
    const REAL: &str = r#"{
        "_id": "7849993b04504d80b602cdfd0176190c",
        "user_id": "f5e835a119694e1aabd458434810250a",
        "team_id": "f5e835a119694e1aabd458434810250a",
        "total": 8000,
        "balance": 8000,
        "extra_balance": 0,
        "type": "free",
        "billing_period": "month",
        "cancel_at_period_end": false
    }"#;

    #[test]
    fn lee_la_respuesta_de_verdad() {
        let cuota = parsear(REAL).expect("la respuesta real tiene que leerse");
        assert_eq!(cuota.total, Some(8000));
        assert_eq!(cuota.restante, Some(8000));
        assert_eq!(cuota.tipo, "free");
    }

    #[test]
    fn los_numeros_entre_comillas_tambien_valen() {
        // El endpoint hermano (`api-credit`) manda `credit` como texto. Aceptar las
        // dos formas evita que un cambio de formato deje el saldo en blanco.
        let cuota = parsear(r#"{"total": "8000", "balance": "1", "type": "free"}"#).unwrap();
        assert_eq!(cuota.total, Some(8000));
        assert_eq!(cuota.restante, Some(1));
    }

    #[test]
    fn una_respuesta_sin_saldo_es_un_fallo() {
        // Un 200 con otra cosa dentro no es un saldo: decirlo es mejor que pintar
        // una cuota a cero, que se leeria como «se te acabo».
        assert!(parsear(r#"{"ok": true}"#).is_err());
        assert!(parsear("no soy json").is_err());
    }

    #[test]
    fn falta_uno_de_los_dos_numeros_y_el_porcentaje_no_se_inventa() {
        let solo_restante = parsear(r#"{"balance": 10, "type": "free"}"#).unwrap();
        assert_eq!(solo_restante.restante, Some(10));
        assert_eq!(solo_restante.porcentaje(), None);

        let total_cero = parsear(r#"{"total": 0, "balance": 0, "type": "free"}"#).unwrap();
        assert_eq!(total_cero.porcentaje(), None, "no se divide por cero");
    }

    #[test]
    fn el_porcentaje_es_lo_que_queda() {
        let lleno = parsear(REAL).unwrap();
        assert_eq!(lleno.porcentaje(), Some(100.0));

        let medio = parsear(r#"{"total": 8000, "balance": 4000, "type": "free"}"#).unwrap();
        assert_eq!(medio.porcentaje(), Some(50.0));

        let vacio = parsear(r#"{"total": 8000, "balance": 0, "type": "free"}"#).unwrap();
        assert_eq!(vacio.porcentaje(), Some(0.0));
    }

    #[test]
    fn un_saldo_mayor_que_el_plan_no_pasa_del_cien() {
        // `extra_balance` existe: una recarga puede dejar el saldo por encima del
        // plan. La barra no puede salirse del circulo.
        let cuota = parsear(r#"{"total": 100, "balance": 250, "type": "free"}"#).unwrap();
        assert_eq!(cuota.porcentaje(), Some(100.0));
    }

    #[test]
    fn no_se_pregunta_otra_vez_hasta_que_toca() {
        let cero = Instant::now();
        let mut saldo = Saldo::default();
        assert!(saldo.toca(cero), "la primera vez siempre toca");

        saldo.apuntar(cero, Ok(parsear(REAL).unwrap()));
        assert!(!saldo.toca(cero + Duration::from_secs(1)));
        assert!(!saldo.toca(cero + CADA - Duration::from_secs(1)));
        assert!(saldo.toca(cero + CADA), "cumplido el plazo, si");
    }

    #[test]
    fn tras_un_fallo_se_reintenta_antes_que_tras_un_acierto() {
        let cero = Instant::now();
        let mut saldo = Saldo::default();
        saldo.apuntar(cero, Err("se cayo la red".to_string()));

        // Un corte de red se pasa; esperar los cinco minutos del acierto dejaria el
        // saldo en blanco un rato largo por nada.
        assert!(TRAS_FALLO < CADA);
        assert!(!saldo.toca(cero + TRAS_FALLO - Duration::from_secs(1)));
        assert!(saldo.toca(cero + TRAS_FALLO));
    }

    #[test]
    fn el_fallo_se_enseña_y_no_se_confunde_con_un_cero() {
        let cero = Instant::now();
        let mut saldo = Saldo::default();
        assert!(
            saldo.status(cero).is_none(),
            "sin preguntar no hay nada que decir"
        );

        saldo.apuntar(cero, Err("sin conexion".to_string()));
        let status = saldo.status(cero + Duration::from_secs(30)).unwrap();
        assert_eq!(status.error.as_deref(), Some("sin conexion"));
        assert_eq!(status.hace_segs, 30);
        assert_eq!(status.cuota.porcentaje(), None, "y no hay barra que pintar");
    }

    #[test]
    fn la_antiguedad_se_calcula_al_leer_y_no_al_guardar() {
        // Si se guardara el `hace`, el numero se quedaria congelado en el momento de
        // la consulta y la interfaz diria «hace 0 s» para siempre.
        let cero = Instant::now();
        let mut saldo = Saldo::default();
        saldo.apuntar(cero, Ok(parsear(REAL).unwrap()));

        assert_eq!(saldo.status(cero).unwrap().hace_segs, 0);
        assert_eq!(
            saldo
                .status(cero + Duration::from_secs(90))
                .unwrap()
                .hace_segs,
            90
        );
    }

    #[test]
    fn cambiar_de_clave_obliga_a_volver_a_preguntar() {
        // El saldo es de la cuenta, y dos claves pueden ser de cuentas distintas.
        let cero = Instant::now();
        let mut saldo = Saldo::default();
        saldo.apuntar(cero, Ok(parsear(REAL).unwrap()));
        assert!(!saldo.toca(cero + Duration::from_secs(1)));

        saldo.invalidar();
        assert!(saldo.toca(cero + Duration::from_secs(1)));
        assert!(saldo.status(cero + Duration::from_secs(1)).is_none());
    }
}
