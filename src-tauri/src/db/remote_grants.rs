//! Remote grant persistence shared by the desktop and remote-host processes.
//! Readers never write snapshots back. Writers lock before reading and commit
//! both settings together, so a stale writer cannot undo another revocation.
use crate::error::{AppError, AppResult};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

const TRUSTED: &str = "remote_trusted_devices";
const TEMPORARY: &str = "remote_temp_grants";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrustedDevice {
    pub id: String,
    pub name: String,
    pub added_utc: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TempGrant {
    pub id: String,
    pub name: String,
    pub expires_utc: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGrants {
    pub trusted: Vec<TrustedDevice>,
    pub temporary: Vec<TempGrant>,
}

fn read_list<T: DeserializeOwned>(conn: &Connection, key: &str) -> AppResult<Vec<T>> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()?;
    match stored {
        None => Ok(Vec::new()),
        // Do not replace damaged recovery data with an empty list or expose its
        // contents in a deserializer error returned to a remote caller.
        Some(raw) => serde_json::from_str(&raw)
            .map_err(|_| AppError::msg("Stored remote grants are invalid; access was not granted")),
    }
}

fn read_snapshot(conn: &Connection, now: DateTime<Utc>) -> AppResult<RemoteGrants> {
    let trusted = read_list(conn, TRUSTED)?;
    let temporary: Vec<TempGrant> = read_list(conn, TEMPORARY)?;
    Ok(RemoteGrants {
        trusted,
        temporary: temporary.into_iter().filter(|g| {
            DateTime::parse_from_rfc3339(&g.expires_utc)
                .map(|t| t.with_timezone(&Utc) > now).unwrap_or(false)
        }).collect(),
    })
}

fn write_list<T: Serialize>(conn: &Connection, key: &str, rows: &T) -> AppResult<()> {
    let value = serde_json::to_string(rows)?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

fn valid_device(id: &str) -> AppResult<()> {
    if id.trim().is_empty() || id.len() > 256 {
        return Err(AppError::msg("Invalid remote device identifier"));
    }
    Ok(())
}

/// One consistent read snapshot, including on the host's frequent lease checks.
pub fn list(conn: &mut Connection) -> AppResult<RemoteGrants> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
    let grants = read_snapshot(&tx, Utc::now())?;
    tx.commit()?;
    Ok(grants)
}

fn mutate(
    conn: &mut Connection,
    change: impl FnOnce(&mut RemoteGrants) -> AppResult<bool>,
) -> AppResult<RemoteGrants> {
    // A process-local mutex cannot serialize the separate desktop and host.
    // IMMEDIATE obtains SQLite's writer reservation before reading either list.
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut grants = read_snapshot(&tx, Utc::now())?;
    if change(&mut grants)? {
        write_list(&tx, TRUSTED, &grants.trusted)?;
        write_list(&tx, TEMPORARY, &grants.temporary)?;
    }
    tx.commit()?;
    Ok(grants)
}

pub fn grant(
    conn: &mut Connection, device_id: &str, name: &str,
    kind: &str, duration_secs: Option<i64>,
) -> AppResult<RemoteGrants> {
    valid_device(device_id)?;
    if !matches!(kind, "permanent" | "temporary") {
        return Err(AppError::msg("Invalid remote grant type"));
    }
    mutate(conn, |grants| {
        let now = Utc::now();
        if kind == "permanent" {
            grants.trusted.retain(|g| g.id != device_id);
            grants.trusted.push(TrustedDevice {id:device_id.into(), name:name.into(), added_utc:now.to_rfc3339()});
            grants.temporary.retain(|g| g.id != device_id);
        } else {
            let seconds = duration_secs.unwrap_or(3600).clamp(60, 60 * 60 * 24 * 30);
            grants.temporary.retain(|g| g.id != device_id);
            grants.temporary.push(TempGrant {id:device_id.into(), name:name.into(), expires_utc:(now + chrono::Duration::seconds(seconds)).to_rfc3339()});
            // Preserve existing behavior: a timed grant does not silently revoke
            // an existing permanent grant. Explicit revocation removes both.
        }
        Ok(true)
    })
}

pub fn revoke(conn: &mut Connection, device_id: &str) -> AppResult<RemoteGrants> {
    valid_device(device_id)?;
    mutate(conn, |grants| {
        let before = (grants.trusted.len(), grants.temporary.len());
        grants.trusted.retain(|g| g.id != device_id);
        grants.temporary.retain(|g| g.id != device_id);
        Ok(before != (grants.trusted.len(), grants.temporary.len()))
    })
}

/// Called only after the existing shared-secret check. Return success only after
/// persistence commits; a correct secret must not conceal a storage failure.
pub fn remember_permanent(conn: &mut Connection, device_id: &str, name: &str) -> AppResult<()> {
    valid_device(device_id)?;
    mutate(conn, |grants| {
        if grants.trusted.iter().any(|g| g.id == device_id) { return Ok(false); }
        grants.trusted.push(TrustedDevice {id:device_id.into(), name:name.into(), added_utc:Utc::now().to_rfc3339()});
        grants.temporary.retain(|g| g.id != device_id);
        Ok(true)
    })?;
    Ok(())
}

pub fn access_level(conn: &mut Connection, device_id: &str) -> AppResult<&'static str> {
    valid_device(device_id)?;
    let grants = list(conn)?;
    if grants.trusted.iter().any(|g| g.id == device_id) { return Ok("permanent"); }
    if grants.temporary.iter().any(|g| g.id == device_id) { return Ok("temporary"); }
    Ok("none")
}
