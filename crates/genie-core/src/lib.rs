//! Genie domain core.
//!
//! The Rust port of the TypeScript tracker (`src/tracker`) plus the event
//! journal the platform is built on. See `docs/platform/backend.md` for the
//! migration plan.

pub mod automation;
pub mod db;
pub mod error;
pub mod events;
pub mod inbox;
pub mod model;
pub mod server_db;
pub mod team;
pub mod tracker;
pub mod vault;
pub mod work;

pub use error::{GenieError, Result};
pub use events::Event;
pub use model::*;
pub use tracker::{
    ArtifactContent, ArtifactInput, ArtifactSource, CreateInput, EpicContext, ListFilter, Meta, StatusOptions, Tracker, UpdateInput,
};
