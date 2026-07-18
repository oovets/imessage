//! The application event bus.

use shared::CoreEvent;
use tokio::sync::broadcast;

/// Capacity of the broadcast ring buffer. Consumers that lag beyond this
/// receive `RecvError::Lagged` and are expected to re-sync from the database
/// (which, by the offline-first rule, always holds the truth).
const BUS_CAPACITY: usize = 1024;

/// Cheap-to-clone fan-out bus for [`CoreEvent`]s.
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<CoreEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BUS_CAPACITY);
        Self { tx }
    }

    /// Publish an event. Events describe facts already persisted; publishing
    /// with zero subscribers is normal (e.g. during startup) and not an error.
    pub fn publish(&self, event: CoreEvent) {
        tracing::trace!(?event, "publish");
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CoreEvent> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared::model::SyncState;

    #[tokio::test]
    async fn events_fan_out_to_all_subscribers() {
        let bus = EventBus::new();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        bus.publish(CoreEvent::SyncStateChanged {
            account_id: 1,
            state: SyncState::Connecting,
        });
        for rx in [&mut a, &mut b] {
            let event = rx.recv().await.expect("event");
            assert!(matches!(event, CoreEvent::SyncStateChanged { account_id: 1, .. }));
        }
    }
}
