//! Las plantillas de lo que se lee en voz alta.
//!
//! Va **aparte** del chat y de los proveedores de voz a proposito: componer la
//! frase no tiene nada que ver con quien la sintetiza ni con de donde vino el
//! evento. Anadir un proveedor nuevo no toca esto, y cambiar una plantilla no
//! toca ni el bus ni la API de voz.
//!
//! Una plantilla es texto con variables entre llaves:
//!
//! ```text
//! {usuario} dice: {mensaje}
//! {usuario} envió {cantidad} {regalo}
//! ```
//!
//! Las variables que entiende son las de [`Variables`], y estan listadas en
//! [`VARIABLES`] para que la interfaz las enseñe sin repetir la lista.
//!
//! Una variable **desconocida se deja tal cual**, con sus llaves: asi el streamer
//! ve el error de escritura cuando escribe `{usuarioo}` en vez de oir una frase a
//! la que le falta un trozo sin saber por que. Es el mismo criterio que siguen los
//! avisos de OBS.
//!
//! Las plantillas **no limpian el texto**: de los espacios de mas, los emojis y
//! los caracteres de control se encarga `filters::limpiar`, que se aplica a la
//! linea ya compuesta. Aqui solo se rellena.

/// Lo que se puede meter en una plantilla.
///
/// Va por referencias y no por `String` porque componer una frase no tiene por que
/// copiar el mensaje entero: se llama una vez por evento leido.
#[derive(Debug, Clone, Default)]
pub struct Variables<'a> {
    /// Nombre de quien lo mando.
    pub usuario: &'a str,
    /// El mensaje del chat.
    pub mensaje: &'a str,
    /// Nombre del regalo.
    pub regalo: &'a str,
    /// Cuantas unidades trae la racha. Vacio cuando es una sola: decir «1 rosa»
    /// suena peor que decir «rosa», y es lo que hacia el codigo de antes.
    pub cantidad: &'a str,
    /// Lo que vale el regalo en diamantes, si el evento lo trae.
    pub diamantes: &'a str,
}

impl<'a> Variables<'a> {
    /// El valor de una variable por su nombre, o `None` si no existe.
    fn valor(&self, nombre: &str) -> Option<&'a str> {
        match nombre {
            "usuario" => Some(self.usuario),
            "mensaje" => Some(self.mensaje),
            "regalo" => Some(self.regalo),
            "cantidad" => Some(self.cantidad),
            "diamantes" => Some(self.diamantes),
            _ => None,
        }
    }
}

/// Los nombres que entiende una plantilla, en el orden en que se enseñan.
///
/// Es la unica lista: la interfaz la pinta desde aqui y `Variables::valor` la
/// implementa. Si se añade una variable, se añade en los dos sitios y el test de
/// coherencia avisa si se olvida uno.
pub const VARIABLES: [&str; 5] = ["usuario", "mensaje", "regalo", "cantidad", "diamantes"];

/// Por defecto para un mensaje de chat: quien lo dice, el verbo y el mensaje.
pub const CHAT_POR_DEFECTO: &str = "{usuario} dice: {mensaje}";

/// Solo el mensaje, sin decir quien lo escribio.
///
/// Es lo que se pone cuando el streamer apaga el nombre: antes era un interruptor
/// de si/no y ahora es esta plantilla, que ademas deja cambiar el verbo.
pub const CHAT_SOLO_MENSAJE: &str = "{mensaje}";

/// Por defecto para un regalo que cierra su racha.
pub const REGALO_POR_DEFECTO: &str = "{usuario} envió {cantidad} {regalo}";

/// Por defecto para un seguidor nuevo.
pub const FOLLOW_POR_DEFECTO: &str = "{usuario} te sigue";

/// Un regalo ya resuelto en variables: el nombre con su respaldo, la cantidad y
/// lo que vale.
///
/// Es logica **pura** y vive aqui, no en el gestor, por dos razones: se prueba sin
/// montar medio motor, y el gestor se queda solo con «coge el evento y llama a
/// `componer`».
///
/// Los dos textos calculados se guardan porque no existen en el evento tal cual:
/// el respaldo de un regalo sin nombre y la cantidad, que se deja **vacia** cuando
/// es una sola unidad —«1 rosa» suena peor que «rosa», y es lo que hacia el codigo
/// de antes—.
#[derive(Debug, Clone)]
pub struct RegaloResuelto<'a> {
    pub usuario: &'a str,
    pub regalo: std::borrow::Cow<'a, str>,
    pub cantidad: String,
    pub diamantes: String,
}

impl<'a> RegaloResuelto<'a> {
    /// Arma las variables de un regalo del evento.
    pub fn nuevo(usuario: &'a str, gift: &'a crate::core::event::GiftInfo) -> Self {
        let nombre = gift.name.trim();
        Self {
            usuario: usuario.trim(),
            regalo: if nombre.is_empty() {
                std::borrow::Cow::Borrowed("un regalo")
            } else {
                std::borrow::Cow::Borrowed(nombre)
            },
            cantidad: match gift.units() {
                0 | 1 => String::new(),
                unidades => unidades.to_string(),
            },
            diamantes: gift.diamonds().to_string(),
        }
    }

    /// Y las convierte en lo que come `componer`.
    pub fn variables(&self) -> Variables<'_> {
        Variables {
            usuario: self.usuario,
            regalo: &self.regalo,
            cantidad: &self.cantidad,
            diamantes: &self.diamantes,
            mensaje: "",
        }
    }
}

/// Rellena una plantilla con sus variables.
///
/// Recorre el texto una vez y va copiando: lo que no es una variable sale tal
/// cual, incluidos los acentos y los emojis (que quita despues `limpiar`).
pub fn componer(plantilla: &str, vars: &Variables) -> String {
    let mut out = String::with_capacity(plantilla.len() + 32);
    let mut i = 0;
    while i < plantilla.len() {
        let resto = &plantilla[i..];
        if !resto.starts_with('{') {
            // Se avanza un **caracter**, no un byte: el texto lleva acentos y
            // cortar por bytes partiria una letra en dos.
            let caracter = resto.chars().next().expect("resto no vacio");
            out.push(caracter);
            i += caracter.len_utf8();
            continue;
        }
        match resto[1..].find('}') {
            Some(rel) => {
                let fin = i + 1 + rel;
                let nombre = &plantilla[i + 1..fin];
                match vars.valor(nombre) {
                    Some(valor) => out.push_str(valor),
                    // Desconocida: se deja con sus llaves, para que se vea.
                    None => {
                        out.push('{');
                        out.push_str(nombre);
                        out.push('}');
                    }
                }
                i = fin + 1;
            }
            // Una llave sin cerrar es texto normal: no se come el resto.
            None => {
                out.push('{');
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>() -> Variables<'a> {
        Variables {
            usuario: "Carlos",
            mensaje: "hola a todos",
            regalo: "Rosa",
            cantidad: "5",
            diamantes: "50",
        }
    }

    #[test]
    fn rellena_las_variables_conocidas() {
        assert_eq!(
            componer(CHAT_POR_DEFECTO, &vars()),
            "Carlos dice: hola a todos"
        );
        assert_eq!(componer(REGALO_POR_DEFECTO, &vars()), "Carlos envió 5 Rosa");
        assert_eq!(componer(FOLLOW_POR_DEFECTO, &vars()), "Carlos te sigue");
        assert_eq!(
            componer(
                "{usuario} mandó {cantidad} {regalo} ({diamantes} diamantes)",
                &vars()
            ),
            "Carlos mandó 5 Rosa (50 diamantes)"
        );
    }

    /// La plantilla que deja el chat sin el nombre: es lo que sustituye al
    /// interruptor «decir quien lo escribio».
    #[test]
    fn la_plantilla_de_solo_mensaje_no_dice_el_nombre() {
        assert_eq!(componer(CHAT_SOLO_MENSAJE, &vars()), "hola a todos");
        assert_eq!(
            componer("{usuario}: {mensaje}", &vars()),
            "Carlos: hola a todos"
        );
    }

    #[test]
    fn una_variable_desconocida_se_queda_visible() {
        assert_eq!(
            componer("{usuarioo} dice: {mensaje}", &vars()),
            "{usuarioo} dice: hola a todos"
        );
    }

    #[test]
    fn una_llave_sin_cerrar_no_se_come_el_texto() {
        assert_eq!(componer("hola {usuario", &vars()), "hola {usuario");
        assert_eq!(componer("{", &vars()), "{");
        assert_eq!(componer("}{", &vars()), "}{");
    }

    #[test]
    fn una_variable_vacia_deja_el_hueco_y_limpiar_lo_cierra() {
        let vacio = Variables {
            usuario: "Carlos",
            ..Variables::default()
        };
        // Aqui queda el doble espacio; quien lo cierra es `filters::limpiar`, que
        // se aplica a la linea ya compuesta.
        assert_eq!(componer(REGALO_POR_DEFECTO, &vacio), "Carlos envió  ");
    }

    #[test]
    fn el_texto_sin_variables_sale_igual() {
        assert_eq!(componer("hola a todos", &vars()), "hola a todos");
        assert_eq!(componer("", &vars()), "");
        // Acentos y emojis: la plantilla no los toca.
        assert_eq!(
            componer("dice: {mensaje} 😀", &vars()),
            "dice: hola a todos 😀"
        );
    }

    /// La lista que ve la interfaz y la que implementa `valor` no pueden
    /// separarse: si se añade una variable y se olvida un sitio, esto lo dice.
    #[test]
    fn la_lista_de_variables_es_la_que_se_implementa() {
        for nombre in VARIABLES {
            let plantilla = format!("{{{nombre}}}");
            let relleno = componer(&plantilla, &vars());
            assert_ne!(
                relleno, plantilla,
                "{nombre} esta en la lista pero no se rellena"
            );
        }
        assert_eq!(VARIABLES.len(), 5);
    }

    #[test]
    fn una_racha_dice_la_cantidad_y_un_regalo_suelto_no() {
        use crate::core::event::GiftInfo;

        // Una racha de 5 rosas: el evento que la cierra vale 5 unidades.
        let racha = GiftInfo::new("5655", "Rose", 1, true, 5, true, "g1");
        let resuelto = RegaloResuelto::nuevo("Carlos", &racha);
        assert_eq!(
            componer(REGALO_POR_DEFECTO, &resuelto.variables()),
            "Carlos envió 5 Rose"
        );
        assert_eq!(resuelto.diamantes, "5");

        // Un regalo suelto no lleva cantidad: «1 rosa» suena peor que «rosa».
        let suelto = GiftInfo::new("5655", "Rose", 1, false, 1, false, "0");
        let resuelto = RegaloResuelto::nuevo("Carlos", &suelto);
        assert_eq!(
            componer(REGALO_POR_DEFECTO, &resuelto.variables()),
            "Carlos envió  Rose"
        );

        // Sin nombre de regalo no se deja el hueco: se dice «un regalo».
        let raro = GiftInfo::new("1", "  ", 1, false, 1, false, "0");
        let resuelto = RegaloResuelto::nuevo("Carlos", &raro);
        assert_eq!(
            componer(REGALO_POR_DEFECTO, &resuelto.variables()),
            "Carlos envió  un regalo"
        );
    }
}
