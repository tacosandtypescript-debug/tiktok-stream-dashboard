fn main() {
    // En CI o al compilar solo el nucleo (--no-default-features) no hay shell
    // de escritorio que construir, asi que no se genera el contexto de Tauri.
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
