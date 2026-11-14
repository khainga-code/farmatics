-- ===========================================================================
-- Health monitoring.
--
-- The broiler schedule is fixed, so this phase adds no tables. A death gains a
-- cause category so the owner can see what is actually killing birds, and the
-- date index serves the first-week and last-seven-days windows the health
-- screen reads.
--
-- Older rows keep a null category and are shown as "Uncategorised"; nothing is
-- rewritten or guessed.
-- ===========================================================================

alter table mortality_events
  add column cause_category text
    check (cause_category is null or cause_category in (
      'disease', 'heat', 'cold', 'predator', 'injury', 'culling', 'unknown'
    ));

create index mortality_events_farm_recorded_idx
  on mortality_events (farm_id, recorded_at);
