// Embed a Windows application manifest that requests administrator rights so the
// app (and the sensor sidecar it spawns, which inherits the token) can always
// read CPU/RAM temperatures. This replaces Tauri's default manifest, so the
// standard DPI-awareness / Common-Controls / UTF-8 / long-path entries are kept
// here too. NOTE: requireAdministrator means every launch shows a UAC prompt and
// the plain Run-key autostart can't elevate — elevated autostart uses a
// "highest privileges" scheduled task instead (see src/autostart.rs).
#[cfg(windows)]
const APP_MANIFEST: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="requireAdministrator" uiAccess="false" />
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}" />
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}" />
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}" />
      <supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}" />
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

/// Keys we surface to the app via compile-time `option_env!`. Read from a `.env`
/// file (repo root or `src-tauri/`) so a locally-provided key is baked into the
/// binary for both `tauri dev` and packaged builds — no runtime .env needed.
const ENV_KEYS: &[&str] = &["RAWG_API_KEY", "YOUTUBE_API_KEY", "STEAMGRIDDB_API_KEY"];

fn export_env_from_dotenv() {
    // Later files win, so check src-tauri/.env after the repo-root .env.
    let candidates = ["../.env", ".env"];
    let mut values: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for path in candidates {
        println!("cargo:rerun-if-changed={path}");
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let key = k.trim().to_string();
                let val = v.trim().trim_matches('"').trim_matches('\'').to_string();
                values.insert(key, val);
            }
        }
    }
    for key in ENV_KEYS {
        // An explicit process env var (e.g. CI) overrides the .env file.
        println!("cargo:rerun-if-env-changed={key}");
        let val = std::env::var(key).ok().or_else(|| values.get(*key).cloned());
        if let Some(val) = val.filter(|s| !s.trim().is_empty()) {
            println!("cargo:rustc-env={key}={val}");
        }
    }
}

fn main() {
    export_env_from_dotenv();
    #[cfg(windows)]
    {
        let attrs = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(APP_MANIFEST),
        );
        tauri_build::try_build(attrs).expect("failed to run tauri-build");
    }
    #[cfg(not(windows))]
    {
        tauri_build::build();
    }
}
