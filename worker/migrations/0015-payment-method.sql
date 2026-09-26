-- How each order was paid, all of it simulated: the method (card, FPX online
-- banking or an e-wallet), the channel (a card brand, or a bank or wallet name
-- from the allow-list in ../src/lib/payment.ts) and a reference the server
-- mints, such as SIM-FPX-7K2M9Q. No card number, expiry or CVC is ever stored:
-- the browser keeps them.
--
-- Additive only. Every order already stored becomes a card payment with no
-- channel or reference, which is what it was. Safe ahead of the worker that
-- writes the columns (the ordering rule in README.md): the old nexus-api names
-- none of them, so its inserts take the defaults. The ALTERs make this file
-- run once only.
--
--   cd worker
--   npx wrangler d1 execute nexus-orders-staging --remote --file=migrations/0015-payment-method.sql

ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'card'
  CHECK (payment_method IN ('card','fpx','ewallet'));
ALTER TABLE orders ADD COLUMN payment_channel TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN payment_ref TEXT NOT NULL DEFAULT '';
