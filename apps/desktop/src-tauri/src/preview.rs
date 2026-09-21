//! Quien tiene el control del audio de **previsualizacion**.
//!
//! Hay tres sitios que reproducen un audio de prueba: el boton «oir» de la
//! biblioteca de sonidos de Alertas, el boton «probar» de la previa de un aviso y
//! la muestra de una voz. Los dos primeros suenan en el **monitor de alertas**
//! (Rust); el tercero suena en la interfaz, en un `<audio>`.
//!
//! El fallo que traia esto era que cada uno tiraba por su cuenta: se pulsaba
//! «oir» en un sonido, luego en otro, y **el primero seguia sonando por debajo**;
//! lo mismo entre la biblioteca y la previa del aviso. Aqui vive el **dueño
//! unico**: antes de reproducir nada se pide el turno, y pedirlo se lo quita al
//! que lo tuviera.
//!
//! Quien lo pide se lleva una **marca** (un numero de orden) para soltarlo
//! despues. Sin ella, el final del audio de A podria soltar el turno que ya es de
//! B: dos clics seguidos bastan para que la marca vieja llegue tarde. Es la misma
//! idea que la generacion de corte del reproductor (`tts/player.rs`), aplicada al
//! turno y no a la frase.
//!
//! Esto **no** es un reproductor: no guarda audio, ni rutas, ni volumen. Es el
//! turno, y nada mas.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{RwLock, RwLockWriteGuard};

use serde::{Deserialize, Serialize};

/// De donde viene un audio de previsualizacion.
///
/// Los nombres viajan en el JSON tal cual (`kebab-case`): la interfaz compara con
/// ellos, asi que renombrar una variante es cambiar el contrato.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OrigenPreview {
    /// El boton «oir» de la biblioteca de medios de Alertas.
    BibliotecaSonidos,
    /// El boton «probar» de la previa del aviso.
    PreviaAlerta,
    /// La muestra de una voz —o su prueba sintetizada—, que suena en la interfaz.
    MuestraVoz,
}

impl OrigenPreview {
    /// Si quien lo reproduce es el **monitor de alertas** y no la interfaz.
    ///
    /// Hace falta para dos cosas. Primero, para saber si hay que cortar el monitor
    /// al soltar el turno: la muestra de una voz no suena ahi, y cortarlo por ella
    /// cortaria una alerta de verdad que estuviera sonando. Segundo, para saber si
    /// el final lo puede ver Rust: el motor sabe cuando se acaba un fichero que ha
    /// encolado, pero de un `<audio>` de la interfaz no sabe nada.
    pub fn suena_en_el_motor(self) -> bool {
        matches!(self, Self::BibliotecaSonidos | Self::PreviaAlerta)
    }
}

/// Quien tiene el turno y que esta sonando.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DuenioPreview {
    pub origen: OrigenPreview,
    /// Que suena: el nombre del fichero, el tipo de aviso o la clave de la voz.
    pub id: String,
}

/// El turno del audio de previsualizacion.
#[derive(Debug, Default)]
pub struct PreviewAudio {
    duenio: RwLock<Option<DuenioPreview>>,
    /// Numero de orden de la ultima toma. Ver `soltar`.
    seq: AtomicU64,
}

impl PreviewAudio {
    pub fn nueva() -> Self {
        Self::default()
    }

    /// Pide el turno y se lo quita a quien lo tuviera.
    ///
    /// Devuelve la marca de esta toma, que es lo que hay que pasarle a `soltar`
    /// cuando el audio termine.
    pub fn tomar(&self, origen: OrigenPreview, id: impl Into<String>) -> u64 {
        let marca = self.seq.fetch_add(1, Ordering::AcqRel) + 1;
        *self.escribir() = Some(DuenioPreview {
            origen,
            id: id.into(),
        });
        marca
    }

    /// Suelta el turno, pero **solo** si la marca sigue siendo la vigente.
    ///
    /// Es lo que impide que el final de un audio viejo deje sin dueño al que suena
    /// ahora. Devuelve `true` si de verdad se solto.
    pub fn soltar(&self, marca: u64) -> bool {
        if self.seq.load(Ordering::Acquire) != marca {
            return false;
        }
        self.escribir().take().is_some()
    }

    /// Suelta el turno **solo si es el que se espera**, y devuelve quien lo tenia.
    ///
    /// Es lo que permite decir «corta lo que **yo** puse» sin poder cortar lo que
    /// puso otro mientras tanto. Dos ordenes cruzadas —la de parar y la de sonar—
    /// pueden llegar al reves, y sin esta condicion la de parar apagaria el sonido
    /// que acaba de empezar, que es peor que dejar sonar de mas.
    pub fn soltar_si(&self, esperado: &DuenioPreview) -> Option<DuenioPreview> {
        let mut guard = self.escribir();
        match guard.as_ref() {
            Some(actual) if actual == esperado => {
                let anterior = guard.take();
                self.seq.fetch_add(1, Ordering::AcqRel);
                anterior
            }
            _ => None,
        }
    }

    /// Suelta lo que haya, sea de quien sea, y devuelve quien lo tenia.
    ///
    /// La marca se mueve para que cualquier `soltar` pendiente del dueño anterior
    /// llegue tarde y no toque el turno del siguiente.
    pub fn parar(&self) -> Option<DuenioPreview> {
        self.seq.fetch_add(1, Ordering::AcqRel);
        self.escribir().take()
    }

    /// Quien tiene el turno ahora mismo.
    pub fn actual(&self) -> Option<DuenioPreview> {
        match self.duenio.read() {
            Ok(guard) => guard.clone(),
            // Un cerrojo envenenado no puede dejar el audio sin coordinador: se
            // lee igual y el streamer sigue pudiendo probar un sonido.
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn escribir(&self) -> RwLockWriteGuard<'_, Option<DuenioPreview>> {
        match self.duenio.write() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pedir_el_turno_se_lo_quita_al_anterior() {
        let preview = PreviewAudio::nueva();
        assert_eq!(preview.actual(), None);

        preview.tomar(OrigenPreview::BibliotecaSonidos, "campana.mp3");
        assert_eq!(
            preview.actual(),
            Some(DuenioPreview {
                origen: OrigenPreview::BibliotecaSonidos,
                id: "campana.mp3".into()
            })
        );

        preview.tomar(OrigenPreview::PreviaAlerta, "gift");
        assert_eq!(
            preview.actual(),
            Some(DuenioPreview {
                origen: OrigenPreview::PreviaAlerta,
                id: "gift".into()
            }),
            "el turno es de uno solo"
        );
    }

    #[test]
    fn una_marca_vieja_no_suelta_el_turno_del_siguiente() {
        let preview = PreviewAudio::nueva();
        let vieja = preview.tomar(OrigenPreview::BibliotecaSonidos, "campana.mp3");
        preview.tomar(OrigenPreview::BibliotecaSonidos, "redoble.mp3");

        // El fichero de la campana termina tarde, cuando ya suena el redoble.
        assert!(!preview.soltar(vieja), "esa toma ya no es la vigente");
        assert_eq!(
            preview.actual().map(|duenio| duenio.id),
            Some("redoble.mp3".into()),
            "el turno sigue siendo del que suena"
        );
    }

    #[test]
    fn la_marca_vigente_si_suelta_el_turno() {
        let preview = PreviewAudio::nueva();
        let marca = preview.tomar(OrigenPreview::MuestraVoz, "fish:voz-1");
        assert!(preview.soltar(marca));
        assert_eq!(preview.actual(), None);
        // Soltar dos veces no es un error, pero tampoco suelta nada.
        assert!(!preview.soltar(marca));
    }

    #[test]
    fn solo_se_suelta_el_turno_que_se_espera() {
        let preview = PreviewAudio::nueva();
        let campana = DuenioPreview {
            origen: OrigenPreview::BibliotecaSonidos,
            id: "campana.mp3".into(),
        };
        preview.tomar(campana.origen, campana.id.clone());

        // Otro preview tomo el relevo: el que esperaba soltar ya no es el suyo.
        preview.tomar(OrigenPreview::PreviaAlerta, "gift");
        assert_eq!(preview.soltar_si(&campana), None, "no se suelta lo ajeno");
        assert_eq!(
            preview.actual().map(|duenio| duenio.id),
            Some("gift".into()),
            "el turno sigue donde estaba"
        );

        // Y el que si es suyo se suelta.
        let suyo = preview.actual().expect("hay turno");
        assert_eq!(preview.soltar_si(&suyo), Some(suyo));
        assert_eq!(preview.actual(), None);
    }

    #[test]
    fn parar_devuelve_a_quien_se_le_quito() {
        let preview = PreviewAudio::nueva();
        assert_eq!(preview.parar(), None);
        preview.tomar(OrigenPreview::BibliotecaSonidos, "campana.mp3");
        assert_eq!(
            preview.parar().map(|duenio| duenio.origen),
            Some(OrigenPreview::BibliotecaSonidos)
        );
        assert_eq!(preview.actual(), None);
    }

    #[test]
    fn solo_los_previews_del_motor_suenan_en_el_motor() {
        assert!(OrigenPreview::BibliotecaSonidos.suena_en_el_motor());
        assert!(OrigenPreview::PreviaAlerta.suena_en_el_motor());
        assert!(
            !OrigenPreview::MuestraVoz.suena_en_el_motor(),
            "una muestra de voz suena en el <audio> de la interfaz"
        );
    }
}
