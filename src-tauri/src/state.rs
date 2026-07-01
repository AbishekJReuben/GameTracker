use crate::db::DbPool;
use crate::remote::RemoteShared;
use crate::system::SystemShared;
use crate::tracking::TrackingShared;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub pool: DbPool,
    pub shared: Arc<TrackingShared>,
    pub sys: Arc<SystemShared>,
    pub remote: Arc<RemoteShared>,
    pub data_dir: PathBuf,
    pub media_dir: PathBuf,
    pub db_path: PathBuf,
}
