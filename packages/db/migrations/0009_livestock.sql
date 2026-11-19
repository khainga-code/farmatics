-- ===========================================================================
-- Goats and cattle.
--
-- A batch now says which species it holds. The events do not change: one
-- mortality, transfer, sale, feed and weighing model covers poultry, goats and
-- cattle, so the offline rules stay in one place. Poultry keeps brooding and
-- the vaccination schedule; goats and cattle may be sold from arrival.
-- ===========================================================================

alter table batches
  add column species text not null default 'poultry'
    check (species in ('poultry', 'goat', 'cattle'));

-- The old guard was written for broilers. Cattle weigh an order of magnitude
-- more, so the database limit moves; the API still applies a per-species cap.
alter table batch_weights
  drop constraint batch_weights_average_weight_kg_check;
alter table batch_weights
  add constraint batch_weights_average_weight_kg_check
    check (average_weight_kg > 0 and average_weight_kg <= 2000);
