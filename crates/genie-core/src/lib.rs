//! Genie domain core.
//!
//! The Rust port of the TypeScript tracker (`src/tracker`) plus the event
//! journal the platform is built on. See `docs/platform/backend.md` for the
//! migration plan.

pub mod db;
pub mod error;
pub mod events;
pub mod model;
pub mod tracker;

pub use error::{GenieError, Result};
pub use events::Event;
pub use model::*;
pub use tracker::{
    ArtifactContent, ArtifactInput, ArtifactSource, CreateInput, EpicContext, ListFilter, Meta, StatusOptions, Tracker, UpdateInput,
};
