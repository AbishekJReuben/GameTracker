//! Runs the floating Notes process without the installer's admin manifest, for
//! testing beside the installed app. Point it at a copy of the data, because a new
//! build migrates whatever database it opens:
//!
//!   GT_NOTES_TEST_DATA=<folder> cargo run --example notes_shell -- --notes-shell
//!
//! Debug builds load the page from the Vite dev server.

fn main() {
    if std::env::var_os("GT_NOTES_TEST_DATA").is_none() {
        eprintln!("Set GT_NOTES_TEST_DATA to a test folder. Without it this would open your real notes.");
        std::process::exit(2);
    }
    gametracker_lib::run();
}
