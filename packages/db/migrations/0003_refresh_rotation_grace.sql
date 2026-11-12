-- A rotated refresh token is kept usable for a short grace window.
--
-- Phones on weak networks lose responses. If the reply carrying the new
-- refresh token never arrives, the old token is all the device has left.
-- Marking the moment of rotation (rather than revoking the row) lets the API
-- accept that old token for a few seconds instead of signing the user out.
alter table sessions add column if not exists rotated_at timestamptz;
