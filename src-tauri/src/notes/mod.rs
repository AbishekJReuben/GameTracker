//! Notes: the code shared by the main app and the notes shell.
//!
//! Both processes read and write the same database. It is the source of truth, so
//! neither needs the other to be alive: `bus` only makes changes show up sooner.
//! Nothing here may run on a UI thread (see `docs/NOTES_OVERLAY_PLAN.md`):
//! `EmptyClipboard` alone can wait 5 seconds on another app.

pub mod bus;
pub mod commands;
pub mod os_clipboard;

use crate::db::DbPool;
use std::path::PathBuf;

/// What every notes command needs. Managed by each process that serves them.
#[derive(Clone)]
pub struct NotesCtx {
    pub pool: DbPool,
    pub media_dir: PathBuf,
    pub data_dir: PathBuf,
}
