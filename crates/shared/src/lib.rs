//! # shared
//!
//! Foundation crate for the Telegram client workspace.
//!
//! Contains everything that more than one crate needs to agree on:
//!
//! * [`model`] — the domain model (accounts, chats, messages, media). These
//!   types are what the UI renders and what the database persists. They are
//!   deliberately independent of any Telegram wire format.
//! * [`event`] — [`event::CoreEvent`], the single event type flowing over the
//!   application event bus.
//! * [`config`] — typed, layered TOML configuration.
//!
//! This crate must stay light: no async runtime, no networking, no database
//! dependencies. Everything here is plain data.

pub mod config;
pub mod event;
pub mod model;
pub mod secrets;

pub use config::AppConfig;
pub use event::CoreEvent;
